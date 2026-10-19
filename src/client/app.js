/**
 * VNC client, browser half.
 *
 * The body of the module factory that becomes `lib/client.js`. The wrapper
 * around it, and the inlining of the modules listed in `scripts/build.mjs`,
 * are that script's job: this file stays a plain ES module so it can be
 * read, diffed and linted like everything else.
 *
 * Contributes a tab type to the right Sidebar and a configuration page to
 * Settings → Plugins. The Sidebar owns the panel that slides in from the
 * right, and this plugin fills a tab in it, which is the same relationship the
 * built-in Files and Preview tabs have.
 */

var module = { exports: {} };
var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var react = require("react");
var react_jsx_runtime = require("react/jsx-runtime");

var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
	var react = require("react");
	var react_jsx_runtime = require("react/jsx-runtime");

	/**
	/**
	 * Call one Host method over the ordinary `/api` RPC channel.
	 *
	 * Two details the channel insists on, both learned from the wire rather
	 * than from the type signatures:
	 *
	 * - A method that declares no parameter takes `args: {}`. Handing one a
	 *   `request` field is rejected as an unexpected argument.
	 * - `rpc.call` resolves with a result envelope, `{ ok, value }`, not the
	 *   value, and a refusal arrives as a resolved promise rather than a
	 *   rejection. Unwrapping belongs here so callers can treat a refused call
	 *   like any other failed promise.
	 *
	 * @param {object} ctx - Client context carrying the connection carrier.
	 * @param {string} method - Method name, without the service namespace.
	 * @param {object | undefined} request - The argument, or undefined when the method takes none.
	 * @returns {Promise<object>} the method's result.
	 */
	function callHost(ctx, method, request) {
		var args = request === undefined ? {} : { request: request };
		return ctx.connection.rpc.call("/api", "vnc/" + method, { args: args }).then(function (result) {
			if (result === undefined || result.ok !== true) {
				var failure = new Error((result && result.error && result.error.message) || "the host refused vnc/" + method);
				failure.code = result && result.error ? result.error.code : undefined;
				throw failure;
			}
			return result.value;
		});
	}

	/**
	 * Build the WebSocket URL for one saved server.
	 *
	 * The base comes from the injected transport when there is one — the
	 * desktop app serves from a custom scheme and has to say where its Host
	 * is — and from the document otherwise.
	 *
	 * @param {string} targetId - Which saved server to reach.
	 * @returns {string} the absolute WebSocket URL.
	 */
	function bridgeUrl(targetId) {
		var base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI;
		var url = new URL("api/vnc/bridge", base);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("target", targetId);
		return url.href;
	}

	/**
	 * Fit the framebuffer into the space the panel currently has.
	 *
	 * @param {{width: number, height: number}} frame - Framebuffer size.
	 * @param {{width: number, height: number}} box - Available space.
	 * @param {boolean} fit - Whether to scale down to fit.
	 * @returns {{width: number, height: number, scale: number}} the drawn size.
	 */
	function fitFrame(frame, box, fit) {
		if (frame.width === 0 || frame.height === 0 || box.width === 0 || box.height === 0) {
			return { width: 0, height: 0, scale: 1 };
		}
		if (!fit) return { width: frame.width, height: frame.height, scale: 1 };
		var scale = Math.min(box.width / frame.width, box.height / frame.height, 1);
		return { width: Math.floor(frame.width * scale), height: Math.floor(frame.height * scale), scale: scale };
	}

	/** The tab kind this package owns. */
	var VNC_KIND = "vnc";
	/** This implementation's identity, and the key its body registers under. */
	var VNC_ID = "dsh-vnc-client";

	/**
	 * Open a session against one saved server.
	 *
	 * The password arrives over the RPC channel rather than the URL: a
	 * request URL is the one part of this path that gets logged.
	 *
	 * @param {object} ctx - Client context, for the RPC carrier.
	 * @param {object} target - The saved server to connect to.
	 * @param {HTMLCanvasElement} canvas - Framebuffer canvas.
	 * @param {HTMLCanvasElement} cursorCanvas - Cursor canvas.
	 * @param {object} handlers - Event callbacks for the UI.
	 * @returns {Promise<object>} the session handle.
	 */
	async function openSession(ctx, target, canvas, cursorCanvas, handlers) {
		var socket = new WebSocket(bridgeUrl(target.id));
		socket.binaryType = "arraybuffer";

		// Listen before the first await, and hold what arrives until the RFB
		// client exists to decode it. RFB is server-initiated: a server sends
		// its version banner the instant the socket opens, so a listener added
		// after awaiting the credentials discards that banner and then waits
		// forever for a greeting that already went by.
		var pending = [];
		var deliver = null;
		var ended = false;
		socket.addEventListener("message", function (event) {
			var bytes = new Uint8Array(event.data);
			if (deliver === null) pending.push(bytes);
			else deliver(bytes);
		});
		socket.addEventListener("close", function () {
			ended = true;
		});

		var credentials = await Promise.all([
			callHost(ctx, "resolveTarget", { id: target.id }),
			new Promise(function (resolve, reject) {
				var timer = setTimeout(function () {
					reject(new Error("timed out connecting to the bridge"));
				}, 15000);
				socket.addEventListener("open", function () {
					clearTimeout(timer);
					resolve();
				});
				socket.addEventListener("error", function () {
					clearTimeout(timer);
					reject(new Error("the bridge could not be reached"));
				});
			})
		]);
		var resolved = credentials[0];

		var state = { closed: false };
		var transport = {
			send: function (bytes) {
				if (socket.readyState === WebSocket.OPEN) socket.send(bytes);
			},
			close: function () {
				state.closed = true;
				socket.close();
			},
			onData: function () {},
			onClose: function () {}
		};

		var client = new RfbClient(transport, canvas, cursorCanvas, Object.assign({}, handlers, {
			onStatus: function (status) {
				if (status.kind === "closed" || status.kind === "error") state.closed = true;
				handlers.onStatus?.(status);
			}
		}));

		deliver = function (bytes) {
			transport.onData(bytes);
		};
		socket.addEventListener("close", function () {
			state.closed = true;
			ended = true;
			transport.onClose();
		});
		// Hand over whatever the server said while the credentials were in
		// flight, then let the socket drive.
		var buffered = pending.splice(0, pending.length);
		client.connect(resolved.password);
		for (var index = 0; index < buffered.length; index++) deliver(buffered[index]);
		if (ended) transport.onClose();
		return {
			client: client,
			get closed() {
				return state.closed || socket.readyState === WebSocket.CLOSED;
			},
			close: function () {
				state.closed = true;
				client.dispose();
				socket.close();
			}
		};
	}

	/** Styles for the tab body. */
	var tabCss = {
		panel: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0 },
		bar: {
			display: "flex",
			alignItems: "center",
			gap: 8,
			flex: "none",
			padding: "8px 12px",
			borderBottom: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))",
			flexWrap: "wrap"
		},
		select: {
			minWidth: 120,
			maxWidth: 220,
			padding: "4px 6px",
			font: "inherit",
			color: "var(--dsw-alias-label-primary, inherit)",
			background: "var(--dsw-alias-bg-layer-2, transparent)",
			border: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))",
			borderRadius: 6
		},
		stage: {
			position: "relative",
			flex: "auto",
			minHeight: 0,
			minWidth: 0,
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			overflow: "hidden",
			background: "var(--dsw-alias-bg-document-preview, #101010)",
			outline: "none"
		},
		canvas: { display: "block", imageRendering: "pixelated", touchAction: "none" },
		cursor: { position: "absolute", pointerEvents: "none", imageRendering: "auto" },
		overlay: {
			position: "absolute",
			inset: 0,
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			flexDirection: "column",
			gap: 12,
			padding: 24,
			textAlign: "center",
			color: "var(--dsw-alias-label-secondary, #ccc)"
		},
		clipboard: { position: "absolute", opacity: 0, pointerEvents: "none", width: 1, height: 1, left: 0, top: 0 },
		footer: {
			flex: "none",
			padding: "6px 12px",
			fontSize: 12,
			color: "var(--dsw-alias-label-tertiary, #888)",
			borderTop: "0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))",
			display: "flex",
			gap: 12,
			alignItems: "center",
			justifyContent: "space-between"
		},
		spacer: { flex: "auto" }
	};

	/**
	 * The tab body: a live desktop in the sidebar panel.
	 *
	 * @param {object} props - Injected shares and the owner's context.
	 * @returns {object} the tab body.
	 */
	function VncBody(props) {
		var t = props.t;
		var ctx = props.ctx;

		var canvasRef = react.useRef(null);
		var cursorRef = react.useRef(null);
		var stageRef = react.useRef(null);
		var clipboardRef = react.useRef(null);
		var sessionRef = react.useRef(null);

		// The saved list is fetched by this component rather than handed to it:
		// the injected face carries the locale and the context, and a copy passed
		// as a prop would go stale the moment the settings page changed it.
		var targetsState = react.useState([]);
		var targets = targetsState[0];
		var setTargets = targetsState[1];
		var selectedState = react.useState(targets.length > 0 ? targets[0].id : "");
		var selected = selectedState[0];
		var setSelected = selectedState[1];
		var statusState = react.useState({ kind: "idle" });
		var status = statusState[0];
		var setStatus = statusState[1];
		var frameState = react.useState({ width: 0, height: 0 });
		var frame = frameState[0];
		var setFrame = frameState[1];
		var boxState = react.useState({ width: 0, height: 0 });
		var box = boxState[0];
		var setBox = boxState[1];
		var fitState = react.useState(true);
		var fit = fitState[0];
		var setFit = fitState[1];
		var cursorState = react.useState(null);
		var cursorAt = cursorState[0];
		var setCursorAt = cursorState[1];
		var buttonsState = react.useState(0);
		var buttons = buttonsState[0];
		var setButtons = buttonsState[1];
		var heldButtons = react.useRef(0);

		/**
		 * Record which buttons are down and send that to the server.
		 *
		 * The ref is written before the send so a re-render triggered by the
		 * state update cannot leave the release sending a stale mask.
		 *
		 * @param {number} mask - Bitmask of buttons now held.
		 * @param {object | null} event - The pointer event, for its position.
		 * @returns {void}
		 */
		function pressButtons(mask, event) {
			heldButtons.current = mask;
			setButtons(mask);
			if (event) sendPointer(event, mask);
		}
		var scaleState = react.useState(1);
		var scaleTick = scaleState[0];
		var setScaleTick = scaleState[1];

		var session = sessionRef.current;
		var live = session !== null && !session.closed;
		var target = targets.find(function (entry) {
			return entry.id === selected;
		}) ?? null;

		// Follow the panel: a sidebar the user resizes changes the space the
		// desktop has to fit into, and without this the canvas keeps the
		// dimensions it had when the session opened.
		react.useEffect(function () {
			var stage = stageRef.current;
			if (stage === null) return;
			var observer = new ResizeObserver(function (entries) {
				var entry = entries[0];
				if (entry === undefined) return;
				setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
			});
			observer.observe(stage);
			return function () {
				observer.disconnect();
			};
		}, []);

		// Re-read the saved list when the settings page changes it, and keep
		// the selection pointing at something that still exists.
		var reload = react.useCallback(async function () {
			try {
				var next = await callHost(ctx, "listTargets", undefined);
				setTargets(next);
				setSelected(function (current) {
					return next.some(function (entry) {
						return entry.id === current;
					})
						? current
						: (next[0]?.id ?? "");
				});
			} catch {
				/* the tab shows its own error state; nothing to do here */
			}
		}, [ctx]);

		react.useEffect(function () {
			void reload();
		}, [reload]);

		var disconnect = react.useCallback(function () {
			sessionRef.current?.close();
			sessionRef.current = null;
			setFrame({ width: 0, height: 0 });
			setCursorAt(null);
			setStatus({ kind: "idle" });
		}, []);

		var connect = react.useCallback(async function () {
			if (target === null) return;
			disconnect();
			setStatus({ kind: "connecting" });
			var canvas = canvasRef.current;
			var cursor = cursorRef.current;
			if (canvas === null || cursor === null) {
				setStatus({ kind: "error", message: t("state.notReady") });
				return;
			}
			try {
				var opened = await openSession(ctx, target, canvas, cursor, {
					onStatus: function (next) {
						setStatus(next);
						// `openSession` resolves as soon as the socket is up, and the
						// RFB handshake finishes after it, so reading the size off
						// the client here reports 0×0. The handshake's own status is
						// the one event that carries a size.
						if (typeof next.width === "number" && typeof next.height === "number") {
							setFrame({ width: next.width, height: next.height });
						}
					},
					onResize: function (width, height) {
						setFrame({ width: width, height: height });
					},
					onFrame: function () {
						setScaleTick(function (value) {
							return value + 1;
						});
					},
					onClipboard: function (text) {
						if (clipboardRef.current !== null) clipboardRef.current.value = text;
					},
					onBell: function () {}
				});
				sessionRef.current = opened;
			} catch (error) {
				setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
				sessionRef.current = null;
			}
		}, [target, ctx, disconnect]);

		// Close the socket when the panel unmounts, or the bridge keeps
		// pumping bytes for a desktop nobody is looking at.
		react.useEffect(function () {
			return function () {
				sessionRef.current?.close();
			};
		}, []);

		var drawn = fitFrame(frame, box, fit);

		/**
		 * Translate a pointer event into framebuffer coordinates.
		 *
		 * @param {object} event - The browser pointer event.
		 * @returns {{x: number, y: number}} framebuffer coordinates.
		 */
		function toFrame(event) {
			var canvas = canvasRef.current;
			if (canvas === null) return { x: 0, y: 0 };
			var bounds = canvas.getBoundingClientRect();
			if (bounds.width === 0 || bounds.height === 0) return { x: 0, y: 0 };
			return {
				x: Math.floor(((event.clientX - bounds.left) / bounds.width) * frame.width),
				y: Math.floor(((event.clientY - bounds.top) / bounds.height) * frame.height)
			};
		}

		/**
		 * Forward one pointer position and button state.
		 *
		 * @param {object} event - The browser pointer event.
		 * @param {number} mask - Which buttons are held.
		 * @returns {void}
		 */
		function sendPointer(event, mask) {
			var current = sessionRef.current;
			if (current === null || current.closed) return;
			var point = toFrame(event);
			current.client.movePointer(point.x, point.y, mask);
		}

		var statusText =
			status.kind === "connecting"
				? t("state.connecting")
				: status.kind === "error"
					? t("error.generic") + ": " + status.message
					: status.kind === "closed"
						? t("state.closed")
						: live
							? t("state.connected") + " · " + (session.client.name ?? "")
							: t("state.disconnected");

		return (0, react_jsx_runtime.jsx)("div", {
			style: tabCss.panel,
			children: [
				(0, react_jsx_runtime.jsx)("div", {
					style: tabCss.bar,
					children: [
						targets.length === 0
							? (0, react_jsx_runtime.jsx)("span", {
									style: { color: "var(--dsw-alias-label-tertiary, #888)" },
									children: t("bar.noTargets")
								})
							: (0, react_jsx_runtime.jsx)("select", {
									value: selected,
									"aria-label": t("bar.target"),
									style: tabCss.select,
									disabled: live,
									onChange: function (event) {
										setSelected(event.target.value);
									},
									children: targets.map(function (entry) {
										return (0, react_jsx_runtime.jsx)(
											"option",
											{ key: entry.id, value: entry.id, children: entry.name },
											entry.id
										);
									})
								}),
						live
							? (0, react_jsx_runtime.jsx)(primitives.Button, {
									size: "sm",
									variant: "outline",
									icon: (0, react_jsx_runtime.jsx)(primitives.IconCloseOutlineRegular, {}),
									onClick: disconnect,
									children: t("bar.disconnect")
								})
							: (0, react_jsx_runtime.jsx)(primitives.Button, {
									size: "sm",
									variant: "primary",
									icon: (0, react_jsx_runtime.jsx)(primitives.IconLinkOutlineRegular, {}),
									disabled: target === null,
									onClick: connect,
									children: t("bar.connect")
								}),
						(0, react_jsx_runtime.jsx)("div", { style: tabCss.spacer }),
						(0, react_jsx_runtime.jsx)(primitives.Button, {
							size: "sm",
							variant: "ghost",
							icon: (0, react_jsx_runtime.jsx)(primitives.IconFullscreenOutlineRegular, {}),
							disabled: !live,
							onClick: function () {
								stageRef.current?.requestFullscreen?.();
							},
							children: t("bar.fullscreen")
						}),
						(0, react_jsx_runtime.jsx)(primitives.Button, {
							size: "sm",
							variant: "ghost",
							disabled: !live,
							onClick: function () {
								setFit(function (value) {
									return !value;
								});
							},
							children: fit ? t("bar.actualSize") : t("bar.fit")
						})
					]
				}),
				(0, react_jsx_runtime.jsx)(StageView, {
					ref: stageRef,
					frame: frame,
					drawn: drawn,
					cursorAt: cursorAt,
					cursorRef: cursorRef,
					canvasRef: canvasRef,
					clipboardRef: clipboardRef,
					live: live,
					target: target,
					buttons: buttons,
					getSession: function () {
						return sessionRef.current;
					},
					setButtons: setButtons,
					heldButtons: heldButtons,
					setCursorAt: setCursorAt,
					toFrame: toFrame,
					t: t,
					sendPointer: sendPointer,
					reloadTargets: reload
				}),
				(0, react_jsx_runtime.jsx)("div", {
					style: tabCss.footer,
					children: [
						(0, react_jsx_runtime.jsx)("span", { children: statusText }),
						live
							? (0, react_jsx_runtime.jsx)("span", {
									children: frame.width + "×" + frame.height + " · " + Math.round(drawn.scale * 100) + "%"
								})
							: null
					]
				})
			]
		});
	}

	/**
	 * The area the desktop is drawn in: the framebuffer canvas, the server's
	 * cursor over it, and the hidden field that carries clipboard text.
	 *
	 * Its own component because the automatic runtime's jsx signature is
	 * (type, props, key): children passed as further arguments are discarded,
	 * so a subtree like this belongs behind a props object rather than a
	 * variadic call.
	 *
	 * @param {object} props - Refs, sizes and input handlers from the panel.
	 * @returns {object} the stage.
	 */
	function StageView(props) {
		/**
		 * The live session, read through the parent rather than captured, so a
		 * keyboard event that arrives between renders still finds the open one.
		 *
		 * @returns {object | null} the session, or null when none is open.
		 */
		function session() {
			var open = props.getSession();
			return open !== null && !open.closed ? open : null;
		}

		return (0, react_jsx_runtime.jsx)(
			"div",
			{
				ref: props.ref,
				style: tabCss.stage,
				tabIndex: 0,
				"data-vnc-stage": "true",
				onPointerDown: function (event) {
					if (event.button === 1) return;
					event.preventDefault();
					props.ref.current?.focus?.();
					var mask = RfbClient.buttonMask(event.button);
					props.setButtons(mask);
					props.heldButtons.current = mask;
					props.sendPointer(event, mask);
					try {
						event.currentTarget.setPointerCapture?.(event.pointerId);
					} catch {
						/* pointer capture is a nicety, not a requirement */
					}
				},
				onPointerMove: function (event) {
					props.sendPointer(event, props.heldButtons.current);
					props.setCursorAt(props.toFrame(event));
				},
				onPointerUp: function (event) {
					props.heldButtons.current = 0;
					props.setButtons(0);
					props.sendPointer(event, 0);
				},
				onPointerLeave: function (event) {
					props.heldButtons.current = 0;
					props.setButtons(0);
					props.sendPointer(event, 0);
				},
				onWheel: function (event) {
					var live = session();
					if (live === null || live.closed) return;
					event.preventDefault();
					live.client.sendScroll(event.deltaY < 0 ? 1 : -1);
				},
				onKeyDown: function (event) {
					var live = session();
					if (live === null || live.closed) return;
					if (event.target === props.clipboardRef.current) return;
					event.preventDefault();
					live.client.sendKey(event, true);
				},
				onKeyUp: function (event) {
					var live = session();
					if (live === null || live.closed) return;
					if (event.target === props.clipboardRef.current) return;
					event.preventDefault();
					live.client.sendKey(event, false);
				},
				onPaste: function (event) {
					var live = session();
					if (live === null || live.closed) return;
					var text = event.clipboardData?.getData("text");
					if (typeof text === "string" && text.length > 0) live.client.sendClipboard(text);
				},
				onContextMenu: function (event) {
					event.preventDefault();
				}
				,
				children: [
			(0, react_jsx_runtime.jsx)("div", {
				style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" },
				children: [
					(0, react_jsx_runtime.jsx)("canvas", {
						ref: props.canvasRef,
						width: props.frame.width,
						height: props.frame.height,
						"data-vnc-canvas": "true",
						style: Object.assign({}, tabCss.canvas, {
							width: props.drawn.width === 0 ? undefined : props.drawn.width,
							height: props.drawn.height === 0 ? undefined : props.drawn.height
						})
					}),
					(0, react_jsx_runtime.jsx)("canvas", {
						ref: props.cursorRef,
						style: Object.assign({}, tabCss.cursor, {
							left: props.cursorAt === null ? undefined : props.cursorAt.x * (props.drawn.width / Math.max(props.frame.width, 1)),
							top: props.cursorAt === null ? undefined : props.cursorAt.y * (props.drawn.height / Math.max(props.frame.height, 1)),
							// The server sends no cursor shape until it sends one, and
							// an unformed cursor should not appear as a stale shape.
							visibility: props.live && props.cursorRef.current !== null && props.cursorRef.current.width > 0 ? "visible" : "hidden"
						})
					}),
					props.live
						? null
						: (0, react_jsx_runtime.jsxs)("div", {
								style: tabCss.overlay,
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										children: props.target === null ? props.t("state.noTarget") : props.t("state.hint")
									}),
									(0, react_jsx_runtime.jsx)(primitives.Button, {
										size: "sm",
										variant: "ghost",
										onClick: function () {
											props.reloadTargets();
										},
										children: props.t("bar.manage")
									})
								]
							})
				]
			}),
			(0, react_jsx_runtime.jsx)("textarea", {
				ref: props.clipboardRef,
				style: tabCss.clipboard,
				"aria-label": props.t("bar.clipboard")
			})
				]
			}
		);
	}


	/** Styles for the configuration page. */
	var settingsCss = {
		page: { display: "flex", flexDirection: "column", gap: 16 },
		intro: { margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary, #888)" },
		section: {
			display: "flex",
			flexDirection: "column",
			gap: 10,
			padding: 12,
			border: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))",
			borderRadius: 12
		},
		heading: {
			margin: 0,
			fontSize: 12,
			letterSpacing: "0.06em",
			textTransform: "uppercase",
			color: "var(--dsw-alias-label-tertiary, #888)"
		},
		row: {
			display: "flex",
			alignItems: "center",
			gap: 8,
			padding: "8px 0",
			borderBottom: "0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))",
			flexWrap: "wrap"
		},
		name: { fontWeight: 600 },
		address: {
			color: "var(--dsw-alias-label-tertiary, #888)",
			fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)",
			fontSize: 12
		},
		badge: {
			fontSize: 11,
			padding: "1px 6px",
			borderRadius: 999,
			background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.16))",
			color: "var(--dsw-alias-label-tertiary, #888)"
		},
		spacer: { flex: "auto" },
		form: { display: "flex", flexDirection: "column", gap: 8 },
		field: { display: "flex", flexDirection: "column", gap: 4 },
		label: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #888)" },
		inputs: { display: "flex", gap: 8, flexWrap: "wrap" },
		status: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #888)" },
		error: { fontSize: 12, color: "var(--dsw-alias-state-error-primary, #c00)" },
		note: { margin: 0, fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary, #888)" }
	};

	/**
	 * An empty draft for the add form.
	 *
	 * @returns {object} the draft shape.
	 */
	function emptyDraft() {
		return { id: "", name: "", host: "", port: "5900", password: "" };
	}

	/**
	 * The plugin's configuration page: the saved servers, and the form that
	 * adds, edits, tests and removes them.
	 *
	 * @param {object} props - Injected shares and the owner's context.
	 * @returns {object} the page.
	 */
	function VncSettings(props) {
		// The host renders this entry through more than one path, and only some
		// of them carry the injected face. Falling back to the raw key keeps a
		// secondary pass from throwing over a missing translator and taking the
		// whole configuration page down with it.
		var t = typeof props.t === "function" ? props.t : function (key) { return key; };
		var ctx = props.ctx;

		var targetsState = react.useState([]);
		var targets = targetsState[0];
		var setTargets = targetsState[1];
		var draftState = react.useState(emptyDraft);
		var draft = draftState[0];
		var setDraft = draftState[1];
		var busyState = react.useState(false);
		var busy = busyState[0];
		var setBusy = busyState[1];
		var errorState = react.useState(null);
		var error = errorState[0];
		var setError = errorState[1];
		var noticeState = react.useState(null);
		var notice = noticeState[0];
		var setNotice = noticeState[1];
		var probeState = react.useState(null);
		var probe = probeState[0];
		var setProbe = probeState[1];

		var refresh = react.useCallback(async function () {
			try {
				setTargets(await callHost(ctx, "listTargets", undefined));
			} catch (failure) {
				setError(failure instanceof Error ? failure.message : String(failure));
			}
		}, [ctx]);

		react.useEffect(function () {
			void refresh();
		}, [refresh]);

		var submit = react.useCallback(
			async function (event) {
				event.preventDefault();
				setBusy(true);
				setError(null);
				setNotice(null);
				try {
					await callHost(ctx, "saveTarget", {
						id: draft.id === "" ? undefined : draft.id,
						name: draft.name,
						host: draft.host,
						port: Number.parseInt(draft.port, 10),
						password: draft.password === "" ? undefined : draft.password
					});
					setDraft(emptyDraft());
					setNotice(t("settings.saved"));
					await refresh();
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure));
				} finally {
					setBusy(false);
				}
			},
			[draft, ctx, refresh, t]
		);

		var remove = react.useCallback(
			async function (id) {
				setBusy(true);
				setError(null);
				try {
					await callHost(ctx, "removeTarget", { id: id });
					setNotice(t("settings.removed"));
					await refresh();
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure));
				} finally {
					setBusy(false);
				}
			},
			[ctx, refresh, t]
		);

		var test = react.useCallback(
			async function (id) {
				setProbe(null);
				setBusy(true);
				setError(null);
				try {
					var result = await callHost(ctx, "probeTarget", { id: id });
					setProbe(
						result.ok
							? t("settings.probe.ok", { banner: result.banner ?? "" })
							: t("settings.probe.failed") + ": " + (result.error ?? "")
					);
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure));
				} finally {
					setBusy(false);
				}
			},
			[ctx, t]
		);

		return (0, react_jsx_runtime.jsx)("div", {
			style: settingsCss.page,
			children: [
				(0, react_jsx_runtime.jsx)("p", { style: settingsCss.intro, children: t("settings.intro") }),
				(0, react_jsx_runtime.jsx)("div", {
					style: settingsCss.section,
					children: [
						(0, react_jsx_runtime.jsx)("h3", { style: settingsCss.heading, children: t("settings.list.title") }),
						targets.length === 0
							? (0, react_jsx_runtime.jsx)("div", {
									style: settingsCss.status,
									children: t("settings.list.empty")
								})
							: null,
						targets.map(function (entry) {
							return (0, react_jsx_runtime.jsx)(
								"div",
								{ key: entry.id, style: settingsCss.row },
								(0, react_jsx_runtime.jsx)("span", { style: settingsCss.name, children: entry.name }),
								(0, react_jsx_runtime.jsx)("span", {
									style: settingsCss.address,
									children: entry.host + ":" + entry.port
								}),
								(0, react_jsx_runtime.jsx)("span", {
									style: settingsCss.badge,
									children: entry.hasPassword ? t("settings.password.set") : t("settings.password.unset")
								}),
								(0, react_jsx_runtime.jsx)("div", { style: settingsCss.spacer }),
								(0, react_jsx_runtime.jsx)(primitives.Button, {
									size: "sm",
									variant: "ghost",
									disabled: busy,
									onClick: function () {
										void test(entry.id);
									},
									children: t("settings.probe")
								}),
								(0, react_jsx_runtime.jsx)(primitives.Button, {
									size: "sm",
									variant: "ghost",
									onClick: function () {
										setDraft({
											id: entry.id,
											name: entry.name,
											host: entry.host,
											port: String(entry.port),
											password: ""
										});
									},
									children: t("settings.editing")
								}),
								(0, react_jsx_runtime.jsx)(primitives.Button, {
									size: "sm",
									variant: "ghost",
									disabled: busy,
									onClick: function () {
										void remove(entry.id);
									},
									children: t("settings.remove")
								})
							);
						}),
						probe === null ? null : (0, react_jsx_runtime.jsx)("div", { style: settingsCss.status, children: probe })
					]
				}),
				(0, react_jsx_runtime.jsx)("div", {
					style: settingsCss.section,
					children: [
						(0, react_jsx_runtime.jsx)("h3", {
							style: settingsCss.heading,
							children: draft.id === "" ? t("settings.adding") : t("settings.editing")
						}),
						(0, react_jsx_runtime.jsx)(
							"form",
							{ style: settingsCss.form, onSubmit: submit },
							(0, react_jsx_runtime.jsx)("div", {
								style: settingsCss.field,
								children: [
									(0, react_jsx_runtime.jsx)("label", {
										style: settingsCss.label,
										children: t("settings.field.name")
									}),
									(0, react_jsx_runtime.jsx)(primitives.Input, {
										value: draft.name,
										required: true,
										onChange: function (event) {
											setDraft(Object.assign({}, draft, { name: event.target.value }));
										}
									})
								]
							}),
							(0, react_jsx_runtime.jsx)("div", {
								style: settingsCss.inputs,
								children: [
									(0, react_jsx_runtime.jsx)("div", {
										style: Object.assign({}, settingsCss.field, { flex: "3 1 220px" }),
										children: [
											(0, react_jsx_runtime.jsx)("label", {
												style: settingsCss.label,
												children: t("settings.field.host")
											}),
											(0, react_jsx_runtime.jsx)(primitives.Input, {
												value: draft.host,
												required: true,
												placeholder: "127.0.0.1",
												onChange: function (event) {
													setDraft(Object.assign({}, draft, { host: event.target.value }));
												}
											})
										]
									}),
									(0, react_jsx_runtime.jsx)("div", {
										style: Object.assign({}, settingsCss.field, { flex: "0 0 90px" }),
										children: [
											(0, react_jsx_runtime.jsx)("label", {
												style: settingsCss.label,
												children: t("settings.field.port")
											}),
											(0, react_jsx_runtime.jsx)(primitives.Input, {
												value: draft.port,
												inputMode: "numeric",
												required: true,
												style: { width: 90 },
												onChange: function (event) {
													setDraft(Object.assign({}, draft, { port: event.target.value }));
												}
											})
										]
									})
								]
							}),
							(0, react_jsx_runtime.jsx)("div", {
								style: settingsCss.field,
								children: [
									(0, react_jsx_runtime.jsx)("label", {
										style: settingsCss.label,
										children: t("settings.field.password")
									}),
									(0, react_jsx_runtime.jsx)(primitives.Input, {
										type: "password",
										autoComplete: "new-password",
										value: draft.password,
										onChange: function (event) {
											setDraft(Object.assign({}, draft, { password: event.target.value }));
										}
									}),
									(0, react_jsx_runtime.jsx)("span", {
										style: settingsCss.status,
										children: t("settings.field.password.hint")
									})
								]
							}),
							(0, react_jsx_runtime.jsx)("div", {
								style: settingsCss.inputs,
								children: [
									(0, react_jsx_runtime.jsx)(primitives.Button, {
										type: "submit",
										variant: "primary",
										size: "sm",
										disabled: busy,
										children: t("settings.save")
									}),
									draft.id === ""
										? null
										: (0, react_jsx_runtime.jsx)(primitives.Button, {
												type: "button",
												variant: "ghost",
												size: "sm",
												onClick: function () {
													setDraft(emptyDraft());
													setError(null);
												},
												children: t("settings.cancel")
											})
								]
							})
						)
					]
				}),
				(0, react_jsx_runtime.jsx)("p", { style: settingsCss.note, children: t("settings.privacy") }),
				error === null ? null : (0, react_jsx_runtime.jsx)("div", { style: settingsCss.error, role: "alert", children: error }),
				notice === null ? null : (0, react_jsx_runtime.jsx)("div", { style: settingsCss.status, role: "status", children: notice })
			]
		});
	}

	/**
	 * The tab type's registry definition.
	 *
	 * @param {Function} t - namespace-bound translate.
	 * @returns {object} the definition to register.
	 */
	function vncDefinition(t) {
		return {
			id: VNC_ID,
			kind: VNC_KIND,
			priority: "extension",
			title: function () {
				return t("tab.label");
			},
			guide: [
				{
					id: "remote-desktop",
					commandId: "workspace.vnc",
					order: 30,
					title: function () {
						return t("guide.title");
					},
					description: function () {
						return t("guide.description");
					},
					icon: primitives.IconGlobeOutlineRegular
				}
			]
		};
	}

	/** Services this half needs; the rest is reached through the slot system. */
	var inject = ["slots", "locale", "connection", "sidebarRightTabs", "sidebarRight"];

	/**
	 * Register the dictionaries, the tab and the two configuration seats.
	 *
	 * @param {object} ctx - Client root context.
	 * @returns {void}
	 */
	function apply(ctx) {
		var t = ctx.locale.bind(NS);

		ctx.effect(function () {
			return ctx.locale.register(NS, { zh: zh, en: en });
		}, "vnc-client: dictionaries");

		ctx.effect(function () {
			return ctx.sidebarRightTabs.register(vncDefinition(t));
		}, "vnc-client: tab type");

		/**
		 * The command the sidebar's guide entry dispatches.
		 *
		 * A guide entry that names a commandId the host has never been told
		 * about still renders, and does nothing when clicked — the guide has no
		 * other way to open a tab. So the entry and this registration are one
		 * feature, not two.
		 *
		 * No default key binding is declared on purpose: the guide is the
		 * affordance, and `workspace.vnc` shows up in the shortcut list for a
		 * user who wants to bind it. A plugin shipping a default binding would
		 * be claiming a chord on every user's machine for a tab they may never
		 * open.
		 */
		ctx.inject(["shortcuts"], function (shortcutCtx) {
			shortcutCtx.effect(function () {
				return shortcutCtx.shortcuts.register({
					id: "workspace.vnc",
					label: function () {
						return t("guide.title");
					},
					regions: ["page", "editable", "terminal"],
					modals: [],
					resolve: function (args) {
						var target = shortcutCtx.sidebarRight.commandTarget(args.target);
						if (target === undefined) {
							return { status: "blocked", reason: t("state.noTarget") };
						}
						return {
							status: "handled",
							run: function () {
								shortcutCtx.sidebarRight.openTabFromTarget(VNC_KIND, target);
							}
						};
					}
				});
			}, "vnc-client: guide command");
		});

		/**
		 * The shares both halves of the plugin's UI read.
		 *
		 * @returns {object} injected faces.
		 */
		function shared() {
			return {
				t: t,
				ctx: ctx
			};
		}

		ctx.slots.inject("sidebar.right.pane.tab", function () {
			return ctx.slots.register(
				{
					name: "sidebar.right.pane.tab",
					key: VNC_ID,
					locale: NS,
					inject: shared
				},
				VncBody
			);
		});

		// No title entry of our own: the tab registry renders the chip's text
		// from the definition, and a second component whose only job is to
		// hand the locale the same key is one more thing that can throw.

		// The plugin's own page in Settings → Plugins, keyed by this bundle's
		// package name, and a tab of its own in the same section for hosts
		// that render that section as tabs. Both seats are documented as
		// additive, so contributing both costs nothing and covers both.
		//
		// Each entry forwards the props it was rendered with: that object is
		// where the host puts the injected face, and passing `{}` instead
		// leaves the page without its locale function.
		if (typeof ctx.slots.inject === "function") {
			ctx.slots.inject("plugins.bundle.config", function () {
				return ctx.slots.register(
					{
						name: "plugins.bundle.config",
						key: VNC_ID,
						locale: NS,
						inject: shared
					},
					function (ownerProps) {
						return ownerProps?.view === "summary" ? null : (0, react_jsx_runtime.jsx)(VncSettings, ownerProps);
					}
				);
			});

			ctx.slots.inject("settings.plugins.tab", function () {
				return ctx.slots.register(
					{
						name: "settings.plugins.tab",
						id: NS,
						order: 70,
						label: function () {
							return t("settings.title");
						},
						locale: NS,
						inject: shared
					},
					function (ownerProps) {
						return (0, react_jsx_runtime.jsx)(VncSettings, ownerProps);
					}
				);
			});
		}
	}

	exports.inject = inject;
	exports.apply = apply;
	
return module.exports;
