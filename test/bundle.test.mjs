/**
 * The built browser bundle, checked the way the harness will load it.
 *
 * `lib/client.js` is served raw and evaluated, so the only question that
 * matters is whether running its factory registers what it claims to. A
 * packaging mistake — a missing require, a name the build script stripped, a
 * slot registered under the wrong key — is invisible to every other test and
 * fatal at boot, so it gets one of its own.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, "..", "lib", "client.js");

/**
 * Load the built bundle the way the harness's module loader does.
 *
 * @returns {Promise<object>} the module's exports.
 */
async function loadBundle() {
	const source = await readFile(bundlePath, "utf8");
	const registered = [];
	let moduleExports = undefined;
	const moduleLoader = {
		load(entry) {
			registered.push(entry.id);
			// The harness supplies React and the design-system primitives; the
			// bundle only needs them to exist to be evaluated.
			const stub = new Proxy(function () {}, {
				get: () => stub,
				apply: () => stub
			});
			const require_ = (name) => {
				if (name === "react") return { useState: () => [], useRef: () => ({ current: null }), useEffect: () => {}, useCallback: (fn) => fn };
				if (name === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null, Fragment: "Fragment" };
				return stub;
			};
			moduleExports = entry.factory(require_);
		}
	};
	const context = vm.createContext({ window: { __ModuleLoader__: moduleLoader }, globalThis: {}, console, URL, WebSocket, document: { baseURI: "http://127.0.0.1:3080/" } });
	vm.runInContext(source, context, { filename: "lib/client.js" });
	assert.deepEqual(registered, ["dsh-vnc-client"], "the bundle registers under its package name");
	return moduleExports;
}

test("the bundle evaluates and exposes the plugin contract", async () => {
	const exports = await loadBundle();
	assert.ok(Array.isArray(exports.inject), "the module declares what it injects");
	assert.equal(typeof exports.apply, "function", "the module declares how it applies");
	for (const service of ["slots", "locale", "connection", "sidebarRightTabs"]) {
		assert.ok(exports.inject.includes(service), `${service} is declared as a dependency`);
	}
});

test("applying the bundle registers the tab type and both configuration seats", async () => {
	const exports = await loadBundle();

	const registrations = [];
	const slotInjections = [];
	const effects = [];
	const shortcuts = [];
	let injectHandlerRan = false;

	const ctx = {
		locale: {
			bind: () => (key) => key,
			register: (ns, dictionaries) => {
				assert.equal(typeof dictionaries.en, "object");
				assert.equal(typeof dictionaries.zh, "object");
				// English is the copy that is checked against the Chinese keys.
				assert.deepEqual(
					Object.keys(dictionaries.en).sort(),
					Object.keys(dictionaries.zh).sort(),
					"the two dictionaries have the same keys"
				);
				return ns;
			}
		},
		slots: {
			inject(name, register) {
				slotInjections.push(name);
				slotInjections.push(register());
			},
			register(options, render) {
				registrations.push(Object.assign({}, options, { render: render }));
				return options;
			}
		},
		sidebarRightTabs: {
			register(definition) {
				registrations.push({ name: "tab-definition", definition });
				return () => {};
			}
		},
		connection: { rpc: { call: async () => ({ ok: true, value: [] }) } },
		shortcuts: {
			register(definition) {
				shortcuts.push(definition);
				return () => {};
			}
		},
		sidebarRight: {
			commandTarget: () => ({ kind: "test-target" }),
			openTabFromTarget: () => {}
		},
		// The plugin nests a scoped context for the shortcut, the way the
		// shipped sidebar plugins do.
		inject(names, handler) {
			assert.ok(Array.isArray(names), "the nested context asks for services by name");
			const scoped = Object.create(ctx);
			scoped.inject = ctx.inject;
			scoped.effect = ctx.effect;
			handler(scoped);
			injectHandlerRan = true;
		},
		effect(fn) {
			effects.push(fn);
			return fn();
		}
	};

	ctx.document = undefined;
	exports.apply(ctx);

	const definition = registrations.find((entry) => entry.name === "tab-definition");
	assert.ok(definition, "a tab type is registered");
	assert.equal(definition.definition.kind, "vnc");
	assert.equal(definition.definition.priority, "extension", "a third-party type declares itself an extension");
	assert.equal(typeof definition.definition.title(), "string");

	const tab = registrations.find((entry) => entry.name === "sidebar.right.pane.tab");
	assert.ok(tab, "the tab body is registered on the sidebar's own seat");
	assert.equal(tab.key, "dsh-vnc-client", "the body registers under the definition's id");
	assert.equal(typeof tab.render, "function");

	const bundleConfig = registrations.find((entry) => entry.name === "plugins.bundle.config");
	assert.ok(bundleConfig, "the plugin contributes its own page to Settings → Plugins");

	const settingsTab = registrations.find((entry) => entry.name === "settings.plugins.tab");
	assert.ok(settingsTab, "the plugin also contributes a tab inside the Plugins settings section");
	assert.equal(typeof settingsTab.label(), "string");

	assert.ok(slotInjections.includes("sidebar.right.pane.tab"));
	// The chip title comes from the definition, not from a second component.
	assert.ok(!slotInjections.includes("sidebar.right.pane.tab.title"), "no redundant title entry");
	assert.ok(effects.length >= 2, "dictionaries and the tab type are owned by effects");

	// The guide entry names a command; without this registration it renders
	// and does nothing when clicked.
	assert.ok(injectHandlerRan, "the guide command is registered");
	assert.equal(shortcuts.length, 1);
	assert.equal(shortcuts[0].id, "workspace.vnc");
	assert.equal(definition.definition.guide[0].commandId, "workspace.vnc", "the entry dispatches the command that exists");
	assert.equal(shortcuts[0].defaults, undefined, "no default key binding is claimed on the user's machine");

	const handled = shortcuts[0].resolve({ target: null });
	assert.equal(handled.status, "handled");
});

