/**
 * VNC client, host half.
 *
 * The browser cannot open a TCP socket, so the RFB conversation with a VNC
 * server has to cross the Host. This plugin owns two seats:
 *
 * 1. A WebSocket upgrade route, `/api/vnc/bridge`, which authenticates the
 *    request exactly the way the Gateway authenticates its own stream (the
 *    trusted-host fence plus the browser cookie or launch token), opens a TCP
 *    connection to the requested saved target, and then does nothing but pump
 *    bytes in both directions. All protocol knowledge stays in the browser.
 * 2. A `vnc` Remote service over the ordinary `/api` RPC channel, through
 *    which the settings page manages the saved servers and through which the
 *    browser fetches one target's password at the moment it connects. The
 *    password never appears in a URL, so it cannot land in a request log.
 *
 * The server is not assumed to be the machine running the Host: a target is an
 * arbitrary host and port, so the plugin works against a LAN or tailnet VNC
 * server as readily as against localhost.
 */

import { connect } from "node:net";
import z from "@deepseek-ai/schemastery";
import { Service } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { acceptWebSocket } from "./websocket.js";
import { TargetStore } from "./targets.js";

/** Upgrade route this plugin owns. Distinct from the Gateway's stream path. */
const BRIDGE_PATH = "/api/vnc/bridge";

/**
 * Declare one direct Remote method without decorator syntax.
 *
 * This runtime has V8 decorators switched off, so `@Remote(…)` is a syntax
 * error here. `Remote(name)` returns the decorator the shipped packages'
 * compiler emits and needs only `addInitializer` from its context; the
 * initializer derives the prototype from its receiver, so it runs against an
 * instance rather than the class.
 *
 * @param {object} Proto - Class carrying the method.
 * @param {string} method - Method name, which is also the wire export name.
 * @returns {void}
 */
function declareRemote(Proto, method) {
	const initializers = [];
	Remote(method)(void 0, {
		name: method,
		"static": false,
		private: false,
		addInitializer(initializer) {
			initializers.push(initializer);
		}
	});
	if (initializers.length !== 1) {
		throw new Error(`vnc-client: cannot declare Remote method '${method}'`);
	}
	initializers[0].call(Object.create(Proto.prototype));
}

/**
 * One browser-to-VNC-server byte pipe.
 *
 * Created only after the TCP connection is established, so a refused or
 * unreachable server never becomes a half-open WebSocket that merely hangs.
 */
class Bridge {
	#socket;
	#peer;
	#closed = false;

