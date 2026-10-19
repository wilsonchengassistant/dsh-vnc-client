/**
 * The RFB protocol session.
 *
 * Owns everything above the byte pump: the version and security handshake, the
 * framebuffer and cursor surfaces, the message loop, and the input events that
 * travel back to the server. It knows nothing about the WebSocket it travels
 * over, and nothing about React — both are injected — so the same class is
 * what the browser half drives and what the tests drive over a plain byte
 * stream.
 *
 * Both the handshake and the message loop are written as resumable phases
 * rather than as "parse the whole message at once". A WebSocket message
 * boundary says nothing about an RFB message boundary, so the loop consumes
 * whatever is buffered, stops when the next field is not fully present, and
 * resumes when more arrives.
 */

import {
	BUTTON1_MASK,
	BUTTON2_MASK,
	BUTTON3_MASK,
	BUTTON4_MASK,
	BUTTON5_MASK,
	COORD_MAX,
	ENCODING_COPY_RECT,
	ENCODING_HEXTILE,
	ENCODING_RAW,
	ENCODING_TIGHT,
	ENCODING_ZRLE,
	MSG_BELL,
	MSG_FRAMEBUFFER_UPDATE,
	MSG_SERVER_CUT_TEXT,
	MSG_SET_COLOUR_MAP,
	PSEUDO_CURSOR,
	PSEUDO_DESKTOP_SIZE,
	PSEUDO_EXT_DESKTOP_SIZE,
	PSEUDO_LAST_RECT,
	RFB_VERSION,
	SECURITY_INVALID,
	SECURITY_NONE,
	SECURITY_VNC_AUTH
} from "./constants.js";
import { Reader, RfbTruncated } from "./reader.js";
import { CursorSurface, REQUESTED_FORMAT, Surface } from "./display.js";
import { vncAuthResponse } from "./des.js";
import {
	DecoderState,
	decodeCopyRect,
	decodeCursor,
	decodeHextile,
	decodeRaw,
	decodeTight,
	decodeZrle
} from "./encodings.js";

/** How long to wait for the whole handshake before giving up. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Encodings requested, best first.
 *
 * JPEG (21) is deliberately absent: a server may only JPEG-compress a Tight
 * rectangle if the client advertised it, so leaving it out keeps every
 * rectangle on a path this client can decode without shipping a JPEG decoder.
 */
const REQUESTED_ENCODINGS = [
	PSEUDO_CURSOR,
	PSEUDO_DESKTOP_SIZE,
	PSEUDO_EXT_DESKTOP_SIZE,
	PSEUDO_LAST_RECT,
	ENCODING_RAW,
	ENCODING_COPY_RECT,
	ENCODING_HEXTILE,
	ENCODING_TIGHT,
	ENCODING_ZRLE
];

/** Handshake phases, in order. */
const PHASE_VERSION = "version";
const PHASE_SECURITY_TYPES = "security-types";
const PHASE_CHALLENGE = "challenge";
const PHASE_SECURITY_RESULT = "security-result";
const PHASE_CLIENT_INIT = "client-init";
const PHASE_SERVER_INIT = "server-init";
const PHASE_READY = "ready";
const PHASE_ERROR = "error";

/** Message-loop phases. */
const MSG_IDLE = "idle";
const MSG_RECTANGLES = "rectangles";
const MSG_RECTANGLE = "rectangle";
const MSG_COLOUR_MAP = "colour-map";
const MSG_CUT_TEXT = "cut-text";

