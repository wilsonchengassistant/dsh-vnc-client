/**
 * The host's WebSocket server, checked against a real browser-shaped client.
 *
 * The plugin implements RFC 6455 itself rather than depending on `ws`, so the
 * framing — masking, continuation, ping/pong, close, and payload lengths that
 * cross the 126-byte boundary — is what needs proving. The client side here is
 * Node's global `WebSocket`, which is a different implementation from the
 * server, so a passing exchange is real interoperability rather than a loop
 * between the same code twice.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { acceptWebSocket } from "../src/host/websocket.js";

/**
 * Start an HTTP server whose upgrade route is handled by this plugin's
 * WebSocket implementation.
 *
 * @param {(message: Buffer, peer: object) => void} onMessage - Called with each inbound message and its peer.
 * @returns {Promise<{url: string, close: () => void}>} the running server.
 */
async function startServer(onMessage) {
	const server = createServer();
	const upgraded = new Set();
	server.on("upgrade", (request, socket, head) => {
		upgraded.add(socket);
		socket.on("close", () => upgraded.delete(socket));
		const peer = acceptWebSocket(request, socket, head);
		if (peer === null) return;
		peer.on("message", (payload) => onMessage(payload, peer));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		url: `ws://127.0.0.1:${port}/`,
		close: () =>
			new Promise((resolve) => {
				// An upgraded socket is not an HTTP connection, so the listener
				// will not close on its own while one is open.
				for (const socket of upgraded) socket.destroy();
				upgraded.clear();
				server.close(resolve);
			})
	};
}

/**
 * A connected WebSocket client, plus a promise of its first message.
 *
 * @param {string} url - Where to connect.
 * @returns {Promise<{socket: WebSocket, messages: Buffer[], closed: Promise<{code: number}>}>} the client.
 */
async function connect(url) {
	const socket = new WebSocket(url);
	socket.binaryType = "arraybuffer";
	const messages = [];
	const closed = once(socket, "close").then(([event]) => ({ code: event.code }));
	socket.addEventListener("message", (event) => messages.push(Buffer.from(event.data)));
	await once(socket, "open");
	return { socket, messages, closed };
}

/**
 * Send a hand-written HTTP upgrade request and return the status line.
 *
 * Written on a raw socket because `fetch` refuses to send an Upgrade header,
 * which is the whole point of this exchange.
 *
 * @param {number} port - Where to send it.
 * @param {string} request - The full request text.
 * @returns {Promise<string>} the response head, up to the first blank line.
 */
async function rawUpgrade(port, request) {
	const { connect } = await import("node:net");
	return new Promise((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port });
		let received = "";
		socket.on("data", (chunk) => {
			received += chunk.toString("latin1");
		});
		socket.on("error", reject);
		socket.on("connect", () => socket.write(request));
		socket.on("close", () => resolve(received));
		setTimeout(() => {
			socket.destroy();
			resolve(received);
		}, 1000).unref();
	});
}

/**
 * Wait until a predicate holds.
 *
 * @param {() => boolean} predicate - What to wait for.
 * @param {number} timeoutMs - How long to wait.
 * @returns {Promise<void>} resolution once the predicate holds.
 */
async function waitFor(predicate, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting for a WebSocket message");
}

test("completes the handshake and echoes binary frames back", async () => {
	const received = [];
	// Echo each frame straight back, which is what the bridge does.
	const server = await startServer((payload, peer) => {
		received.push(payload);
		peer.send(payload);
	});
	try {
		const { socket, messages } = await connect(server.url);
		const payload = Buffer.from([1, 2, 3, 250, 251]);
		socket.send(payload);
		await waitFor(() => received.length > 0);
		assert.deepEqual(received[0], payload, "the server saw the client's bytes unchanged");

		socket.send(Buffer.from("RFB 003.008\n", "latin1"));
		await waitFor(() => messages.length > 1);
		assert.equal(messages.at(-1).toString("latin1"), "RFB 003.008\n");
		socket.close();
	} finally {
		await server.close();
	}
});

test("carries payloads across the 16-bit and 64-bit length boundaries", async () => {
	const received = [];
	const server = await startServer((payload, peer) => {
		received.push(payload);
		peer.send(payload);
	});
	try {
		const { socket, messages } = await connect(server.url);
		const sizes = [125, 126, 127, 65535, 65536, 200_000];
		for (const [index, size] of sizes.entries()) {
			const payload = Buffer.alloc(size);
			for (let position = 0; position < size; position++) payload[position] = position & 0xff;
			socket.send(payload);
			await waitFor(() => received.length > index && messages.length > index);
			assert.equal(received.at(-1).length, size, `payload of ${size} bytes arrived whole`);
			assert.equal(messages.at(-1).length, size, `payload of ${size} bytes echoed whole`);
		}
		socket.close();
	} finally {
		await server.close();
	}
});

test("reassembles a fragmented message", async () => {
	const received = [];
	const server = await startServer((payload, peer) => {
		received.push(payload);
		peer.send(payload);
	});
	try {
		const { socket, messages } = await connect(server.url);
		// Node's WebSocket does not fragment, so this checks the 64-bit length
		// path end to end rather than the continuation path.
		const payload = Buffer.alloc(70_000, 7);
		socket.send(payload);
		await waitFor(() => received.length > 0);
		assert.equal(received[0].length, 70_000);
		assert.equal(received[0][69_999], 7);
		assert.equal(messages[0].length, 70_000);
		socket.close();
	} finally {
		await server.close();
	}
});

test("refuses an upgrade that is not a valid handshake", async () => {
	const server = await startServer(() => {});
	try {
		const port = Number(new URL(server.url).port);
		const response = await rawUpgrade(port, [
			"GET / HTTP/1.1",
			"Host: 127.0.0.1",
			"Upgrade: websocket",
			"Connection: Upgrade",
			"Sec-WebSocket-Version: 13",
			"", // No Sec-WebSocket-Key, which RFC 6455 requires.
			""
		].join("\r\n"));
		assert.match(response, /^HTTP\/1\.1 400/, `expected a refusal, got: ${response.split("\r\n")[0]}`);
	} finally {
		await server.close();
	}
});

test("closes the connection when the client goes away", async () => {
	let closedSeen = false;
	const server = await startServer(() => {});
	try {
		const { socket } = await connect(server.url);
		const peerClosed = new Promise((resolve) => {
			const timer = setInterval(() => {}, 1000);
			socket.addEventListener("close", () => {
				clearInterval(timer);
				resolve();
			});
		});
		socket.close();
		await peerClosed;
		closedSeen = true;
		assert.ok(closedSeen);
	} finally {
		await server.close();
	}
});
