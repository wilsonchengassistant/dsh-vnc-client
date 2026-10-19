/**
 * Encoders for the tests, written the way a server would write them.
 *
 * These deliberately do not share code with the decoders: a test that encoded
 * with the same helper the decoder parses would pass even if both were wrong.
 * The Tight and ZRLE paths here follow the specification text directly, and
 * the ZRLE one uses a genuinely persistent deflate stream flushed per tile, so
 * the decoder's incremental read path is genuinely exercised.
 */

import { createDeflate, constants as zlibConstants } from "node:zlib";

/** Bytes in a TPIXEL/CPIXEL under the negotiated pixel format. */
const TPIXEL_BYTES = 3;

/** Tile edge in ZRLE. */
const ZRLE_TILE = 64;

/** A growable byte writer. */
export class Writer {
	#chunks = [];
	#length = 0;

	/** Bytes written so far. */
	get length() {
		return this.#length;
	}

	/**
	 * Append bytes.
	 *
	 * @param {Uint8Array | number[]} bytes - Bytes to append.
	 * @returns {Writer} this writer.
	 */
	bytes(bytes) {
		this.#chunks.push(Uint8Array.from(bytes));
		this.#length += bytes.length;
		return this;
	}

	/**
	 * Append one unsigned byte.
	 *
	 * @param {number} value - Value to append.
	 * @returns {Writer} this writer.
	 */
	u8(value) {
		return this.bytes([value & 0xff]);
	}

	/**
	 * Append one unsigned 16-bit big-endian value.
	 *
	 * @param {number} value - Value to append.
	 * @returns {Writer} this writer.
	 */
	u16(value) {
		return this.bytes([(value >> 8) & 0xff, value & 0xff]);
	}