/** X11 keysyms for keys whose character is not the keysym. */
const SPECIAL_KEYSYMS = {
	Backspace: 0xff08,
	Tab: 0xff09,
	Enter: 0xff0d,
	Shift: 0xffe1,
	Ctrl: 0xffe3,
	Alt: 0xffe9,
	Meta: 0xffeb,
	Escape: 0xff1b,
	ArrowLeft: 0xff51,
	ArrowUp: 0xff52,
	ArrowRight: 0xff53,
	ArrowDown: 0xff54,
	Home: 0xff50,
	End: 0xff57,
	PageUp: 0xff55,
	PageDown: 0xff56,
	Insert: 0xff63,
	Delete: 0xffff,
	F1: 0xffbe,
	F2: 0xffbf,
	F3: 0xffc0,
	F4: 0xffc1,
	F5: 0xffc2,
	F6: 0xffc3,
	F7: 0xffc4,
	F8: 0xffc5,
	F9: 0xffc6,
	F10: 0xffc7,
	F11: 0xffc8,
	F12: 0xffc9,
	CapsLock: 0xffe5,
	NumLock: 0xff7f,
	ScrollLock: 0xff14,
	Pause: 0xff13,
	PrintScreen: 0xff61
};

/** One RFB session over a byte transport. */
export class RfbClient {
	#transport;
	#surface;
	#cursor;
	#decoder = new DecoderState();
	#pending = new Uint8Array(0);
	#queue = [];
	#busy = false;
	#disposed = false;
	#handshakeTimer = null;

	#phase = PHASE_VERSION;
	#messagePhase = MSG_IDLE;

	/** The rectangle currently being decoded, while {@link MSG_RECTANGLE}. */
	#rect = null;
	/** Rectangles still to come in the update being decoded. */
	#rectanglesLeft = 0;
	/** Bytes the update being decoded still occupies at its head. */
	#updateHeaderBytes = 4;

	#version = null;
	#security = null;
	#password = "";
	#width = 0;
	#height = 0;
	#name = "";
	#shared = true;
	#pointerX = 0;
	#pointerY = 0;

