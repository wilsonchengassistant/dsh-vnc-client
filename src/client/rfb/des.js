/**
 * DES, for VNC authentication only.
 *
 * RFB's security type 2 sends a 16-byte challenge and expects it back
 * DES-encrypted under the shared password, so a client cannot get past an
 * ordinary password-protected server without DES. It is implemented here
 * because no runtime this plugin may rely on offers it: `node:crypto` dropped
 * DES to OpenSSL's legacy provider, and `WebCrypto` never had it. Only the
 * forward (encrypt) direction is implemented, which is the only one the
 * protocol uses.
 *
 * Correctness is not asserted by inspection. `test/des.test.mjs` checks this
 * implementation against the OpenSSL CLI over random keys and plaintexts, plus
 * the published FIPS known-answer vectors.
 */

/** Permuted choice 1: 64 key bits to 56. */
const PC1 = [
	57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
	10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
	63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
	14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4
];

/** Permuted choice 2: 56 rotated bits to a 48-bit subkey. */
const PC2 = [
	14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
	23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
	41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
	44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32
];

/** Left rotations applied to each half per round. */
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

/** Initial permutation. */
const IP = [
	58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
	62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
	57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
	61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7
];

/** Final permutation, the inverse of {@link IP}. */
const FP = [
	40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
	38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
	36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
	34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25
];

/** Expansion: 32 bits to 48. */
const EXPANSION = [
	32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9,
	8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
	16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
	24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1
];

/** Permutation applied to the S-box output. */
const PBOX = [
	16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
	2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25
];

/** The eight substitution boxes, each four rows of sixteen. */
const SBOXES = [
	[
		[14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7],
		[0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8],
		[4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0],
		[15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13]
	],
	[
		[15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10],
		[3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5],
		[0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15],
		[13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9]
	],
	[
		[10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8],
		[13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1],
		[13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7],
		[1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12]
	],
	[
		[7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15],
		[13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9],
		[10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4],
		[3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14]
	],
	[
		[2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9],
		[14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6],
		[4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14],
		[11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3]
	],
	[
		[12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11],
		[10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8],
		[9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6],
		[4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13]
	],
	[
		[4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1],
		[13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6],
		[1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2],
		[6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12]
	],
	[
		[13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7],
		[1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2],
		[7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8],
		[2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11]
	]
];

/**
 * Apply one permutation table to a bit array.
 *
 * @param {number[]} bits - Input bits, most significant first.
 * @param {readonly number[]} table - 1-based positions to take, in order.
 * @returns {number[]} the permuted bits.
 */
function permute(bits, table) {
	const out = new Array(table.length);
	for (let index = 0; index < table.length; index++) out[index] = bits[table[index] - 1];
	return out;
}

/**
 * Expand a byte array into its bits, most significant bit first.
 *
 * @param {Uint8Array} bytes - Bytes to expand.
 * @returns {number[]} 8 bits per byte.
 */
function bytesToBits(bytes) {
	const bits = new Array(bytes.length * 8);
	for (let index = 0; index < bytes.length; index++) {
		for (let bit = 0; bit < 8; bit++) bits[index * 8 + bit] = (bytes[index] >> (7 - bit)) & 1;
	}
	return bits;
}

/**
 * Pack a bit array back into bytes, most significant bit first.
 *
 * @param {number[]} bits - Bits to pack.
 * @returns {Uint8Array} the bytes.
 */
function bitsToBytes(bits) {
	const bytes = new Uint8Array(bits.length >> 3);
	for (let index = 0; index < bits.length; index++) {
		if (bits[index] !== 0) bytes[index >> 3] |= 0x80 >> index % 8;
	}
	return bytes;
}

/**
 * Build the sixteen 48-bit round subkeys for one 8-byte key.
 *
 * @param {Uint8Array} key - Eight key bytes; parity bits are ignored by DES.
 * @returns {number[][]} sixteen subkeys as bit arrays.
 */
