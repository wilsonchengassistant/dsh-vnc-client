/**
 * DES correctness, checked against an independent implementation.
 *
 * Node's own `crypto` cannot be the oracle: OpenSSL 3 moved DES into its
 * legacy provider, so `createCipheriv("des-ecb", …)` throws. The OpenSSL CLI
 * with that provider loaded can, and it agrees with the published FIPS
 * known-answer vectors, which is what makes it a usable reference here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { desEncryptBlock, mirrorBytes, vncAuthResponse } from "../src/client/rfb/des.js";

/**
 * Encrypt one block with the OpenSSL CLI.
 *
 * @param {Buffer} key - Eight key bytes.
 * @param {Buffer} block - Eight plaintext bytes.
 * @returns {Buffer} the ciphertext.
 */
function opensslDes(key, block) {
	return execFileSync(
		"openssl",
		["enc", "-des-ecb", "-provider", "legacy", "-provider", "default", "-K", key.toString("hex"), "-nopad"],
		{ input: block, maxBuffer: 1024 }
	);
}

test("published FIPS known-answer vectors", () => {
	const vectors = [
		["0123456789abcdef", "4e6f772069732074", "3fa40e8a984d4815"],
		["0000000000000000", "0000000000000000", "8ca64de9c1b123a7"],
		["133457799bbcdff1", "0123456789abcdef", "85e813540f0ab405"]
	];
	for (const [key, plain, cipher] of vectors) {
		assert.equal(
			Buffer.from(desEncryptBlock(Buffer.from(key, "hex"), Buffer.from(plain, "hex"))).toString("hex"),
			cipher,
			`key ${key} / plaintext ${plain}`
		);
	}
});

test("agrees with OpenSSL over random keys and plaintexts", () => {
	for (let round = 0; round < 64; round++) {
		const key = randomBytes(8);
		const block = randomBytes(8);
		const mine = Buffer.from(desEncryptBlock(key, block)).toString("hex");
		const theirs = opensslDes(key, block).toString("hex");
		assert.equal(mine, theirs, `key ${key.toString("hex")} block ${block.toString("hex")}`);
	}
});

test("every byte value is a permutation when mirrored", () => {
	for (let value = 0; value < 256; value++) {
		const mirrored = mirrorBytes(Uint8Array.of(value))[0];
		assert.equal(mirrorBytes(Uint8Array.of(mirrored))[0], value, `byte ${value}`);
	}
});

test("mirroring reverses bit order", () => {
	assert.equal(mirrorBytes(Uint8Array.of(0b00000001))[0], 0b10000000);
	assert.equal(mirrorBytes(Uint8Array.of(0b10110010))[0], 0b01001101);
});

test("VNC auth response is two DES blocks under a mirrored key", () => {
	const password = "secret";
	const challenge = new Uint8Array(16);
	for (let index = 0; index < 16; index++) challenge[index] = index * 17;

	const response = vncAuthResponse(challenge, password);
	assert.equal(response.length, 16);

	// Recompute independently: mirror the padded password, then DES each block.
	const key = new Uint8Array([0x73, 0x65, 0x63, 0x72, 0x65, 0x74, 0, 0]);
	const mirrored = mirrorBytes(key);
	assert.deepEqual(
		Buffer.from(desEncryptBlock(mirrored, challenge.subarray(0, 8))).toString("hex"),
		Buffer.from(response.subarray(0, 8)).toString("hex")
	);
	assert.deepEqual(
		Buffer.from(desEncryptBlock(mirrored, challenge.subarray(8, 16))).toString("hex"),
		Buffer.from(response.subarray(8, 16)).toString("hex")
	);
});

test("a password longer than eight bytes is truncated, not wrapped", () => {
	const long = "abcdefghSECRET";
	const response = vncAuthResponse(new Uint8Array(16).fill(7), long);
	const expected = vncAuthResponse(new Uint8Array(16).fill(7), "abcdefgh");
	assert.deepEqual(Buffer.from(response), Buffer.from(expected));
});
