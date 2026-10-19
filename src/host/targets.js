/**
 * The saved VNC servers, persisted beside the Harness home.
 *
 * Passwords live here in cleartext, which is the same trade every VNC client
 * makes: RFB authenticates the password by DES-encrypting a server challenge
 * and cannot use a challenge/response scheme that a stored secret could not
 * satisfy. The file is therefore written 0600 inside the Harness home rather
 * than the user's project tree, and `listTargets` never returns the secret —
 * only whether one is set — so it cannot leak into the browser through the
 * ordinary settings render.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Directory under the Harness home holding this plugin's state. */
const STATE_DIR = ["vnc-client"];

/** File name inside that directory. */
const STATE_FILE = "targets.json";

/** Longest accepted display name, so one entry cannot bloat the file. */
const MAX_NAME_LENGTH = 120;

/** Longest accepted hostname or address. */
const MAX_HOST_LENGTH = 253;

/** Ports the bridge refuses, because connecting to them is never VNC. */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Reject a hostname or address that is not plausibly one.
 *
 * This is a shape check, not a security boundary — the value is only ever used
 * as the host argument of an outbound TCP connect, which resolves it itself.
 *
 * @param {unknown} host - Candidate host.
 * @returns {boolean} whether the value is an acceptable host.
 */
function isAcceptableHost(host) {
	if (typeof host !== "string") return false;
	const trimmed = host.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_HOST_LENGTH) return false;
	// Hostnames, IPv4 and bracketed IPv6 literals; no scheme, no path, no port
	// (the port is its own field, and a stray colon is nearly always a mistake).
	if (/[\s/\\@]/.test(trimmed)) return false;
	if (/^https?:/i.test(trimmed)) return false;
	return /^[A-Za-z0-9._:-]+$/.test(trimmed);
}

/**
 * Project one stored record into the wire shape the browser may see.
 *
 * The password is reduced to a boolean: the browser asks for it explicitly,
 * through {@link resolveTarget}, at the moment it opens a connection.
 *
 * @param {object} target - Stored record.
 * @returns {object} the safe projection.
 */
function publicTarget(target) {
	return {
		id: target.id,
		name: target.name,
		host: target.host,
		port: target.port,
		hasPassword: typeof target.password === "string" && target.password.length > 0
	};
}

/**
 * Reads and writes the saved server list.
 *
 * Every write is atomic (write a sibling temp file, then rename), because the
 * file holds the only copy of the user's passwords and a half-written one
 * after a crash would lose them.
 */
export class TargetStore {
	#path;
	#logger;

	/**
	 * @param {string} homePath - Harness home this store belongs to.
	 * @param {{warn: (message: string) => void}} logger - Host logger.
	 */
	constructor(homePath, logger) {
		this.#path = join(homePath, ...STATE_DIR, STATE_FILE);
		this.#logger = logger;
	}

	/** Absolute path of the backing file, for diagnostics. */
	get path() {
		return this.#path;
	}

	/**
	 * Read every saved target, or an empty list when the file is absent.
	 *
	 * A corrupt file is reported and treated as empty rather than thrown: a
	 * broken save must not stop the plugin from loading.
	 *
	 * @returns {Promise<object[]>} stored records.
	 */
	async readAll() {
		let text;
		try {
			text = await readFile(this.#path, "utf8");
		} catch (error) {
			if (error?.code === "ENOENT") return [];
			throw error;
		}
		try {
			const parsed = JSON.parse(text);
			if (!Array.isArray(parsed?.targets)) return [];
			return parsed.targets.filter((target) => typeof target?.id === "string");
		} catch (error) {
			this.#logger.warn(`vnc-client: ${this.#path} is not readable JSON, starting from an empty list: ${String(error)}`);
			return [];
		}
	}

	/**
	 * Replace the whole list atomically.
	 *
	 * @param {object[]} targets - Records to persist.
	 * @returns {Promise<void>} resolution once the new list is on disk.
	 */
	async writeAll(targets) {
		await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
		const temporary = `${this.#path}.${process.pid}.tmp`;
		// Create with restrictive permissions up front: writeFile's `mode` only
		// applies when it creates the file, and it would not tighten an existing
		// one, so an existing store is chmod-ed explicitly afterwards.
		await writeFile(temporary, `${JSON.stringify({ targets }, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, this.#path);
	}

	/**
	 * List every target without its password.
	 *
	 * @returns {Promise<object[]>} safe projections, in saved order.
	 */
	async list() {
		return (await this.readAll()).map(publicTarget);
	}

	/**
	 * Look one target up by id.
	 *
	 * @param {string} id - Target identity.
	 * @returns {Promise<object | undefined>} the stored record, if it exists.
	 */
	async find(id) {
		return (await this.readAll()).find((target) => target.id === id);
	}

	/**
	 * Create or update one target.
	 *
	 * An omitted `password` leaves the stored one alone, which is what lets the
	 * settings page round-trip a rename without ever seeing the secret. An
	 * empty string clears it.
	 *
	 * @param {object} request - `{id?, name, host, port, password?}`.
	 * @returns {Promise<object>} the saved target's safe projection.
	 */
	async save(request) {
		const name = typeof request?.name === "string" ? request.name.trim() : "";
		if (name.length === 0) throw new Error("a target needs a name");
		if (name.length > MAX_NAME_LENGTH) throw new Error(`a target name may be at most ${MAX_NAME_LENGTH} characters`);
		if (!isAcceptableHost(request?.host)) {
			throw new Error("a target needs a host: a hostname, IPv4 address, or IPv6 literal");
		}
		const port = request?.port;
		if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
			throw new Error(`a target needs a port between ${MIN_PORT} and ${MAX_PORT}`);
		}

		const targets = await this.readAll();
		const id = typeof request.id === "string" && request.id.length > 0 ? request.id : randomUUID();
		const existing = targets.find((target) => target.id === id);
		const password =
			request.password === undefined
				? existing?.password ?? ""
				: String(request.password);

		const record = { id, name, host: String(request.host).trim(), port, password };
		const index = targets.findIndex((target) => target.id === id);
		if (index === -1) targets.push(record);
		else targets[index] = record;
		await this.writeAll(targets);
		return publicTarget(record);
	}

	/**
	 * Delete one target.
	 *
	 * @param {string} id - Target identity.
	 * @returns {Promise<boolean>} whether a target was removed.
	 */
	async remove(id) {
		const targets = await this.readAll();
		const remaining = targets.filter((target) => target.id !== id);
		if (remaining.length === targets.length) return false;
		await this.writeAll(remaining);
		return true;
	}
}
