/**
 * Minimal RFC 6455 server, enough to carry an RFB byte stream.
 *
 * A plugin cannot `import ws from "ws"`: a profile-local package resolves its
 * bare specifiers only through the Host's own runtime interception, and the
 * WebSocket implementation the Gateway uses is the Host's private dependency.
 * This is therefore a self-contained implementation of the parts of the
 * protocol an RFB stream actually needs — the opening handshake, binary frames
 * in both directions, ping/pong, and close — and nothing else.
 *
 * Deliberately absent: extensions (permessage-deflate), subprotocol
 * negotiation, and fragmented-message reassembly beyond the simple
 * continuation case an RFB bridge produces (its writes are whole frames).
 */

import { createHash } from "node:crypto";

/** The GUID RFC 6455 fixes as the handshake constant. */
const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Opcodes this implementation answers. */
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** Close codes used here. */
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_TOO_LARGE = 1009;

/**
 * Ceiling on one inbound message. A 4K Retina framebuffer in Raw encoding is
 * ~33 MiB, so this is generous for a framebuffer while still refusing the
 * memory-exhaustion shape a hostile peer would aim for.
 */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * Refuse an upgrade that is not a well-formed RFC 6455 handshake.
 *
 * Written as a response rather than a thrown error because the caller owns the
 * socket: an unauthenticated socket gets a status line, not a stack trace.
 *
 * @param {import("node:http").IncomingMessage} request - Upgrade request.
 * @param {import("node:net").Socket} socket - Raw socket to answer on.
 * @param {number} status - HTTP status to answer with.
 * @param {string} reason - Human-readable reason, sent in the status line.
 * @returns {void}
 */