test("the host entry point is loadable Node ESM with its own imports present", async () => {
	// The harness imports the package's default export; a broken relative
	// import here is a boot-time failure for the whole plugin.
	const source = await readFile(join(here, "..", "lib", "index.js"), "utf8");
	assert.match(source, /export \{[^}]*\bas default\b/, "the host half has a default export");
	for (const name of ["websocket.js", "targets.js"]) {
		const imported = await readFile(join(here, "..", "lib", name), "utf8");
		assert.ok(imported.length > 0, `${name} was copied`);
	}
});

test("every design-system primitive this bundle names is one the host exports", async () => {
	// The primitives package exports each icon with an explicit size suffix.
	// A bare `IconLinkOutline` is undefined, and rendering it is React error
	// #130 in a sidebar tab rather than a missing icon anywhere near the cause.
	const source = await readFile(bundlePath, "utf8");
	const referenced = [...source.matchAll(/primitives\.([A-Za-z0-9]+)/g)].map((match) => match[1]);
	assert.ok(referenced.length > 0, "the bundle does use the design system");

	const known = new Set(["Button", "Input", "Checkbox", "Tooltip", "Modal", "ConnectionIndicator"]);
	const unverified = [...new Set(referenced)].filter((name) => !known.has(name));
	for (const name of unverified) {
		assert.match(
			name,
			/(Regular|Medium|Fill)$/u,
			`primitives.${name} has no size suffix; the host exports icons as …Regular or …Medium, ` +
				"and an unsuffixed name renders as React error #130"
		);
	}
});

test("the build rejects jsx calls React would silently render as nothing", async () => {
	// Both shapes fail silently in the browser and surface as a blank sidebar
	// tab, so the build has to refuse them. These cases keep that refusal honest
	// — a guard that rejects everything, or that the real bundle trips over, is
	// worse than no guard.
	const { rejectBadJsxCalls } = await import("../scripts/build.mjs");
	const rejects = (source) => {
		try {
			rejectBadJsxCalls(source);
			return false;
		} catch {
			return true;
		}
	};
	const cases = [
		["null props crash the render", '(0, react_jsx_runtime.jsx)(Icon, null)', true],
		["a trailing child becomes the key", '(0, react_jsx_runtime.jsx)("div", { s: 1 }, (0, react_jsx_runtime.jsx)("i", {}))', true],
		["braces inside a handler are fine", '(0, react_jsx_runtime.jsx)("div", { onClick: function (e) { go(); }, c: 1 })', false],
		["children in props are fine", '(0, react_jsx_runtime.jsxs)("div", { children: [1, 2] })', false],
		["nesting does not confuse it", '(0, react_jsx_runtime.jsx)("div", { children: [(0, react_jsx_runtime.jsx)(B, { i: (0, react_jsx_runtime.jsx)(C, {}) })] })', false]
	];
	for (const [name, source, shouldReject] of cases) {
		assert.equal(rejects(source), shouldReject, name);
	}
});