function schedule(key) {
	const keyBits = permute(bytesToBits(key), PC1);
	const left = keyBits.slice(0, 28);
	const right = keyBits.slice(28, 56);
	const subkeys = [];
	for (let round = 0; round < 16; round++) {
		for (let step = 0; step < SHIFTS[round]; step++) {
			left.push(left.shift());
			right.push(right.shift());
		}
		subkeys.push(permute(left.concat(right), PC2));
	}
	return subkeys;
}

/**
 * Substitute one 6-bit group through its S-box.
 *
 * @param {number} box - Which S-box, 0 through 7.
 * @param {number[]} bits - Six bits.
 * @returns {number[]} The four substituted bits.
 */
function substitute(box, bits) {
	const row = (bits[0] << 1) | bits[5];
	const column = (bits[1] << 3) | (bits[2] << 2) | (bits[3] << 1) | bits[4];
	const value = SBOXES[box][row][column];
	return [(value >> 3) & 1, (value >> 2) & 1, (value >> 1) & 1, value & 1];
}

/**
 * Encrypt one 8-byte block with an already-expanded key schedule.
 *
 * @param {Uint8Array} block - Eight plaintext bytes.
 * @param {number[][]} subkeys - Round keys from {@link schedule}.
 * @returns {Uint8Array} Eight ciphertext bytes.
 */
function encryptBlock(block, subkeys) {
	let state = permute(bytesToBits(block), IP);
	let left = state.slice(0, 32);
	let right = state.slice(32, 64);

	for (let round = 0; round < 16; round++) {
		const expanded = permute(right, EXPANSION);
		const mixed = expanded.map((bit, index) => bit ^ subkeys[round][index]);

		const substituted = [];
		for (let box = 0; box < 8; box++) {
			for (const bit of substitute(box, mixed.slice(box * 6, box * 6 + 6))) substituted.push(bit);
		}

		const permuted = permute(substituted, PBOX);
		const previousRight = right;
		right = permuted.map((bit, index) => bit ^ left[index]);
		left = previousRight;
	}

	return bitsToBytes(permute(right.concat(left), FP));
}

/**
 * Encrypt a block in ECB mode, with no padding and no chaining.
 *
 * @param {Uint8Array} key - Eight key bytes.
 * @param {Uint8Array} block - Eight plaintext bytes.
 * @returns {Uint8Array} Eight ciphertext bytes.
 */
export function desEncryptBlock(key, block) {
	return encryptBlock(block, schedule(key));
}

/**
 * Reverse the bit order of every byte.
 *
 * VNC keys are stored with each byte's bits reversed, so a password typed as
 * "secret" becomes its bit-mirrored form before DES sees it. This is the
 * single most commonly missed step in VNC authentication.
 *
 * @param {Uint8Array} bytes - Bytes to mirror.
 * @returns {Uint8Array} the mirrored bytes.
 */
export function mirrorBytes(bytes) {
	const out = new Uint8Array(bytes.length);
	for (let index = 0; index < bytes.length; index++) {
		const value = bytes[index];
		out[index] =
			((value & 0x80) >> 7) |
			((value & 0x40) >> 5) |
			((value & 0x20) >> 3) |
			((value & 0x10) >> 1) |
			((value & 0x08) << 1) |
			((value & 0x04) << 3) |
			((value & 0x02) << 5) |
			((value & 0x01) << 7);
	}
	return out;
}

/**
 * Answer a VNC authentication challenge.
 *
 * @param {Uint8Array} challenge - The server's 16-byte challenge.
 * @param {string} password - The shared password, truncated to 8 bytes.
 * @returns {Uint8Array} The 16-byte response.
 */
export function vncAuthResponse(challenge, password) {
	// The password is truncated to 8 bytes, zero-padded, and bit-mirrored.
	const raw = new Uint8Array(8);
	for (let index = 0; index < 8; index++) {
		const code = password.charCodeAt(index);
		raw[index] = index < password.length && Number.isFinite(code) ? code & 0xff : 0;
	}
	const key = mirrorBytes(raw);
	const subkeys = schedule(key);

	const response = new Uint8Array(16);
	for (let block = 0; block < 2; block++) {
		const encrypted = encryptBlock(challenge.subarray(block * 8, block * 8 + 8), subkeys);
		response.set(encrypted, block * 8);
	}
	return response;
}
