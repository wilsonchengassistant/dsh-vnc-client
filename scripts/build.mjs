/**
 * Assemble `lib/client.js` from the browser half's sources.
 *
 * The harness serves a client plugin as one classic script that registers a
 * factory through `window.__ModuleLoader__`, and that factory receives a
 * synchronous `require` for a fixed set of host-provided modules. That shape
 * rules out a plain ES module: there are no static imports inside a factory.
 *
 * So the sources are written as ordinary ES modules — readable, lintable, and
 * importable by the tests — and this script inlines them into that factory.
 * Each module keeps its own scope, so a name may repeat between modules without
 * colliding the way plain concatenation would make it.
 *
 * Deliberately dependency-free: a plugin that needs a working build before it
 * can be installed is a plugin nobody can install from a git clone.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/**
 * Modules inlined before the factory body, in dependency order.
 *
 * Order matters only for what runs at load time, which for these modules is a
 * few `const` tables and no calls; cross-module references inside function
 * bodies resolve when they are called.
 */
const MODULES = [
	"src/client/rfb/constants.js",
	"src/client/rfb/des.js",
	"src/client/rfb/reader.js",
	"src/client/rfb/display.js",
	"src/client/rfb/inflate.js",
	"src/client/rfb/encodings.js",
	"src/client/rfb/client.js",
	"src/client/locale.js"
];

/** The factory body, contributed last. */
const APP = "src/client/app.js";

/** The id the harness keys this module under. */
const MODULE_ID = "dsh-vnc-client";

/**
 * Import statements, which mean nothing once everything shares one scope.
 *
 * Matched against the whole source rather than line by line, because the
 * shipped style spreads a long import list over several lines.
 */
const IMPORT_STATEMENT = /^import\s[\s\S]*?from\s+["'][^"']+["'];[ \t]*\r?\n?/gm;
const BARE_IMPORT_STATEMENT = /^import\s+["'][^"']+["'];[ \t]*\r?\n?/gm;
const REEXPORT_STATEMENT = /^export\s*\{[^}]*\};[ \t]*\r?\n?/gm;

/**
 * Collect a module's exported names.
 *
 * @param {string} source - The module's text.
 * @returns {string[]} the names it exports, in declaration order.
 */
function exportedNames(source) {
	const names = [];
	const declared = /^export\s+(?:async\s+function|function|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm;
	let match;
	while ((match = declared.exec(source)) !== null) names.push(match[1]);

	const reexported = /^export\s*\{([^}]*)\}/gm;
	while ((match = reexported.exec(source)) !== null) {
		for (const part of match[1].split(",")) {
			const trimmed = part.trim();
			if (trimmed.length === 0) continue;
			const aliased = trimmed.split(/\s+as\s+/);
			names.push(aliased[1] ?? aliased[0]);
		}
	}
	return names;
}

/**
 * Turn one ES module into an IIFE that hands back its exports.
 *
 * @param {string} source - The module's text.
 * @param {string} label - Path, used in the generated region comments.
 * @param {number} slot - Index, so two modules never declare the same holder.
 * @returns {string} the wrapped module.
 */