	/**
	 * @param {{send: (bytes: Uint8Array) => void, close: () => void}} transport - Byte transport.
	 * @param {HTMLCanvasElement} canvas - Canvas to paint the framebuffer into.
	 * @param {HTMLCanvasElement} cursorCanvas - Canvas to paint the cursor into.
	 * @param {object} handlers - Callbacks: onStatus, onFrame, onResize, onBell, onClipboard.
	 */
	constructor(transport, canvas, cursorCanvas, handlers = {}) {
		this.#transport = transport;
		this.#surface = new Surface(canvas);
		this.#cursor = new CursorSurface(cursorCanvas);
		this.handlers = handlers;
		transport.onData = (bytes) => this.#receive(bytes);
		transport.onClose = () => {
			if (this.#disposed) return;
			this.#disposed = true;
			this.handlers.onStatus?.({ kind: "closed" });
		};
	}

	/** Event callbacks, set by the UI layer. */
	handlers;

	/** Where the session currently is. */
	get phase() {
		return this.#phase;
	}

	/** Framebuffer width. */
	get width() {
		return this.#width;
	}

	/** Framebuffer height. */
	get height() {
		return this.#height;
	}

	/** The server's desktop name. */
	get name() {
		return this.#name;
	}

	/** The cursor surface, for drawing the server's cursor shape. */
	get cursorSurface() {
		return this.#cursor;
	}

	/** The framebuffer's RGBA bytes, for the UI layer and for tests. */
	get framebuffer() {
		return this.#surface.data;
	}

	/**
	 * Begin the handshake.
	 *
	 * Deliberately sends nothing: RFB is server-initiated, so the greeting is
	 * what the client waits for. A client that opens with its own version makes
	 * a conforming server read that greeting as the security choice.
	 *
	 * @param {string} password - The server's VNC password, if it has one.
	 * @returns {void}
	 */
	connect(password = "") {
		this.#password = password;
		this.#phase = PHASE_VERSION;
		this.#handshakeTimer = setTimeout(() => {
			this.fail("the server did not complete the RFB handshake in time");
		}, HANDSHAKE_TIMEOUT_MS);
	}

	/**
	 * Queue received bytes and drive the parse loop.
	 *
	 * Input is serialized through an explicit queue rather than by awaiting
	 * inside the loop: Tight and ZRLE are asynchronous decoders, and letting a
	 * second message start while one is mid-rectangle would interleave two
	 * parses over one buffer.
	 *
	 * @param {Uint8Array} bytes - Freshly received bytes.
	 * @returns {void}
	 */
	#receive(bytes) {
		if (this.#disposed) return;
		this.#queue.push(bytes);
		if (this.#busy) return;
		this.#busy = true;
		this.#pump()
			.then(() => {
				this.#busy = false;
			})
			.catch((error) => {
				this.#busy = false;
				this.fail(error instanceof Error ? error.message : String(error));
			});
	}

	/** Parse queued input until nothing more can be consumed. */
	async #pump() {
		while (this.#queue.length > 0) {
			const chunk = this.#queue.shift();
			this.#pending =
				this.#pending.length === 0 ? chunk : concat(this.#pending, chunk);
			await this.#step();
		}
	}

	/**
	 * Advance the protocol by whatever the buffer currently allows.
	 *
	 * @returns {Promise<void>} resolution once the next field is incomplete.
	 */
	async #step() {
		if (this.#phase !== PHASE_READY) {
			// The handshake can pass through several phases without waiting for
			// a single extra byte — choosing a security type leads straight into
			// ClientInit, for instance — so it is pumped until it stalls rather
			// than advanced one phase per input event.
			for (;;) {
				const before = this.#phase;
				this.#handshakeStep();
				if (this.#phase === before) return;
			}
		}
		for (;;) {
			if (this.#messagePhase === MSG_RECTANGLE) {
				// A rectangle whose payload is only partly buffered has to be
				// decoded in one go: a partially decoded Tight or ZRLE rectangle
				// has already advanced its zlib stream and cannot be replayed.
				if (!(await this.#rectangleStep())) return;
				continue;
			}
			if (this.#messageStep() === false) return;
		}
	}

	/** Advance the handshake by whatever the buffer currently allows. */
	#handshakeStep() {
		const reader = new Reader(this.#pending);
		switch (this.#phase) {
			case PHASE_VERSION: {
				if (this.#pending.length < 12) return;
				const banner = latin1(this.#pending.subarray(0, 12));
				if (!banner.startsWith("RFB ")) {
					throw new Error(`the server did not open with an RFB greeting: ${JSON.stringify(banner)}`);
				}
				const major = Number.parseInt(banner.slice(4, 7), 10);
				const minor = Number.parseInt(banner.slice(8, 11), 10);
				if (!Number.isFinite(major) || major < 3 || (major === 3 && minor < 3)) {
					throw new Error(`this client speaks RFB 3.3 and later; the server offered ${major}.${minor}`);
				}
				this.#version = { major, minor };
				this.#pending = this.#pending.subarray(12);
				this.#send(new TextEncoder().encode(`RFB 003.00${Math.min(minor, 8)}\n`));
				this.handlers.onStatus?.({ kind: "version", version: `${major}.${minor}` });
				this.#phase = major === 3 && minor < 7 ? PHASE_SECURITY_TYPES : PHASE_SECURITY_TYPES;
				return;
			}
			case PHASE_SECURITY_TYPES: {
				if (this.#version.major === 3 && this.#version.minor < 7) {
					if (this.#pending.length < 4) return;
					this.#chooseSecurity(reader.u32());
					this.#pending = this.#pending.subarray(4);
				} else {
					if (this.#pending.length < 1) return;
					const count = this.#pending[0];
					if (count === 0) {
						// A zero count is followed by a reason string.
						const reason = new Reader(this.#pending, 1);
						throw new Error(`the server refused the connection: ${latin1(reason.bytes(reason.remaining))}`);
					}
					if (this.#pending.length < 1 + count) return;
					const offered = Array.from(this.#pending.subarray(1, 1 + count));
					this.#pending = this.#pending.subarray(1 + count);
					this.#chooseSecurity(offered.includes(SECURITY_VNC_AUTH) ? SECURITY_VNC_AUTH : SECURITY_NONE);
				}
				// VNC Authentication challenges before the result is reported;
				// "None" has nothing to do, so it goes straight to the result.
				this.#phase = this.#security === SECURITY_VNC_AUTH ? PHASE_CHALLENGE : PHASE_SECURITY_RESULT;
				return;
			}
			case PHASE_CHALLENGE: {
				if (this.#pending.length < 16) return;
				const challenge = this.#pending.slice(0, 16);
				this.#pending = this.#pending.subarray(16);
				this.#send(vncAuthResponse(challenge, this.#password));
				this.#password = "";
				// RFB 3.3 has no SecurityResult; the protocol moves on directly.
				this.#phase =
					this.#version.major === 3 && this.#version.minor < 7 ? PHASE_CLIENT_INIT : PHASE_SECURITY_RESULT;
				return;
			}
			case PHASE_SECURITY_RESULT: {
				if (this.#pending.length < 4) return;
				const result = new Reader(this.#pending).u32();
				this.#pending = this.#pending.subarray(4);
				if (result !== 0) {
					let reason = "";
					if (this.#pending.length > 0) {
						reason = latin1(this.#pending);
						this.#pending = new Uint8Array(0);
					}
					throw new Error(
						result === 2 ? "the server rejected this password" : `the server refused the connection: ${reason}`
					);
				}
				this.#phase = PHASE_CLIENT_INIT;
				return;
			}
			case PHASE_CLIENT_INIT: {
				this.#send(Uint8Array.of(this.#shared ? 1 : 0));
				this.#phase = PHASE_SERVER_INIT;
				return;
			}
			case PHASE_SERVER_INIT: {
				if (this.#pending.length < 24) return;
				const server = new Reader(this.#pending);
				this.#width = server.u16();
				this.#height = server.u16();
				server.skip(16);
				const nameLength = server.u32();
				if (this.#pending.length < 24 + nameLength) {
					this.#width = 0;
					this.#height = 0;
					return;
				}
				this.#name = latin1(server.bytes(nameLength));
				this.#pending = this.#pending.subarray(24 + nameLength);
				clearTimeout(this.#handshakeTimer);
				this.#phase = PHASE_READY;
				this.#surface.resize(this.#width, this.#height);
				this.#send(this.#setPixelFormatMessage());
				this.#send(this.#setEncodingsMessage());
				this.requestFrame(true);
				this.handlers.onStatus?.({
					kind: "connected",
					width: this.#width,
					height: this.#height,
					name: this.#name
				});
				return;
			}
			default:
				return;
		}
	}

	/**
	 * Accept or refuse a security type.
	 *
	 * @param {number} type - The type to use.
	 * @returns {void}
	 */
	#chooseSecurity(type) {
		if (type === SECURITY_INVALID) throw new Error("the server offered no security type this client accepts");
		if (type !== SECURITY_NONE && type !== SECURITY_VNC_AUTH) {
			throw new Error(`this client speaks security types None and VNC Authentication, not ${type}`);
		}
		this.#security = type;
		this.#send(Uint8Array.of(type));
		this.handlers.onStatus?.({ kind: "security", security: type === SECURITY_NONE ? "none" : "vnc" });
	}

	/** @returns {Uint8Array} a SetPixelFormat message for the negotiated format. */
	#setPixelFormatMessage() {
		const message = new Uint8Array(20);
		const view = new DataView(message.buffer);
		view.setUint8(0, 0);
		view.setUint8(4, REQUESTED_FORMAT.bitsPerPixel);
		view.setUint8(5, REQUESTED_FORMAT.depth);
		view.setUint8(6, REQUESTED_FORMAT.bigEndian ? 1 : 0);
		view.setUint8(7, REQUESTED_FORMAT.trueColour ? 1 : 0);
		view.setUint16(8, REQUESTED_FORMAT.redMax);
		view.setUint16(10, REQUESTED_FORMAT.greenMax);
		view.setUint16(12, REQUESTED_FORMAT.blueMax);
		view.setUint8(14, REQUESTED_FORMAT.redShift);
		view.setUint8(15, REQUESTED_FORMAT.greenShift);
		view.setUint8(16, REQUESTED_FORMAT.blueShift);
		return message;
	}

	/** @returns {Uint8Array} a SetEncodings message for what this client decodes. */
	#setEncodingsMessage() {
		const message = new Uint8Array(4 + REQUESTED_ENCODINGS.length * 4);
		const view = new DataView(message.buffer);
		view.setUint8(0, 2);
		view.setUint16(2, REQUESTED_ENCODINGS.length);
		REQUESTED_ENCODINGS.forEach((encoding, index) => {
			view.setInt32(4 + index * 4, encoding);
		});
		return message;
	}

	/**
	 * Ask the server for pixels.
	 *
	 * @param {boolean} full - Whether to ask for the whole framebuffer.
	 * @returns {void}
	 */
	requestFrame(full = false) {
		const message = new Uint8Array(10);
		const view = new DataView(message.buffer);
		view.setUint8(0, 3);
		view.setUint8(1, full ? 0 : 1);
		view.setUint16(2, 0);
		view.setUint16(4, 0);
		view.setUint16(6, this.#width);
		view.setUint16(8, this.#height);
		this.#send(message);
	}

	/**
	 * Advance the message loop by whatever the buffer currently allows.
	 *
	 * @returns {boolean} whether progress was made.
	 */
	#messageStep() {
		switch (this.#messagePhase) {
			case MSG_IDLE: {
				if (this.#pending.length < 1) return false;
				const type = this.#pending[0];
				if (type === MSG_FRAMEBUFFER_UPDATE) {
					if (this.#pending.length < 4) return false;
					const header = new Reader(this.#pending);
					header.u8();
					header.skip(1);
					this.#rectanglesLeft = header.u16();
					this.#pending = this.#pending.subarray(4);
					this.#messagePhase = MSG_RECTANGLES;
					return true;
				}
				if (type === MSG_SET_COLOUR_MAP) {
					if (this.#pending.length < 6) return false;
					const header = new Reader(this.#pending);
					header.u8();
					header.skip(1);
					const entries = header.u16();
					const size = 6 + entries * 6;
					if (this.#pending.length < size) return false;
					this.#pending = this.#pending.subarray(size);
					return true;
				}
				if (type === MSG_BELL) {
					this.#pending = this.#pending.subarray(1);
					this.handlers.onBell?.();
					return true;
				}
				if (type === MSG_SERVER_CUT_TEXT) {
					this.#messagePhase = MSG_CUT_TEXT;
					return true;
				}
				throw new Error(`the server sent an unknown message type ${type}`);
			}
			case MSG_RECTANGLES: {
				if (this.#rectanglesLeft === 0) {
					this.#messagePhase = MSG_IDLE;
					this.handlers.onFrame?.();
					this.requestFrame(false);
					return true;
				}
				if (this.#pending.length < 12) return false;
				const header = new Reader(this.#pending);
				this.#rect = {
					x: header.u16(),
					y: header.u16(),
					width: header.u16(),
					height: header.u16(),
					encoding: header.i32()
				};
				this.#pending = this.#pending.subarray(12);
				this.#rectanglesLeft--;
				this.#messagePhase = MSG_RECTANGLE;
				return true;
			}
			case MSG_CUT_TEXT: {
				if (this.#pending.length < 8) return false;
				const header = new Reader(this.#pending);
				header.u8();
				header.skip(3);
				const length = header.u32();
				if (this.#pending.length < 8 + length) return false;
				const text = this.#pending.slice(8, 8 + length);
				this.#pending = this.#pending.subarray(8 + length);
				this.#messagePhase = MSG_IDLE;
				// RFB carries cut text as Latin-1; re-decode so the browser can
				// put it in a field.
				let out = "";
				for (const byte of text) out += String.fromCharCode(byte);
				this.handlers.onClipboard?.(out);
				return true;
			}
			default:
				return false;
		}
	}

	/**
	 * Decode the rectangle whose header has been read.
	 *
	 * @returns {Promise<boolean>} whether the rectangle is fully decoded.
	 */
	async #rectangleStep() {
		const rect = this.#rect;
		if (rect.encoding === PSEUDO_LAST_RECT) {
			this.#rectanglesLeft = 0;
			this.#messagePhase = MSG_RECTANGLES;
			return true;
		}
		if (rect.encoding === PSEUDO_CURSOR) {
			// Cursor pixels, then a row-padded bitmask of one byte per eight columns.
			const cursorBytes = rect.width * rect.height * 3 + ((rect.width + 7) >> 3) * rect.height;
			if (this.#pending.length < cursorBytes) return false;
			decodeCursor(new Reader(this.#pending), rect, this.#cursor);
			this.#pending = this.#pending.subarray(cursorBytes);
			this.#messagePhase = MSG_RECTANGLES;
			this.handlers.onFrame?.();
			return true;
		}
		if (rect.encoding === PSEUDO_DESKTOP_SIZE || rect.encoding === PSEUDO_EXT_DESKTOP_SIZE) {
			this.#applyDesktopSize(rect);
			this.#messagePhase = MSG_RECTANGLES;
			return true;
		}

		let painted = false;
		const reader = new Reader(this.#pending);
		try {
			switch (rect.encoding) {
				case ENCODING_RAW:
					decodeRaw(reader, rect, this.#surface);
					painted = true;
					break;
				case ENCODING_COPY_RECT:
					if (this.#pending.length < 4) return false;
					decodeCopyRect(reader, rect, this.#surface);
					painted = true;
					break;
				case ENCODING_HEXTILE:
					decodeHextile(reader, rect, this.#surface);
					painted = true;
					break;
				case ENCODING_TIGHT:
					if (!(await decodeTight(reader, rect, this.#surface, this.#decoder))) return false;
					painted = true;
					break;
				case ENCODING_ZRLE:
					if (!(await decodeZrle(reader, rect, this.#surface, this.#decoder))) return false;
					painted = true;
					break;
				default:
					throw new Error(`the server sent rectangle encoding ${rect.encoding}, which this client did not request`);
			}
		} catch (error) {
			if (error instanceof RfbTruncated) return false;
			throw error;
		}

		this.#pending = this.#pending.subarray(reader.offset);
		if (painted && rect.x + rect.width <= this.#width && rect.y + rect.height <= this.#height) {
			this.#surface.put(rect.x, rect.y, rect.width, rect.height);
		}
		this.#messagePhase = MSG_RECTANGLES;
		this.handlers.onFrame?.();
		return true;
	}

	/**
	 * Adopt a desktop size sent as a pseudo-rectangle.
	 *
	 * @param {object} rect - The pseudo-rectangle.
	 * @returns {void}
	 */
	#applyDesktopSize(rect) {
		this.#width = rect.width;
		this.#height = rect.height;
		this.#surface.resize(rect.width, rect.height);
		this.handlers.onResize?.(rect.width, rect.height);
	}

	/**
	 * Send a keyboard event.
	 *
	 * @param {KeyboardEvent} event - The browser event.
	 * @param {boolean} down - Whether the key went down.
	 * @returns {void}
	 */
	sendKey(event, down) {
		const keysym = keysymOf(event);
		if (keysym === 0) return;
		const message = new Uint8Array(8);
		const view = new DataView(message.buffer);
		view.setUint8(0, 4);
		view.setUint8(1, down ? 1 : 0);
		view.setUint16(2, 0);
		view.setUint32(4, keysym);
		this.#send(message);
	}

	/**
	 * Send a pointer position and button state.
	 *
	 * @param {number} x - Framebuffer column.
	 * @param {number} y - Framebuffer row.
	 * @param {number} buttons - Bitmask of buttons held.
	 * @returns {void}
	 */
	sendPointer(x, y, buttons) {
		const message = new Uint8Array(6);
		const view = new DataView(message.buffer);
		view.setUint8(0, 5);
		view.setUint8(1, buttons);
		view.setUint16(2, clamp(x));
		view.setUint16(4, clamp(y));
		this.#send(message);
	}

	/**
	 * Record and forward a pointer position.
	 *
	 * @param {number} x - Framebuffer column.
	 * @param {number} y - Framebuffer row.
	 * @param {number} buttons - Bitmask of buttons held.
	 * @returns {void}
	 */
	movePointer(x, y, buttons) {
		this.#pointerX = clamp(x);
		this.#pointerY = clamp(y);
		this.sendPointer(x, y, buttons);
	}

	/**
	 * Send a wheel notch, which RFB carries as a button 4 or 5 press.
	 *
	 * @param {number} notches - Positive scrolls up.
	 * @returns {void}
	 */
	sendScroll(notches) {
		const buttons = notches < 0 ? BUTTON5_MASK : BUTTON4_MASK;
		this.sendPointer(this.#pointerX, this.#pointerY, buttons);
		this.sendPointer(this.#pointerX, this.#pointerY, 0);
	}

	/** @returns {number} the bitmask for one browser button number. */
	static buttonMask(button) {
		switch (button) {
			case 0:
				return BUTTON1_MASK;
			case 1:
				return BUTTON3_MASK;
			case 2:
				return BUTTON2_MASK;
			case 3:
				return BUTTON4_MASK;
			case 4:
				return BUTTON5_MASK;
			default:
				return 0;
		}
	}

	/**
	 * Send clipboard text to the server.
	 *
	 * @param {string} text - Text to copy across.
	 * @returns {void}
	 */
	sendClipboard(text) {
		const bytes = new TextEncoder().encode(text);
		const message = new Uint8Array(8 + bytes.length);
		const view = new DataView(message.buffer);
		view.setUint8(0, 6);
		view.setUint8(1, 0);
		view.setUint8(2, 0);
		view.setUint8(3, 0);
		view.setUint32(4, bytes.length);
		message.set(bytes, 8);
		this.#send(message);
	}

	/**
	 * Report a fatal error and close.
	 *
	 * @param {string} message - What went wrong.
	 * @returns {void}
	 */
	fail(message) {
		if (this.#phase === PHASE_ERROR) return;
		clearTimeout(this.#handshakeTimer);
		this.#phase = PHASE_ERROR;
		this.handlers.onStatus?.({ kind: "error", message });
		this.dispose();
	}

	/** Close the session and release its streams. */
	dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		clearTimeout(this.#handshakeTimer);
		this.#decoder.reset();
		this.#transport.close();
	}

	/**
	 * Write bytes to the transport.
	 *
	 * @param {Uint8Array} bytes - Bytes to send.
	 * @returns {void}
	 */
	#send(bytes) {
		if (this.#disposed) return;
		this.#transport.send(bytes);
	}
}

/**
 * Clamp a coordinate into the protocol's 16-bit range.
 *
 * @param {number} value - Coordinate.
 * @returns {number} the clamped value.
 */
function clamp(value) {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(COORD_MAX, Math.round(value)));
}

/**
 * Concatenate two byte arrays.
 *
 * @param {Uint8Array} first - First part.
 * @param {Uint8Array} second - Second part.
 * @returns {Uint8Array} the concatenation.
 */
function concat(first, second) {
	const out = new Uint8Array(first.length + second.length);
	out.set(first, 0);
	out.set(second, first.length);
	return out;
}

/**
 * Decode bytes as Latin-1, which is how RFB carries names and cut text.
 *
 * @param {Uint8Array} bytes - Bytes to decode.
 * @returns {string} the text.
 */
function latin1(bytes) {
	let out = "";
	for (const byte of bytes) out += String.fromCharCode(byte);
	return out;
}

/**
 * The X11 keysym for a keyboard event.
 *
 * @param {KeyboardEvent} event - The browser event.
 * @returns {number} the keysym, or 0 for a key that has none.
 */
export function keysymOf(event) {
	const named = SPECIAL_KEYSYMS[event.key];
	if (named !== undefined) return named;
	if (typeof event.key === "string" && event.key.length === 1) {
		// Control turns a letter into its control code, which is what X11 has
		// always sent for Ctrl-C and the like.
		if (event.ctrlKey && /^[a-z]$/i.test(event.key)) {
			return event.key.toLowerCase().charCodeAt(0) - 96;
		}
		return event.key.codePointAt(0);
	}
	return 0;
}