	/**
	 * Append one unsigned 32-bit big-endian value.
	 *
	 * @param {number} value - Value to append.
	 * @returns {Writer} this writer.
	 */
	u32(value) {
		return this.bytes([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
	}

	/**
	 * Append a length in the protocol's compact form.
	 *
	 * @param {number} value - Length to append.
	 * @returns {Writer} this writer.
	 */
	compactLength(value) {
		if (value < 128) return this.u8(value);
		if (value < 16384) {
			return this.u8(0x80 | (value & 0x7f)).u8((value >> 7) & 0x7f);
		}
		return this.u8(0x80 | (value & 0x7f))
			.u8(0x80 | ((value >> 7) & 0x7f))
			.u8((value >> 14) & 0xff);
	}

	/** @returns {Uint8Array} everything written. */
	toBytes() {
		const out = new Uint8Array(this.#length);
		let offset = 0;
		for (const chunk of this.#chunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	}
}

/**
 * A deflate stream that persists across writes, the way a server's does.
 *
 * `finishFlush: Z_SYNC_FLUSH` is what makes each flush emit a decodable prefix
 * instead of waiting for an end-of-stream, which is exactly the property the
 * decoders depend on.
 */
export class PersistentDeflate {
	#deflate;
	#pending = [];
	#waiters = [];

	constructor() {
		this.#deflate = createDeflate({
			level: 6,
			finishFlush: zlibConstants.Z_SYNC_FLUSH
		});
		this.#deflate.on("data", (chunk) => {
			this.#pending.push(chunk);
			this.#release();
		});
	}

	/**
	 * Compress bytes and flush, returning what the flush emitted.
	 *
	 * @param {Uint8Array} bytes - Bytes to compress.
	 * @returns {Promise<Uint8Array>} the compressed output.
	 */
	async write(bytes) {
		const before = this.#take();
		void before;
		this.#deflate.write(Buffer.from(bytes));
		await new Promise((resolve) => this.#deflate.flush(zlibConstants.Z_SYNC_FLUSH, resolve));
		return this.#take();
	}

	/** Collect and clear the output buffered so far. */
	#take() {
		if (this.#pending.length === 0) return new Uint8Array(0);
		const out = Buffer.concat(this.#pending);
		this.#pending = [];
		return new Uint8Array(out);
	}

	/** Release any waiter, for streams that produce output asynchronously. */
	#release() {
		const waiter = this.#waiters.shift();
		if (waiter !== undefined) waiter();
	}
}

/**
 * Encode a rectangle as Raw.
 *
 * @param {object} rect - Rectangle geometry.
 * @param {Uint8Array} pixels - RGB bytes, three per pixel, row-major.
 * @returns {Uint8Array} the encoded rectangle.
 */
export function encodeRaw(rect, pixels) {
	const writer = new Writer();
	for (let row = 0; row < rect.height; row++) {
		const line = pixels.subarray(row * rect.width * 3, (row + 1) * rect.width * 3);
		for (let column = 0; column < rect.width; column++) {
			// The negotiated format is 32 bits per pixel in R,G,B,pad order.
			writer.bytes([line[column * 3], line[column * 3 + 1], line[column * 3 + 2], 0]);
		}
	}
	return writer.toBytes();
}

/**
 * Encode a rectangle as CopyRect.
 *
 * @param {object} rect - Rectangle geometry.
 * @param {number} sx - Source left.
 * @param {number} sy - Source top.
 * @returns {Uint8Array} the encoded rectangle.
 */
export function encodeCopyRect(rect, sx, sy) {
	return new Writer().u16(sx).u16(sy).toBytes();
}

/**
 * Encode a rectangle as one solid Hextile tile.
 *
 * @param {object} rect - Rectangle geometry.
 * @param {[number, number, number]} colour - The tile colour.
 * @returns {Uint8Array} the encoded rectangle.
 */
export function encodeHextileSolid(rect, colour) {
	const writer = new Writer();
	for (let tileY = 0; tileY < rect.height; tileY += 16) {
		for (let tileX = 0; tileX < rect.width; tileX += 16) {
			writer.u8(0x02).bytes(colour);
		}
	}
	return writer.toBytes();
}

/**
 * Encode a rectangle as Hextile with a coloured subrectangle.
 *
 * @param {object} rect - Rectangle geometry.
 * @param {[number, number, number]} background - Tile background.
 * @param {[number, number, number]} subColour - Subrectangle colour.
 * @returns {Uint8Array} the encoded rectangle.
 */
export function encodeHextileSubrect(rect, background, subColour) {
	const writer = new Writer();
	writer.u8(0x02 | 0x08 | 0x10).bytes(background);
	// A 2x2 subrectangle at the tile origin, then the end-of-subrects marker.
	writer.u8(((2 - 1) << 4) | (2 - 1)).bytes(subColour);
	writer.u8(0);
	return writer.toBytes();
}

/**
 * Encode a rectangle as Hextile raw subencoding.
 *
 * @param {object} rect - Rectangle geometry.
 * @param {Uint8Array} pixels - RGB bytes, three per pixel, row-major.
 * @returns {Uint8Array} the encoded rectangle.
 */
export function encodeHextileRaw(rect, pixels) {
	const writer = new Writer();
	for (let tileY = 0; tileY < rect.height; tileY += 16) {
		const tileHeight = Math.min(16, rect.height - tileY);
		for (let tileX = 0; tileX < rect.width; tileX += 16) {
			const tileWidth = Math.min(16, rect.width - tileX);
			writer.u8(0x01);
			for (let row = 0; row < tileHeight; row++) {
				for (let column = 0; column < tileWidth; column++) {
					const x = tileX + column;
					const y = tileY + row;
					const offset = (y * rect.width + x) * 3;
					writer.bytes([pixels[offset], pixels[offset + 1], pixels[offset + 2]]);
				}
			}
		}
	}
	return writer.toBytes();
}

/**
 * Encode a rectangle as Tight, using fill compression.
 *
 * @param {object} rect - Rectangle geometry.
 * @param {[number, number, number]} colour - The fill colour.
 * @returns {Uint8Array} the encoded rectangle.
 */
export function encodeTightFill(rect, colour) {
	const writer = new Writer();
	// 0x80 is FillCompression, with no stream resets.
	writer.u8(0x80).bytes(colour);
	return writer.toBytes();
}

/**
 * Encode a rectangle as Tight with a palette filter.
 *
 * @param {object} rect - Rectangle geometry.
 * @param {Array<[number, number, number]>} palette - The palette.
 * @param {Uint8Array} indices - One index per pixel, row-major.
 * @param {PersistentDeflate} stream - The persistent zlib stream to use.
 * @param {number} streamId - Which of the four streams this uses.
 * @param {boolean} reset - Whether to ask the decoder to reset first.
 * @returns {Promise<Uint8Array>} the encoded rectangle.
 */
export async function encodeTightPalette(rect, palette, indices, stream, streamId = 0, reset = false) {
	const writer = new Writer();

	// BasicCompression: bit 6 reads a filter id, bit 3 resets the palette,
	// bits 5-4 choose the stream.
	let control = (streamId << 4) | 0x40 | 0x08;
	if (reset) control |= 1 << streamId;
	writer.u8(control);
	writer.u8(1);
	writer.u8(palette.length - 1);
	for (const colour of palette) writer.bytes(colour);

	// A two-colour palette packs one bit per pixel, rows padded to a byte.
	let payload;
	if (palette.length === 2) {
		const stride = (rect.width + 7) >> 3;
		const packed = new Uint8Array(stride * rect.height);
		for (let row = 0; row < rect.height; row++) {
			for (let column = 0; column < rect.width; column++) {
				const index = indices[row * rect.width + column];
				packed[row * stride + (column >> 3)] |= index << (7 - (column & 7));
			}
		}
		payload = packed;
	} else {
		payload = Uint8Array.from(indices);
	}

	// The protocol requires data under twelve filtered bytes to be sent as is.
	if (payload.length < 12) {
		writer.bytes(payload);
		return writer.toBytes();
	}
	const compressed = await stream.write(payload);
	writer.compactLength(compressed.length);
	writer.bytes(compressed);
	return writer.toBytes();
}

/**
 * Encode a rectangle as Tight with the copy filter.
 *
 * @param {object} rect - Rectangle geometry.
 * @param {Uint8Array} pixels - RGB bytes, three per pixel, row-major.
 * @param {PersistentDeflate} stream - The persistent zlib stream to use.
 * @param {number} streamId - Which of the four streams this uses.
 * @returns {Promise<Uint8Array>} the encoded rectangle.
 */
export async function encodeTightCopy(rect, pixels, stream, streamId = 0) {
	const writer = new Writer();
	// CopyFilter is the default, so no filter id byte is written.
	writer.u8(streamId << 4);
	if (pixels.length < 12) {
		writer.bytes(pixels);
		return writer.toBytes();
	}
	const compressed = await stream.write(pixels);
	writer.compactLength(compressed.length);
	writer.bytes(compressed);
	return writer.toBytes();
}

/**
 * Encode a rectangle as Tight with the gradient filter.
 *
 * @param {object} rect - Rectangle geometry.
 * @param {Uint8Array} pixels - RGB bytes, three per pixel, row-major.
 * @param {PersistentDeflate} stream - The persistent zlib stream to use.
 * @returns {Promise<Uint8Array>} the encoded rectangle.
 */
export async function encodeTightGradient(rect, pixels, stream) {
	const writer = new Writer();
	writer.u8(0x40 | 0x08);
	writer.u8(2);

	const differences = gradientEncode(pixels, rect.width, rect.height);
	const compressed = await stream.write(differences);
	writer.compactLength(compressed.length);
	writer.bytes(compressed);
	return writer.toBytes();
}

/**
 * Difference-encode a rectangle the way the Tight gradient filter does.
 *
 * @param {Uint8Array} pixels - RGB bytes, three per pixel, row-major.
 * @param {number} width - Rectangle width.
 * @param {number} height - Rectangle height.
 * @returns {Uint8Array} the differences.
 */
export function gradientEncode(pixels, width, height) {
	const out = new Uint8Array(pixels.length);
	for (let row = 0; row < height; row++) {
		for (let column = 0; column < width; column++) {
			for (let component = 0; component < TPIXEL_BYTES; component++) {
				const at = (x, y) => (x < 0 || y < 0 ? 0 : pixels[(y * width + x) * 3 + component]);
				let predicted = at(column - 1, row) + at(column, row - 1) - at(column - 1, row - 1);
				if (predicted < 0) predicted = 0;
				if (predicted > 255) predicted = 255;
				const actual = pixels[(row * width + column) * 3 + component];
				out[(row * width + column) * 3 + component] = (actual - predicted) & 0xff;
			}
		}
	}
	return out;
}

/**
 * Encode a rectangle as ZRLE, using a chosen subencoding per tile.
 *
 * @param {object} rect - Rectangle geometry.
 * @param {Uint8Array} pixels - RGB bytes, three per pixel, row-major.
 * @param {(tile: {x: number, y: number, width: number, height: number}) => Uint8Array} tileEncoder - Writes one tile.
 * @param {PersistentDeflate} stream - The persistent zlib stream.
 * @returns {Promise<Uint8Array>} the encoded rectangle.
 */
export async function encodeZrle(rect, pixels, tileEncoder, stream) {
	const writer = new Writer();

	const body = new Writer();
	for (let tileY = 0; tileY < rect.height; tileY += ZRLE_TILE) {
		for (let tileX = 0; tileX < rect.width; tileX += ZRLE_TILE) {
			const tile = {
				x: tileX,
				y: tileY,
				width: Math.min(ZRLE_TILE, rect.width - tileX),
				height: Math.min(ZRLE_TILE, rect.height - tileY)
			};
			body.bytes(tileEncoder({ ...tile, rectWidth: rect.width }));
		}
	}

	const compressed = await stream.write(body.toBytes());
	writer.u32(compressed.length);
	writer.bytes(compressed);
	return writer.toBytes();
}

/** A ZRLE tile holding raw CPIXELs. */
export function zrleTileRaw(pixels, tile, rectWidth) {
	const writer = new Writer();
	writer.u8(0);
	for (let row = 0; row < tile.height; row++) {
		for (let column = 0; column < tile.width; column++) {
			const offset = ((tile.y + row) * rectWidth + (tile.x + column)) * 3;
			writer.bytes([pixels[offset], pixels[offset + 1], pixels[offset + 2]]);
		}
	}
	return writer.toBytes();
}

/** A ZRLE tile of one solid colour. */
export function zrleTileSolid(colour) {
	return new Writer().u8(1).bytes(colour).toBytes();
}

/**
 * A ZRLE tile of packed palette indices.
 *
 * @param {Array<[number, number, number]>} palette - The palette.
 * @param {Uint8Array} indices - One index per pixel, row-major.
 * @param {{x: number, y: number, width: number, height: number}} tile - Tile geometry.
 * @returns {Uint8Array} the encoded tile.
 */
export function zrleTilePackedPalette(palette, indices, tile) {
	const writer = new Writer();
	writer.u8(palette.length);
	for (const colour of palette) writer.bytes(colour);
	const bits = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : 4;
	const stride = bits === 1 ? (tile.width + 7) >> 3 : bits === 2 ? (tile.width + 3) >> 2 : (tile.width + 1) >> 1;
	for (let row = 0; row < tile.height; row++) {
		const line = new Uint8Array(stride);
		for (let column = 0; column < tile.width; column++) {
			const index = indices[row * tile.width + column];
			const shift = bits === 1 ? 7 - (column & 7) : bits === 2 ? 6 - (column & 3) : 4 - (column & 1);
			line[Math.floor((column * bits) / 8)] |= index << shift;
		}
		writer.bytes(line);
	}
	return writer.toBytes();
}

/**
 * A ZRLE tile of palette runs.
 *
 * @param {Array<[number, number, number]>} palette - The palette.
 * @param {{index: number, length: number}[]} runs - The runs, in order.
 * @returns {Uint8Array} the encoded tile.
 */
export function zrleTilePaletteRle(palette, runs) {
	const writer = new Writer();
	writer.u8(128 + palette.length);
	for (const colour of palette) writer.bytes(colour);
	for (const run of runs) {
		if (run.length === 1) {
			writer.u8(run.index);
			continue;
		}
		writer.u8(run.index | 0x80);
		writeRunLength(writer, run.length);
	}
	return writer.toBytes();
}

/**
 * A ZRLE tile of plain runs.
 *
 * @param {[number, number, number]} colour - The run colour.
 * @param {number} total - Total pixels the tile covers.
 * @returns {Uint8Array} the encoded tile.
 */
export function zrleTilePlainRle(colour, total) {
	const writer = new Writer();
	writer.u8(128).bytes(colour);
	writeRunLength(writer, total);
	return writer.toBytes();
}

/**
 * Write a run length in the protocol's escaping form.
 *
 * @param {Writer} writer - Writer to append to.
 * @param {number} length - The run length.
 * @returns {void}
 */
function writeRunLength(writer, length) {
	let remaining = length - 1;
	while (remaining >= 255) {
		writer.u8(255);
		remaining -= 255;
	}
	writer.u8(remaining);
}
