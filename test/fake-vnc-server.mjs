/**
 * A minimal VNC server, for testing the client against.
 *
 * Speaks enough RFB to drive a real session: the 3.8 handshake with both
 * security types, the pixel format and encoding negotiation, and framebuffer
 * updates built by the test encoders. Its purpose is to exercise the client's
 * resumable parser against input that arrives in awkward pieces, which a
 * hand-fed byte array cannot do as honestly as a socket can.
 *
 * Run standalone to poke at a client by hand:
 *
 *   node test/fake-vnc-server.mjs [port]
 */

import { createServer } from "node:net";
import { appendFileSync } from "node:fs";
import { RFB_VERSION, SECURITY_NONE, SECURITY_VNC_AUTH } from "../src/client/rfb/constants.js";
import { vncAuthResponse } from "../src/client/rfb/des.js";
import { encodeHextileSolid, encodeRaw, PersistentDeflate, Writer, encodeZrle, zrleTileSolid } from "./encoders.mjs";

/** Bytes of the desktop this server offers. */
const WIDTH = 64;
const HEIGHT = 48;

/**
 * The framebuffer this server draws, as RGB triples.
 *
 * @returns {Uint8Array} three bytes per pixel, row-major.
 */
function frame() {
	const out = new Uint8Array(WIDTH * HEIGHT * 3);
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const offset = (y * WIDTH + x) * 3;
			out[offset] = (x * 4) & 0xff;
			out[offset + 1] = (y * 5) & 0xff;
			out[offset + 2] = ((x ^ y) * 3) & 0xff;
		}
	}
	return out;
}

/**
 * One connected client.
 */
class Session {
	#socket;
	#buffer = Buffer.alloc(0);
	#phase = "version";
	#password = "";
	#security = SECURITY_NONE;
	#shared = false;
	#counter = 0;
	#events = [];

	/** The 16-byte VNC authentication challenge, when one is sent. */
	#challenge = null;

	/**
	 * @param {import("node:net").Socket} socket - The client's socket.
	 * @param {string} password - The password to challenge for, if any.
	 */
	constructor(socket, password) {
		this.#socket = socket;
		this.#password = password;
		this.#events = [];
		socket.on("data", (chunk) => this.#feed(chunk));
		socket.on("error", () => {});
		this.#start();
	}

	/** Events the session has observed, for assertions. */
	get events() {
		return this.#events;
	}

	/** Start the handshake. */
	#start() {
		this.#socket.write(RFB_VERSION);
	}