function refuseUpgrade(socket, status, reason) {
	socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * One accepted WebSocket connection.
 *
 * Reads are parsed incrementally from a rolling buffer, so a TCP segment
 * boundary that splits a frame mid-header is not an error — it is simply
 * incomplete, and the parser waits for the rest.
 */
export class WebSocketPeer {
	#socket;
	#buffer;
	#fragments = [];
	#fragmentOpcode = null;
	#closed = false;
	/** @type {((payload: Buffer, isBinary: boolean) => void) | undefined} */
	#messageListener;
	/** @type {(() => void) | undefined} */
	#closeListener;

	/**
	 * @param {import("node:net").Socket} socket - Socket that completed the handshake.
	 * @param {Buffer} head - Bytes the HTTP parser already read past the headers.
	 */
	constructor(socket, head) {
		this.#socket = socket;
		this.#buffer = Buffer.alloc(0);
		socket.on("data", (chunk) => this.#feed(chunk));
		socket.on("close", () => this.#finish());
		socket.on("error", () => this.#finish());
		if (head.length > 0) this.#feed(head);
	}

	/**
	 * Register a listener.
	 *
	 * Events: `message` (payload Buffer, isBinary boolean), `close`.
	 *
	 * @param {"message" | "close"} event - Event name.
	 * @param {(payload: Buffer, isBinary: boolean) => void} listener - Callback.
	 * @returns {void}
	 */
	on(event, listener) {
		if (event === "message") {
			this.#messageListener = listener;
			return;
		}
		this.#closeListener = listener;
	}

	/** Whether this peer is still usable. */
	get closed() {
		return this.#closed;
	}

	/**
	 * Push received bytes into the parser and dispatch every complete message.
	 *
	 * @param {Buffer} chunk - Bytes just read from the socket.
	 * @returns {void}
	 */
	#feed(chunk) {
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
		while (this.#readFrame()) {
			/* #readFrame returns false when the next frame is incomplete */
		}
	}

	/**
	 * Parse and handle one frame, if a whole one has arrived.
	 *
	 * @returns {boolean} whether a frame was consumed and parsing may continue.
	 */
	#readFrame() {
		const buffer = this.#buffer;
		if (buffer.length < 2) return false;

		const first = buffer[0];
		const second = buffer[1];
		const fin = (first & 0x80) !== 0;
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		let length = second & 0x7f;
		let offset = 2;

		if (length === 126) {
			if (buffer.length < 4) return false;
			length = buffer.readUInt16BE(2);
			offset = 4;
		} else if (length === 127) {
			if (buffer.length < 10) return false;
			const wide = buffer.readBigUInt64BE(2);
			if (wide > BigInt(MAX_MESSAGE_BYTES)) {
				this.#fail(CLOSE_TOO_LARGE);
				return false;
			}
			length = Number(wide);
			offset = 10;
		}

		if (length > MAX_MESSAGE_BYTES) {
			this.#fail(CLOSE_TOO_LARGE);
			return false;
		}

		let mask = null;
		if (masked) {
			if (buffer.length < offset + 4) return false;
			mask = buffer.subarray(offset, offset + 4);
			offset += 4;
		}

		if (buffer.length < offset + length) return false;

		// Copy before unmasking: the wire buffer is shared with the next frame.
		const payload = Buffer.from(buffer.subarray(offset, offset + length));
		this.#buffer = buffer.subarray(offset + length);
		if (mask !== null) {
			for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3];
		}

		this.#dispatch(opcode, fin, payload);
		return true;
	}

	/**
	 * Route one parsed frame to its handler.
	 *
	 * @param {number} opcode - Frame opcode.
	 * @param {boolean} fin - FIN flag.
	 * @param {Buffer} payload - Unmasked payload.
	 * @returns {void}
	 */
	#dispatch(opcode, fin, payload) {
		switch (opcode) {
			case OPCODE_CLOSE:
				this.close(CLOSE_NORMAL);
				return;
			case OPCODE_PING:
				this.#writeFrame(OPCODE_PONG, payload);
				return;
			case OPCODE_PONG:
				return;
			case OPCODE_CONTINUATION: {
				if (this.#fragmentOpcode === null) {
					this.#fail(CLOSE_PROTOCOL_ERROR);
					return;
				}
				this.#fragments.push(payload);
				if (fin) {
					const message = Buffer.concat(this.#fragments);
					const isBinary = this.#fragmentOpcode === OPCODE_BINARY;
					this.#fragments = [];
					this.#fragmentOpcode = null;
					this.#messageListener?.(message, isBinary);
				}
				return;
			}
			case OPCODE_TEXT:
			case OPCODE_BINARY: {
				if (!fin) {
					this.#fragmentOpcode = opcode;
					this.#fragments = [payload];
					return;
				}
				this.#messageListener?.(payload, opcode === OPCODE_BINARY);
				return;
			}
			default:
				this.#fail(CLOSE_PROTOCOL_ERROR);
		}
	}

	/**
	 * Emit one unfragmented server-to-client frame.
	 *
	 * @param {number} opcode - Frame opcode.
	 * @param {Buffer} payload - Payload bytes.
	 * @returns {void}
	 */
	#writeFrame(opcode, payload) {
		if (this.#closed) return;
		const length = payload.length;
		let header;
		if (length < 126) {
			header = Buffer.from([0x80 | opcode, length]);
		} else if (length < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 126;
			header.writeUInt16BE(length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(length), 2);
		}
		try {
			this.#socket.write(Buffer.concat([header, payload]));
		} catch {
			this.#finish();
		}
	}

	/**
	 * Send bytes to the browser as one binary message.
	 *
	 * @param {Buffer | Uint8Array} data - Bytes to send.
	 * @returns {void}
	 */
	send(data) {
		this.#writeFrame(OPCODE_BINARY, Buffer.isBuffer(data) ? data : Buffer.from(data));
	}

	/**
	 * Close the connection, best effort.
	 *
	 * @param {number} code - Close code to report.
	 * @returns {void}
	 */
	close(code = CLOSE_NORMAL) {
		if (this.#closed) return;
		const reason = Buffer.from(String(code), "ascii");
		const payload = Buffer.alloc(2 + reason.length);
		payload.writeUInt16BE(code, 0);
		reason.copy(payload, 2);
		this.#writeFrame(OPCODE_CLOSE, payload);
		this.#socket.end();
		this.#finish();
	}

	/**
	 * Close with a protocol error and drop the socket.
	 *
	 * @param {number} code - Close code to report.
	 * @returns {void}
	 */
	#fail(code) {
		this.#closed = true;
		try {
			this.#socket.destroy();
		} catch {
			/* the socket is already gone */
		}
		this.#closeListener?.();
	}

	/** Tear down once, notifying the owner. */
	#finish() {
		if (this.#closed) return;
		this.#closed = true;
		this.#closeListener?.();
	}
}

/**
 * Complete the opening handshake and hand back a peer.
 *
 * @param {import("node:http").IncomingMessage} request - Upgrade request.
 * @param {import("node:net").Socket} socket - Socket carrying it.
 * @param {Buffer} head - Bytes already read past the request headers.
 * @returns {WebSocketPeer | null} the peer, or null after refusing the socket.
 */
export function acceptWebSocket(request, socket, head) {
	const upgrade = String(request.headers.upgrade ?? "").toLowerCase();
	const connection = String(request.headers.connection ?? "").toLowerCase();
	const key = request.headers["sec-websocket-key"];
	const version = String(request.headers["sec-websocket-version"] ?? "");

	if (upgrade !== "websocket" || !connection.includes("upgrade")) {
		refuseUpgrade(socket, 400, "Bad Request");
		return null;
	}
	if (typeof key !== "string" || key.length === 0) {
		refuseUpgrade(socket, 400, "Bad Request");
		return null;
	}
	if (version !== "13") {
		refuseUpgrade(socket, 426, "Upgrade Required");
		return null;
	}

	const accept = createHash("sha1").update(key + HANDSHAKE_GUID).digest("base64");
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			`Sec-WebSocket-Accept: ${accept}\r\n\r\n`
	);
	socket.setNoDelay(true);
	return new WebSocketPeer(socket, head ?? Buffer.alloc(0));
}