	/**
	 * @param {import("./websocket.js").WebSocketPeer} peer - Accepted browser socket.
	 * @param {import("node:net").Socket} socket - Connected server socket.
	 * @param {{warn: (message: string) => void}} logger - Host logger.
	 * @param {string} label - Target name, for log lines.
	 * @returns {Bridge} the live pipe.
	 */
	constructor(peer, socket, logger, label) {
		this.#peer = peer;
		this.#socket = socket;
		socket.setNoDelay(true);

		socket.on("data", (chunk) => {
			if (!this.#closed) peer.send(chunk);
		});
		socket.on("close", () => this.dispose());
		socket.on("error", (error) => {
			logger.warn(`vnc-client: ${label}: ${String(error)}`);
			this.dispose();
		});
		peer.on("close", () => this.dispose());
		peer.on("message", (payload) => {
			if (!this.#closed) socket.write(payload);
		});
	}

	/** Whether this pipe has already been torn down. */
	get closed() {
		return this.#closed;
	}

	/**
	 * Close both ends once.
	 *
	 * @returns {void}
	 */
	dispose() {
		if (this.#closed) return;
		this.#closed = true;
		this.#socket.destroy();
		this.#peer.close();
	}
}

/**
 * Saved-server management, reachable from the settings page and from the tab
 * itself. Auto-claimed by the Gateway, so no route or permission is needed.
 */
class VncTargetsService extends TypertRemoteService {
	/** The store and the bridge owner must exist before any method is called. */
	static inject = ["vncBridge"];

	/**
	 * @param {object} ctx - Host context carrying the injected services.
	 */
	constructor(ctx) {
		super(ctx, "vnc");
	}

	/**
	 * List every saved server, without its password.
	 *
	 * @returns {Promise<object[]>} safe projections.
	 */
	async listTargets() {
		return this.ctx.vncBridge.store.list();
	}

	/**
	 * Create or update one saved server.
	 *
	 * @param {{id?: string, name: string, host: string, port: number, password?: string}} request - The server to save.
	 * @returns {Promise<object>} the saved server, without its password.
	 */
	async saveTarget(request) {
		try {
			return await this.ctx.vncBridge.store.save(request);
		} catch (error) {
			throw new RemoteError("vnc/invalid-target", error instanceof Error ? error.message : String(error), {
				name: typeof request?.name === "string" ? request.name : null
			});
		}
	}

	/**
	 * Delete one saved server.
	 *
	 * @param {{id: string}} request - Which server to delete.
	 * @returns {Promise<{removed: boolean}>} whether one was removed.
	 */
	async removeTarget(request) {
		const id = request?.id;
		if (typeof id !== "string" || id.length === 0) {
			throw new RemoteError("vnc/invalid-target", "a target id is required");
		}
		return { removed: await this.ctx.vncBridge.store.remove(id) };
	}

	/**
	 * Resolve one server for an immediate connection.
	 *
	 * This is the only path that hands the browser a password, and it is called
	 * at connect time rather than during a list render.
	 *
	 * @param {{id: string}} request - Which server to connect to.
	 * @returns {Promise<{id: string, name: string, host: string, port: number, password: string}>} the connection facts.
	 */
	async resolveTarget(request) {
		const id = request?.id;
		if (typeof id !== "string" || id.length === 0) {
			throw new RemoteError("vnc/invalid-target", "a target id is required");
		}
		const target = await this.ctx.vncBridge.store.find(id);
		if (target === undefined) {
			throw new RemoteError("vnc/unknown-target", `no saved VNC server with id '${id}'`, { id });
		}
		return {
			id: target.id,
			name: target.name,
			host: target.host,
			port: target.port,
			password: target.password ?? ""
		};
	}

	/**
	 * Probe one server's RFB greeting without connecting the browser.
	 *
	 * The settings page uses this to tell "wrong host or port" apart from "the
	 * server is there but wants a password", which a bare connect failure
	 * cannot distinguish.
	 *
	 * @param {{id?: string, host?: string, port?: number}} request - A saved id, or an ad-hoc host and port.
	 * @returns {Promise<{ok: boolean, banner: string | null, error: string | null}>} what the server said.
	 */
	async probeTarget(request) {
		const bridge = this.ctx.vncBridge;
		let host = request?.host;
		let port = request?.port;
		if (typeof request?.id === "string") {
			const target = await bridge.store.find(request.id);
			if (target === undefined) {
				throw new RemoteError("vnc/unknown-target", `no saved VNC server with id '${request.id}'`, { id: request.id });
			}
			host = target.host;
			port = target.port;
		}
		return bridge.probe(host, port);
	}
}

declareRemote(VncTargetsService, "listTargets");
declareRemote(VncTargetsService, "saveTarget");
declareRemote(VncTargetsService, "removeTarget");
declareRemote(VncTargetsService, "resolveTarget");
declareRemote(VncTargetsService, "probeTarget");

/**
 * Owns the upgrade route and the saved-server store.
 */
class VncBridge extends Service {
	static Config = z.object({
		/** How long a TCP connect to the VNC server may take before it is abandoned. */
		connectTimeoutMs: z.natural().max(600_000).default(10_000),
		/** Largest framebuffer update forwarded before the pipe is dropped as unreasonable. */
		maxBridgeMessageBytes: z.natural().max(1_073_741_824).default(64 * 1024 * 1024)
	});

	static inject = ["webServer", "connection"];

	/** @type {TargetStore} */
	store;

	/** Live pipes, so unloading the plugin does not leave a desktop reachable. */
	#bridges = new Set();

	/**
	 * @param {object} ctx - Host context carrying the injected services.
	 * @param {{connectTimeoutMs: number}} config - Validated plugin configuration.
	 */
	constructor(ctx, config) {
		super(ctx, "vncBridge");
		this.store = new TargetStore(dshHomePath(), ctx.logger);
		this.connectTimeoutMs = config.connectTimeoutMs;

		ctx.effect(() => {
			const route = {
				path: BRIDGE_PATH,
				handler: (request, socket, head) => this.handleUpgrade(request, socket, head)
			};
			return ctx.webServer.registerUpgrade(route);
		}, "vnc-client: bridge upgrade route");

		ctx.plugin(VncTargetsService);
	}

	/** Drop every live pipe when the plugin is unloaded or the Host shuts down. */
	async [Service.stop]() {
		for (const bridge of this.#bridges) bridge.dispose();
		this.#bridges.clear();
	}

	/**
	 * Authenticate one upgrade and, if it holds up, start piping bytes.
	 *
	 * @param {import("node:http").IncomingMessage} request - Upgrade request.
	 * @param {import("node:net").Socket} socket - Raw socket.
	 * @param {Buffer} head - Bytes already read past the headers.
	 * @returns {void}
	 */
	handleUpgrade(request, socket, head) {
		// The same admission the Gateway applies to its own stream: the
		// trusted-host fence, then the browser cookie or launch token. Without
		// this the bridge is an unauthenticated remote-desktop relay.
		const admission = this.ctx.connection.admit(request);
		if ("rejection" in admission) {
			socket.end(`HTTP/1.1 ${admission.rejection} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
			return;
		}

		const targetId = new URL(request.url ?? "/", "http://localhost").searchParams.get("target");
		if (typeof targetId !== "string" || targetId.length === 0) {
			socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			return;
		}

		this.store.find(targetId).then((target) => {
			if (target === undefined) {
				socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
				return;
			}
			const peer = acceptWebSocket(request, socket, head);
			if (peer === null) return;
			this.open(target, peer);
		}).catch((error) => {
			this.ctx.logger.warn(`vnc-client: could not read target '${targetId}': ${String(error)}`);
			socket.destroy();
		});
	}

	/**
	 * Open the TCP connection and hand both ends to one pump.
	 *
	 * The browser sees a WebSocket that completes its handshake before the TCP
	 * connect is attempted, so a failure to reach the server is reported by
	 * closing the socket with a reason rather than by an HTTP status the page
	 * has already passed.
	 *
	 * @param {object} target - Saved server to reach.
	 * @param {import("./websocket.js").WebSocketPeer} peer - Accepted browser socket.
	 * @returns {void}
	 */
	open(target, peer) {
		const socket = connect({ host: target.host, port: target.port });
		const fail = (reason) => {
			this.ctx.logger.warn(`vnc-client: ${target.name} (${target.host}:${target.port}): ${reason}`);
			peer.close(1011);
		};
		const timer = setTimeout(() => {
			fail(`no TCP connection within ${this.connectTimeoutMs}ms`);
			socket.destroy();
		}, this.connectTimeoutMs);
		timer.unref?.();

		socket.once("connect", () => {
			clearTimeout(timer);
			// The bridge is now live; from here every teardown is the pump's.
			const bridge = new Bridge(peer, socket, this.ctx.logger, `${target.name} (${target.host}:${target.port})`);
			this.#bridges.add(bridge);
			// Both ends closing is the only end; drop the reference either way.
			const forget = () => this.#bridges.delete(bridge);
			socket.once("close", forget);
			peer.on("close", forget);
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			fail(String(error));
		});
	}

	/**
	 * Read one server's RFB greeting, then hang up.
	 *
	 * @param {string} host - Host to probe.
	 * @param {number} port - Port to probe.
	 * @returns {Promise<{ok: boolean, banner: string | null, error: string | null}>} the greeting, or why there was none.
	 */
	async probe(host, port) {
		return new Promise((resolve) => {
			const socket = connect({ host: String(host ?? ""), port: Number(port) });
			const finish = (result) => {
				clearTimeout(timer);
				socket.destroy();
				resolve(result);
			};
			const timer = setTimeout(
				() => finish({ ok: false, banner: null, error: `no RFB greeting within ${this.connectTimeoutMs}ms` }),
				this.connectTimeoutMs
			);
			timer.unref?.();
			socket.once("connect", () => {
				let received = "";
				socket.on("data", (chunk) => {
					received += chunk.toString("latin1");
					// An RFB server opens with its version, 12 bytes ending in \n.
					const newline = received.indexOf("\n");
					if (newline !== -1 || received.length >= 12) {
						finish({ ok: true, banner: received.slice(0, newline === -1 ? 12 : newline).trim(), error: null });
					}
				});
			});
			socket.once("error", (error) => finish({ ok: false, banner: null, error: String(error) }));
		});
	}
}

export { VncBridge, VncBridge as default, VncTargetsService };