function wrapModule(source, label, slot) {
	const holder = "__module_" + slot;
	const names = exportedNames(source);
	if (names.length === 0) throw new Error(label + " exports nothing, so there would be nothing to destructure");

	const body = [];
	const stripped = source
		.replace(IMPORT_STATEMENT, "")
		.replace(BARE_IMPORT_STATEMENT, "")
		.replace(REEXPORT_STATEMENT, "");
	for (const line of stripped.split("\n")) {
		// An `export` keyword has no meaning inside a function body, but the
		// declaration it introduces does.
		body.push(line.replace(/^export\s+/, ""));
	}
	if (/^import\s/m.test(stripped) || /^export\s*\{/m.test(stripped)) {
		throw new Error(label + " still contains a module statement after stripping");
	}

	const out = ["//#region " + label, "const " + holder + " = (() => {"];
	out.push(...body);
	out.push("return { " + names.join(", ") + " };");
	out.push("})();");
	out.push("const { " + names.join(", ") + " } = " + holder + ";");
	out.push("//#endregion " + label);
	return out.join("\n");
}

/**
 * Reject the two ways a hand-written jsx call silently renders nothing.
 *
 * React's automatic runtime is `jsx(type, props, key)`. It does not take
 * children as trailing arguments, and it reads `config.key` before anything
 * else, so:
 *
 * - `jsx(Component, null)` crashes the render outright.
 * - `jsx("div", props, childA, childB)` passes `childA` off as the element's
 *   key and drops the rest, leaving an empty element and no error at all.
 *
 * Both surface as a missing sidebar tab or a blank stage, far from the call
 * that caused them, which is why they are worth a build-time failure.
 *
 * @param {string} source - The factory body.
 * @returns {void}
 */
export function rejectBadJsxCalls(source) {
	const offenders = [];
	let index = 0;
	for (;;) {
		index = source.indexOf("react_jsx_runtime.jsx", index);
		if (index === -1) break;
		// `(0, react_jsx_runtime.jsx)(` — the argument list opens after the
		// second paren, not the first, or the sequence expression closes it.
		// The argument list opens at the paren itself, one past the match.
		const open = source.indexOf(")(", index);
		if (open === -1) break;
		let depth = 0;
		let cursor = open + 1;
		const topLevelCommas = [];
		for (; cursor < source.length; cursor++) {
			const character = source[cursor];
			if (character === "(" || character === "{" || character === "[") depth++;
			else if (character === ")" || character === "}" || character === "]") {
				depth--;
				if (depth === 0) break;
			} else if (character === "," && depth === 1) topLevelCommas.push(cursor);
		}
		if (topLevelCommas.length >= 1) {
			const firstComma = topLevelCommas[0];
			const props = source.slice(firstComma + 1, topLevelCommas[1] ?? cursor).trim();
			// One top-level comma is the type/props separator; a second means the
			// call has an argument React has no slot for.
			const tooMany = topLevelCommas.length >= 2;
			if (props === "null" || tooMany) {
				offenders.push(
					tooMany
						? source.slice(index, cursor + 1).replace(/\s+/g, " ").slice(0, 70)
						: `${props} as props`
				);
			}
		}
		index = cursor === -1 ? index + 1 : cursor;
	}
	if (offenders.length === 0) return;
	throw new Error(
		"the factory body has " + offenders.length + " jsx call(s) React would not render as written (" +
			offenders.slice(0, 2).join(" … ") +
			"): jsx(type, props, key) takes no trailing children and no null props — put children in props"
	);
}

/**
 * Build `lib/client.js`.
 *
 * @returns {Promise<void>} resolution once the file is written.
 */
async function build() {
	const parts = [];
	for (const path of MODULES) {
		const source = await readFile(join(root, path), "utf8");
		parts.push(wrapModule(source, path, parts.length));
	}

	const app = await readFile(join(root, APP), "utf8");
	const appBody = app.replace(/^return module\.exports;$/m, "").trimEnd();
	rejectBadJsxCalls(appBody);
	const sources = [...MODULES, APP].map((path) => relative(root, path)).join(", ");

	const bundle = [
		"/**",
		" * " + MODULE_ID + " — browser half.",
		" *",
		" * GENERATED by scripts/build.mjs from " + sources + ".",
		" * Edit those files, not this one.",
		" */",
		"window.__ModuleLoader__.load({",
		"\tid: " + JSON.stringify(MODULE_ID) + ",",
		"\tfactory(require) {",
		parts.join("\n\n"),
		"",
		appBody,
		"",
		"\t\treturn module.exports;",
		"\t}",
		"});",
		""
	].join("\n");

	const output = join(root, "lib/client.js");
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, bundle, "utf8");

	// The host half needs no bundling — it is plain Node ESM and its relative
	// imports work as they are — but the package's entry point is `lib/`, so
	// the files are copied there rather than shipping a second source tree.
	const HOST_FILES = ["index.js", "websocket.js", "targets.js"];
	for (const name of HOST_FILES) {
		const source = await readFile(join(root, "src/host", name), "utf8");
		await writeFile(join(root, "lib", name), source, "utf8");
	}

	process.stdout.write(
		"built " + relative(root, output) + " (" + bundle.length + " bytes) from " + (MODULES.length + 1) + " modules, and copied " + HOST_FILES.length + " host files\n"
	);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) await build();
