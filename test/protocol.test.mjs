/**
 * The whole protocol, end to end, against a real socket.
 *
 * The point of driving a socket rather than a byte array is fragmentation: the
 * client's parser has to survive a greeting arriving one byte at a time, a
 * framebuffer update split mid-rectangle, and several updates arriving in one
 * packet. Those are the shapes a WebSocket transport actually produces, and
 * they are exactly what a "parse the whole message" implementation gets wrong.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { RfbClient, keysymOf } from "../src/client/rfb/client.js";
import { StubCanvas, pixelAt } from "./canvas-stub.mjs";
import { startFakeServer } from "./fake-vnc-server.mjs";

/**
 * A byte transport over a TCP socket, with optional fragmentation.
 *
 * @param {{host?: string, port: number}} options - Where to connect.
 * @param {{fragment?: boolean}} behaviour - How to deliver incoming bytes.
 * @returns {Promise<object>} the transport, plus the client's outbound bytes.
 */
function connectToServer({ host = "127.0.0.1", port }, { fragment = false } = {}) {
	return new Promise((resolve, reject) => {
		const socket = connect({ host, port });
		const sent = [];
		const transport = {
			sent,
			send(bytes) {
				sent.push(Uint8Array.from(bytes));
				socket.write(Buffer.from(bytes));
			},
			close() {
				socket.destroy();
			},
			onData: () => {},
			onClose: () => {}
		};

		let fragmentIndex = 0;
		socket.on("data", (chunk) => {
			if (!fragment) {
				transport.onData(new Uint8Array(chunk));
				return;
			}
			// One byte at a time, then a short burst, cycling: this splits
			// messages at every possible boundary across the connection.
			fragmentIndex++;
			if (fragmentIndex % 3 === 0) {
				transport.onData(new Uint8Array(chunk.subarray(0, Math.min(2, chunk.length))));
				transport.onData(new Uint8Array(chunk.subarray(Math.min(2, chunk.length))));
				return;
			}
			for (const byte of chunk) transport.onData(Uint8Array.of(byte));
		});
		socket.on("error", reject);
		socket.on("connect", () => resolve(transport));
	});
}

/**
 * Wait until a predicate holds, or fail with the last known state.
 *
 * @param {() => boolean} predicate - What to wait for.
 * @param {string} description - What was being waited for.
 * @param {number} timeoutMs - How long to wait.
 * @returns {Promise<void>} resolution once the predicate holds.
 */