	/**
	 * Feed received bytes and run the handshake until it is done.
	 *
	 * @param {Buffer} chunk - Bytes just received.
	 * @returns {void}
	 */
	async #feed(chunk) {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		for (;;) {
			if (this.#phase === "version") {
				if (this.#buffer.length < 12) return;
				this.#buffer = this.#buffer.subarray(12);
				this.#offerSecurity();
				this.#phase = "security";
				continue;
			}
			if (this.#phase === "security") {
				if (this.#buffer.length < 1) return;
				this.#security = this.#buffer[0];
				this.#buffer = this.#buffer.subarray(1);
				if (this.#security === SECURITY_VNC_AUTH) {
					this.#challenge = Buffer.alloc(16);
					for (let index = 0; index < 16; index++) this.#challenge[index] = index * 7 + 1;
					this.#socket.write(this.#challenge);
					this.#phase = "challenge";
				} else if (this.#security === SECURITY_NONE) {
					this.#writeSecurityResult(0);
					this.#phase = "client-init";
				} else {
					this.#writeSecurityResult(1);
					this.#phase = "closed";
				}
				continue;
			}
			if (this.#phase === "challenge") {
				if (this.#buffer.length < 16) return;
				const response = this.#buffer.subarray(0, 16);
				this.#buffer = this.#buffer.subarray(16);
				const expected = Buffer.from(vncAuthResponse(Uint8Array.from(this.#challenge), this.#password));
				const ok = Buffer.compare(Buffer.from(response), expected) === 0;
				this.#events.push({ kind: "auth", ok });
				this.#writeSecurityResult(ok ? 0 : 2);
				this.#phase = ok ? "client-init" : "closed";
				continue;
			}
			if (this.#phase === "client-init") {
				if (this.#buffer.length < 1) return;
				this.#shared = this.#buffer[0] === 1;
				this.#buffer = this.#buffer.subarray(1);
				this.#phase = "messages";
				this.#sendServerInit();
				continue;
			}
			if (this.#phase === "messages") {
				if (!(await this.#consumeMessages())) return;
				continue;
			}
			return;
		}
	}

	/** Offer both security types this server can speak. */
	#offerSecurity() {
		// The count byte must match the number of types that follow it.
		const writer = new Writer();
		if (this.#password === "") {
			// A server that wants no password offers no challenge to answer.
			writer.bytes([1, SECURITY_NONE]);
		} else {
			writer.bytes([1, SECURITY_VNC_AUTH]);
		}
		this.#socket.write(Buffer.from(writer.toBytes()));
	}

	/**
	 * Send the 3.8 SecurityResult message.
	 *
	 * @param {number} result - Zero for success.
	 * @returns {void}
	 */
	#writeSecurityResult(result) {
		const message = Buffer.alloc(4);
		message.writeUInt32BE(result, 0);
		this.#socket.write(message);
		if (result !== 0) {
			this.#socket.write(Buffer.from("authentication failed", "ascii"));
		}
	}

	/** Send ServerInit describing the desktop. */
	#sendServerInit() {
		const name = Buffer.from("dsh-vnc-client test server", "ascii");
		const message = Buffer.alloc(24 + name.length);
		message.writeUInt16BE(WIDTH, 0);
		message.writeUInt16BE(HEIGHT, 2);
		message.writeUInt32BE(name.length, 20);
		name.copy(message, 24);
		this.#socket.write(message);
	}

	/**
	 * Consume client messages, answering each update request with an update.
	 *
	 * @returns {Promise<boolean>} whether to loop again.
	 */
	async #consumeMessages() {
		while (this.#buffer.length >= 1) {
			const type = this.#buffer[0];
			if (type === 0) {
				if (this.#buffer.length < 20) return false;
				this.#buffer = this.#buffer.subarray(20);
				this.#events.push({ kind: "set-pixel-format" });
				continue;
			}
			if (type === 2) {
				if (this.#buffer.length < 4 + this.#buffer.readUInt16BE(2) * 4) return false;
				const count = this.#buffer.readUInt16BE(2);
				this.#events.push({ kind: "set-encodings", count });
				this.#buffer = this.#buffer.subarray(4 + count * 4);
				continue;
			}
			if (type === 3) {
				if (this.#buffer.length < 10) return false;
				this.#events.push({ kind: "update-request" });
				this.#buffer = this.#buffer.subarray(10);
				await this.#sendUpdate();
				continue;
			}
			if (type === 4) {
				if (this.#buffer.length < 8) return false;
				this.#events.push({
					kind: "key",
					down: this.#buffer[1] === 1,
					keysym: this.#buffer.readUInt32BE(4)
				});
				this.#buffer = this.#buffer.subarray(8);
				continue;
			}
			if (type === 5) {
				if (this.#buffer.length < 6) return false;
				this.#events.push({
					kind: "pointer",
					buttons: this.#buffer[1],
					x: this.#buffer.readUInt16BE(2),
					y: this.#buffer.readUInt16BE(4)
				});
				this.#buffer = this.#buffer.subarray(6);
				continue;
			}
			if (type === 6) {
				if (this.#buffer.length < 8) return false;
				const length = this.#buffer.readUInt32BE(4);
				if (this.#buffer.length < 8 + length) return false;
				this.#events.push({ kind: "clipboard", text: this.#buffer.subarray(8, 8 + length).toString("latin1") });
				this.#buffer = this.#buffer.subarray(8 + length);
				continue;
			}
			// Unknown message types are ignored, as a real server tolerates.
			this.#buffer = this.#buffer.subarray(1);
		}
		return false;
	}

	/**
	 * Send one framebuffer update, cycling through encodings.
	 *
	 * @returns {void}
	 */
	async #sendUpdate() {
		const pixels = frame();
		// Alternate encodings so a session exercises more than one path, and
		// start with Raw so the first update carries real pixels.
		const style = this.#counter++ % 3;
		const rect = { x: 0, y: 0, width: WIDTH, height: HEIGHT };

		let encoding;
		let payload;
		if (style === 0) {
			encoding = 0;
			payload = encodeRaw(rect, pixels);
		} else if (style === 1) {
			encoding = 4;
			payload = encodeHextileSolid(rect, [200, 100, 50]);
		} else {
			encoding = 16;
			this.#zrle = this.#zrle ?? new PersistentDeflate();
			payload = await encodeZrle(rect, new Uint8Array(0), (tile) => zrleTileSolid([40, 90, 160]), this.#zrle);
		}

		// Four bytes of message header, then a twelve-byte rectangle header.
		const bytes = Buffer.from(payload);
		const message = Buffer.alloc(16 + bytes.length);
		message.writeUInt8(0, 0);
		message.writeUInt16BE(1, 2);
		message.writeUInt16BE(rect.x, 4);
		message.writeUInt16BE(rect.y, 6);
		message.writeUInt16BE(rect.width, 8);
		message.writeUInt16BE(rect.height, 10);
		message.writeInt32BE(encoding, 12);
		bytes.copy(message, 16);
		this.#socket.write(message);
	}

	#zrle;
}

/**
 * Start a fake VNC server.
 *
 * @param {{port?: number, password?: string}} options - Where to listen and what to challenge for.
 * @returns {Promise<{port: number, sessions: () => Session[], close: () => void}>} the running server.
 */
export function startFakeServer(options = {}) {
	const password = options.password ?? "";
	const sessions = [];
	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		sessions.push(new Session(socket, password));
	});
	return new Promise((resolve) => {
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			resolve({
				port: server.address().port,
				sessions: () => sessions,
				// Existing connections keep the server open, so closing has to drop them
				// too: a test that only closes the listener would hang on exit.
				close: () => {
					for (const socket of sockets) socket.destroy();
					sockets.clear();
					server.close();
				}
			});
		});
	});
}

// Standalone mode: serve until interrupted.
if (process.argv[1]?.endsWith("fake-vnc-server.mjs")) {
	const port = Number(process.argv[2] ?? 5901);
	// Optional third argument: append every client message as JSON lines, so a
	// browser-driven test can assert on the input the client actually sent.
	// The protocol tests read `session.events` in-process instead; this exists
	// for the case where the client runs in a page and this server does not.
	const eventsPath = process.argv[3];
	startFakeServer({ port }).then((server) => {
		if (eventsPath) {
			const timer = setInterval(() => {
				const lines = server.sessions().flatMap((session) => session.events.map((event) => JSON.stringify(event)));
				if (lines.length === 0) return;
				server.sessions().forEach((session) => session.events.splice(0, session.events.length));
				appendFileSync(eventsPath, `${lines.join("\n")}\n`);
			}, 200);
			timer.unref();
		}
		process.stdout.write(`fake VNC server listening on 127.0.0.1:${server.port}\n`);
	});
}