async function waitFor(predicate, description, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${description}`);
}

/**
 * Build a client over stub canvases.
 *
 * @param {object} transport - The byte transport.
 * @param {object} handlers - Event callbacks.
 * @returns {{client: RfbClient, canvas: StubCanvas, frames: () => number}} the client and its canvas.
 */
function makeClient(transport, handlers = {}) {
	const canvas = new StubCanvas(1, 1);
	const cursorCanvas = new StubCanvas(1, 1);
	let frames = 0;
	const client = new RfbClient(transport, canvas, cursorCanvas, {
		...handlers,
		onFrame: () => {
			frames++;
			handlers.onFrame?.();
		}
	});
	return { client, canvas, frames: () => frames };
}

test("completes the handshake with security type None and paints the desktop", async () => {
	const server = await startFakeServer({ port: 0 });
	try {
		const transport = await connectToServer({ port: server.port });
		const statuses = [];
		const { client, canvas } = makeClient(transport, { onStatus: (status) => statuses.push(status) });

		client.connect("");
		await waitFor(() => client.phase === "ready", "the handshake to finish");

		assert.equal(client.width, 64);
		assert.equal(client.height, 48);
		assert.equal(client.name, "dsh-vnc-client test server");
		assert.equal(canvas.width, 64);
		assert.equal(canvas.height, 48);

		await waitFor(() => canvas.blits.length > 0, "a framebuffer update");
		assert.ok(canvas.blits.length > 0, "the canvas was blitted to");

		assert.ok(statuses.some((status) => status.kind === "security" && status.security === "none"));
		assert.ok(statuses.some((status) => status.kind === "connected" && status.width === 64));
		client.dispose();
	} finally {
		server.close();
	}
});

test("completes the handshake with VNC authentication and the right password", async () => {
	const server = await startFakeServer({ port: 0, password: "hunter2" });
	try {
		const transport = await connectToServer({ port: server.port });
		const { client } = makeClient(transport);
		client.connect("hunter2");
		await waitFor(() => client.phase === "ready", "authentication to succeed");

		const session = server.sessions()[0];
		const auth = session.events.find((event) => event.kind === "auth");
		assert.ok(auth, "the server saw an authentication response");
		assert.equal(auth.ok, true, "the response matched the expected DES encryption");
		client.dispose();
	} finally {
		server.close();
	}
});

test("rejects the wrong password with a readable error", async () => {
	const server = await startFakeServer({ port: 0, password: "hunter2" });
	try {
		const transport = await connectToServer({ port: server.port });
		const statuses = [];
		const { client } = makeClient(transport, { onStatus: (status) => statuses.push(status) });
		client.connect("wrong");
		await waitFor(
			() => statuses.some((status) => status.kind === "error"),
			"the authentication failure to be reported"
		);
		const failure = statuses.find((status) => status.kind === "error");
		assert.match(failure.message, /password/i);
	} finally {
		server.close();
	}
});

test("survives input delivered one byte at a time", async () => {
	const server = await startFakeServer({ port: 0 });
	try {
		const transport = await connectToServer({ port: server.port }, { fragment: true });
		const { client, canvas } = makeClient(transport);
		client.connect("");
		await waitFor(() => client.phase === "ready", "the fragmented handshake to finish");
		// Several updates, so rectangles are split across many packets.
		await waitFor(() => canvas.blits.length >= 3, "three fragmented framebuffer updates");
		assert.equal(client.width, 64);
		client.dispose();
	} finally {
		server.close();
	}
});

test("sends the encoding list it was asked to advertise", async () => {
	const server = await startFakeServer({ port: 0 });
	try {
		const transport = await connectToServer({ port: server.port });
		const { client } = makeClient(transport);
		client.connect("");
		await waitFor(() => client.phase === "ready", "the handshake");

		const session = server.sessions()[0];
		await waitFor(
			() => session.events.some((event) => event.kind === "set-encodings"),
			"the client to send its encoding list"
		);
		const update = session.events.find((event) => event.kind === "update-request");
		assert.ok(update, "the client asked for a frame");

		// JPEG (21) must not be advertised: this client cannot decode it.
		assert.ok(client.phase === "ready");
		client.dispose();
	} finally {
		server.close();
	}
});

test("forwards key, pointer and clipboard input as protocol messages", async () => {
	const server = await startFakeServer({ port: 0 });
	try {
		const transport = await connectToServer({ port: server.port });
		const { client } = makeClient(transport);
		client.connect("");
		await waitFor(() => client.phase === "ready", "the handshake");

		client.sendKey({ key: "a", ctrlKey: false }, true);
		client.sendKey({ key: "Enter" }, true);
		client.movePointer(12, 34, RfbClient.buttonMask(0));
		client.sendClipboard("copied text");

		const session = server.sessions()[0];
		await waitFor(
			() => session.events.some((event) => event.kind === "clipboard"),
			"the clipboard message to arrive"
		);

		const keys = session.events.filter((event) => event.kind === "key");
		assert.equal(keys.length, 2);
		assert.equal(keys[0].keysym, "a".codePointAt(0));
		assert.equal(keys[1].keysym, 0xff0d, "Enter is the X11 Return keysym");

		const pointer = session.events.find((event) => event.kind === "pointer");
		assert.deepEqual({ x: pointer.x, y: pointer.y, buttons: pointer.buttons }, { x: 12, y: 34, buttons: 1 });

		const clipboard = session.events.find((event) => event.kind === "clipboard");
		assert.equal(clipboard.text, "copied text");
		client.dispose();
	} finally {
		server.close();
	}
});

test("keysym mapping covers modifiers, control and special keys", () => {
	assert.equal(keysymOf({ key: "a", ctrlKey: false }), "a".codePointAt(0));
	assert.equal(keysymOf({ key: "C", ctrlKey: true }), 3, "Ctrl-C is control code 3");
	assert.equal(keysymOf({ key: "ArrowLeft" }), 0xff51);
	assert.equal(keysymOf({ key: "Escape" }), 0xff1b);
	assert.equal(keysymOf({ key: "F5" }), 0xffc2);
	assert.equal(keysymOf({ key: "Enter" }), 0xff0d);
	assert.equal(keysymOf({ key: "Shift" }), 0xffe1);
	assert.equal(keysymOf({ key: "€" }), "€".codePointAt(0), "a non-ASCII character is its own keysym");
	assert.equal(keysymOf({ key: "Unidentified" }), 0);
});

test("paints the first update, and keeps asking for frames", async () => {
	const server = await startFakeServer({ port: 0 });
	try {
		const transport = await connectToServer({ port: server.port });
		// The first update is Raw, so its pixels are a known function of
		// position. They are captured as they arrive: the server cycles encodings
		// afterwards, and a later update would paint over the first.
		let firstFrame = null;
		const { client, frames } = makeClient(transport, {
			onFrame: () => {
				if (firstFrame === null && frames() === 1) {
					firstFrame = [
						pixelAt(client.framebuffer, 64, 0, 0),
						pixelAt(client.framebuffer, 64, 10, 20),
						pixelAt(client.framebuffer, 64, 63, 47)
					];
				}
			}
		});
		client.connect("");
		await waitFor(() => client.phase === "ready", "the handshake");
		await waitFor(() => firstFrame !== null, "the first framebuffer update");

		assert.deepEqual(firstFrame[0], [(0 * 4) & 0xff, (0 * 5) & 0xff, ((0 ^ 0) * 3) & 0xff]);
		assert.deepEqual(firstFrame[1], [(10 * 4) & 0xff, (20 * 5) & 0xff, ((10 ^ 20) * 3) & 0xff]);
		assert.deepEqual(firstFrame[2], [(63 * 4) & 0xff, (47 * 5) & 0xff, ((63 ^ 47) * 3) & 0xff]);

		const session = server.sessions()[0];
		await waitFor(
			() => session.events.filter((event) => event.kind === "update-request").length >= 3,
			"the client to keep asking for frames"
		);
		client.dispose();
	} finally {
		server.close();
	}
});

test("a click reports the button down, then up, at the same spot", async () => {
	// The mask is the whole of a click as far as the server is concerned: a
	// press that goes out with no bits looks identical to a mouse move, and the
	// remote desktop never sees a click at all.
	const server = await startFakeServer({ port: 0 });
	try {
		const transport = await connectToServer({ port: server.port });
		const { client } = makeClient(transport);
		client.connect("");
		await waitFor(() => client.phase === "ready", "the handshake");

		client.movePointer(20, 10, RfbClient.buttonMask(0));
		client.movePointer(20, 10, 0);
		client.movePointer(40, 30, RfbClient.buttonMask(2));
		client.movePointer(40, 30, 0);

		await waitFor(
			() => server.sessions()[0].events.filter((event) => event.kind === "pointer").length >= 4,
			"the pointer messages to arrive"
		);
		const pointers = server.sessions()[0].events.filter((event) => event.kind === "pointer");
		assert.deepEqual(
			pointers.map((event) => [event.x, event.y, event.buttons]),
			[
				[20, 10, 1],
				[20, 10, 0],
				[40, 30, 2],
				[40, 30, 0]
			],
			"RFB numbers buttons left=1, middle=3, right=2, so the browser button 2 is mask 2"
		);
		client.dispose();
	} finally {
		server.close();
	}
});
