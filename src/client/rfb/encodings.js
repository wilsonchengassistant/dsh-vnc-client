/**
 * Rectangle decoders.
 *
 * Each function reads one rectangle off `reader` and paints it into `surface`.
 * They are written against the pixel format this client negotiates (32 bits
 * per pixel, depth 24, eight bits per channel), which the protocol allows a
 * server to assume whenever those conditions hold: that is what makes a
 * `TPIXEL` and a `CPIXEL` three bytes instead of four, and what lets Raw
 * rectangles be copied rather than swizzled.
 *
 * What is deliberately not here: RRE, CoRRE, zlibhex, Ultra, Ultra2, the
 * Open H.264 family, and Tight's JPEG and PNG modes. None are advertised, so
 * a conforming server will not send them.
 */

import { Reader, RfbTruncated } from "./reader.js";
import { PersistentZlib } from "./inflate.js";

/** Hextile subencoding bits. */
const HEXTILE_RAW = 0x01;
const HEXTILE_BACKGROUND = 0x02;
const HEXTILE_FOREGROUND = 0x04;
const HEXTILE_ANY_SUBRECTS = 0x08;
const HEXTILE_SUBRECTS_COLOURED = 0x10;

/** Bytes in a TPIXEL or CPIXEL under the negotiated pixel format. */
const TPIXEL_BYTES = 3;

/** ZRLE tile edge in pixels. */
const ZRLE_TILE = 64;

/** ZRLE subencoding values that introduce a palette. */
const ZRLE_MIN_PALETTE = 2;
const ZRLE_MAX_PALETTE = 16;

/** Decoded ZRLE bytes retained before the consumed prefix is released. */
const COMPACT_THRESHOLD = 1 << 20;

/** State a decoder must carry between rectangles. */
export class DecoderState {
	/** The four Tight zlib streams, created on first use. */
	tightStreams = [null, null, null, null];

	/** The Tight palette, as up to 256 RGB triples. */
	tightPalette = new Uint8Array(256 * TPIXEL_BYTES);

	/** How many colours the Tight palette currently holds. */
	tightPaletteSize = 0;

	/** The single ZRLE zlib stream. */
	zrleStream = null;

	/** Release every stream this state owns. */
	reset() {
		for (const stream of this.tightStreams) stream?.close();
		this.tightStreams = [null, null, null, null];
		this.zrleStream?.close();
		this.zrleStream = null;
		this.tightPaletteSize = 0;
	}
}

/**
 * Byte offset of one pixel in the framebuffer buffer.
 *
 * @param {import("./display.js").Surface} surface - Framebuffer.
 * @param {number} x - Column.
 * @param {number} y - Row.
 * @returns {number} Index into the RGBA buffer.
 */
function at(surface, x, y) {
	return (y * surface.width + x) * 4;
}

/**
 * Write one RGB triple into the framebuffer.
 *
 * @param {import("./display.js").Surface} surface - Framebuffer.
 * @param {number} x - Column.
 * @param {number} y - Row.
 * @param {number} r - Red.
 * @param {number} g - Green.
 * @param {number} b - Blue.
 * @returns {void}
 */
function setRgb(surface, x, y, r, g, b) {
	const offset = at(surface, x, y);
	const data = surface.data;
	data[offset] = r;
	data[offset + 1] = g;
	data[offset + 2] = b;
	data[offset + 3] = 255;
}

/**
 * Fill a rectangle with one colour.
 *
 * @param {import("./display.js").Surface} surface - Framebuffer.
 * @param {number} x - Left.
 * @param {number} y - Top.
 * @param {number} width - Width.
 * @param {number} height - Height.
 * @param {number} r - Red.
 * @param {number} g - Green.
 * @param {number} b - Blue.
 * @returns {void}
 */
function fillRect(surface, x, y, width, height, r, g, b) {
	for (let row = 0; row < height; row++) {
		let offset = at(surface, x, y + row);
		for (let column = 0; column < width; column++) {
			surface.data[offset] = r;
			surface.data[offset + 1] = g;
			surface.data[offset + 2] = b;
			surface.data[offset + 3] = 255;
			offset += 4;
		}
	}
}

/**
 * Read one TPIXEL from the stream.
 *
 * @param {Reader} reader - Stream cursor.
 * @returns {{r: number, g: number, b: number}} the colour.
 */
function readTpixel(reader) {
	return { r: reader.u8(), g: reader.u8(), b: reader.u8() };
}

/**
 * Read one length in the protocol's compact 1-to-3 byte form.
 *
 * The first byte carries bits 0-6 with a high-bit marker, and each following
 * byte carries the next seven bits up, marking its own high bit as "there is
 * more". The specification's worked example, decimal 10000 as `90 4E`, pins
 * that byte order down: the low bits come first.
 *
 * @param {Reader} reader - Stream cursor.
 * @returns {number} the decoded length.
 */
export function readCompactLength(reader) {
	const first = reader.u8();
	if (first < 0x80) return first;
	const low = first & 0x7f;
	const second = reader.u8();
	if ((second & 0x80) === 0) return (second << 7) | low;
	return ((reader.u8() << 14) | ((second & 0x7f) << 7) | low) & 0x3fffff;
}

/** Raw: uncompressed pixels, one row at a time. */
export function decodeRaw(reader, rect, surface) {
	const { x, y, width, height } = rect;
	for (let row = 0; row < height; row++) {
		const line = reader.bytes(width * 4);
		let offset = at(surface, x, y + row);
		for (let column = 0; column < width; column++) {
			surface.data[offset] = line[column * 4];
			surface.data[offset + 1] = line[column * 4 + 1];
			surface.data[offset + 2] = line[column * 4 + 2];
			surface.data[offset + 3] = 255;
			offset += 4;
		}
	}
}

/** CopyRect: move a region already on screen. */
export function decodeCopyRect(reader, rect, surface) {
	const { x, y, width, height } = rect;
	const sx = reader.u16();
	const sy = reader.u16();
	surface.copyRect(sx, sy, x, y, width, height);
}

/** Hextile: 16x16 tiles of runs and subrectangles. */
export function decodeHextile(reader, rect, surface) {
	const { x, y, width, height } = rect;
	// Background and foreground persist across tiles, as the protocol requires.
	let background = { r: 0, g: 0, b: 0 };
	let foreground = { r: 0, g: 0, b: 0 };

	for (let tileY = 0; tileY < height; tileY += 16) {
		const tileHeight = Math.min(16, height - tileY);
		for (let tileX = 0; tileX < width; tileX += 16) {
			const tileWidth = Math.min(16, width - tileX);
			const originX = x + tileX;
			const originY = y + tileY;
			const subencoding = reader.u8();

			if ((subencoding & HEXTILE_RAW) !== 0) {
				for (let row = 0; row < tileHeight; row++) {
					const line = reader.bytes(tileWidth * TPIXEL_BYTES);
					for (let column = 0; column < tileWidth; column++) {
						setRgb(
							surface,
							originX + column,
							originY + row,
							line[column * 3],
							line[column * 3 + 1],
							line[column * 3 + 2]
						);
					}
				}
				continue;
			}

			if ((subencoding & HEXTILE_BACKGROUND) !== 0) background = readTpixel(reader);
			if ((subencoding & HEXTILE_FOREGROUND) !== 0) foreground = readTpixel(reader);
			fillRect(surface, originX, originY, tileWidth, tileHeight, background.r, background.g, background.b);

			if ((subencoding & HEXTILE_ANY_SUBRECTS) === 0) continue;

			const coloured = (subencoding & HEXTILE_SUBRECTS_COLOURED) !== 0;
			for (;;) {
				const packed = reader.u8();
				if (packed === 0) break;
				const subWidth = (packed & 0x0f) + 1;
				const subHeight = (packed >> 4) + 1;
				const colour = coloured ? readTpixel(reader) : foreground;
				fillRect(surface, originX, originY, subWidth, subHeight, colour.r, colour.g, colour.b);
			}
		}
	}
}

/**
 * Get one of the four Tight zlib streams, resetting it when the server asks.
 *
 * @param {DecoderState} state - Decoder state.
 * @param {number} id - Stream index, 0 through 3.
 * @param {boolean} reset - Whether the control byte asked for a reset.
 * @returns {PersistentZlib} the stream to append to.
 */
function tightStream(state, id, reset) {
	if (reset || state.tightStreams[id] === null) {
		state.tightStreams[id]?.reset();
		if (state.tightStreams[id] === null) state.tightStreams[id] = new PersistentZlib();
	}
	return state.tightStreams[id];
}

/**
 * Tight: palette, gradient and fill modes over four persistent zlib streams.
 *
 * Reads everything it needs off the stream before touching the framebuffer or
 * any zlib stream, and reports `false` without consuming anything when the
 * rectangle is only partly buffered. That matters because a Tight rectangle
 * feeds a zlib stream that outlives it: consuming half a rectangle and then
 * coming back for the rest would feed the stream twice.
 *
 * @param {Reader} reader - Stream cursor.
 * @param {object} rect - Rectangle geometry.
 * @param {import("./display.js").Surface} surface - Framebuffer.
 * @param {DecoderState} state - Decoder state.
 * @returns {Promise<boolean>} false when more bytes are needed, else true.
 */
export async function decodeTight(reader, rect, surface, state) {
	const { x, y, width, height } = rect;

	if (reader.remaining < 1) return false;
	const control = reader.u8();
	// Bits 0-3 are independent stream-reset flags, and they apply even to the
	// fill and JPEG modes, so they are honoured before the mode is interpreted.
	const resetFlags = control & 0x0f;
	const mode = control & 0xf0;

	if (mode === 0x80) {
		if (reader.remaining < 3) return false;
		const colour = readTpixel(reader);
		for (let id = 0; id < 4; id++) {
			if ((resetFlags & (1 << id)) !== 0) tightStream(state, id, true);
		}
		fillRect(surface, x, y, width, height, colour.r, colour.g, colour.b);
		return true;
	}
	if (mode === 0x90) {
		throw new Error("this server sent a Tight JPEG rectangle, which this client does not advertise support for");
	}
	if (mode === 0xa0 || mode === 0xe0) {
		throw new Error("this server sent Tight-without-zlib, which this client does not advertise support for");
	}
	if ((control & 0x80) !== 0) {
		throw new Error(`this server sent an unknown Tight control byte 0x${control.toString(16)}`);
	}

	// BasicCompression: bits 5-4 select the stream, bit 6 asks for a filter id.
	const streamId = (control >> 4) & 0x03;
	let filter = 0;
	if ((control & 0x40) !== 0) {
		if (reader.remaining < 1) return false;
		filter = reader.u8();
	}

	// Bit 3 is a palette reset in basic mode, where the low bits carry the
	// filter id rather than independent reset flags.
	if ((control & 0x08) !== 0) state.tightPaletteSize = 0;

	if (filter === 1) {
		if (reader.remaining < 1) return false;
		const declared = reader.u8() + 1;
		if (reader.remaining < declared * TPIXEL_BYTES) return false;
		state.tightPalette.set(reader.bytes(declared * TPIXEL_BYTES), 0);
		state.tightPaletteSize = declared;
	}

	const bytesPerPixel = filter === 1 ? (state.tightPaletteSize === 2 ? 0 : 1) : TPIXEL_BYTES;
	// The size the filter produces is not always pixels times bytes-per-pixel:
	// a two-colour palette packs eight pixels per byte, and each row is padded
	// to a byte boundary. Getting this wrong makes the client disagree with the
	// server about whether the payload was compressed at all.
	const filtered =
		filter === 1
			? state.tightPaletteSize === 2
				? ((width + 7) >> 3) * height
				: width * height
			: width * height * TPIXEL_BYTES;

	// Below twelve bytes a compressor must send the data uncompressed, with no
	// length prefix: the size is implied by the rectangle.
	let pixels;
	if (filtered < 12) {
		if (reader.remaining < filtered) return false;
		pixels = reader.bytes(filtered);
	} else {
		// Peek rather than read: the length field is variable-width, so the
		// payload may not be here yet, and a consumed length would make the
		// wait for the rest impossible to resume from.
		const probe = new Reader(reader.peek(reader.remaining));
		const length = readCompactLength(probe);
		if (reader.remaining < probe.offset + length) return false;
		reader.skip(probe.offset);
		// Nothing has been fed yet; from here the zlib stream advances once.
		pixels = await tightStream(state, streamId, (resetFlags & (1 << streamId)) !== 0).push(reader.bytes(length), filtered);
	}

	if (filter === 1) {
		paintPalette(surface, x, y, width, height, pixels, state.tightPalette, state.tightPaletteSize, bytesPerPixel);
		return true;
	}
	if (filter === 2) {
		paintGradient(surface, x, y, width, height, pixels);
		return true;
	}
	for (let row = 0; row < height; row++) {
		for (let column = 0; column < width; column++) {
			const source = (row * width + column) * TPIXEL_BYTES;
			setRgb(surface, x + column, y + row, pixels[source], pixels[source + 1], pixels[source + 2]);
		}
	}
	return true;
}

/**
 * Paint indexed pixels through a palette.
 *
 * @param {import("./display.js").Surface} surface - Framebuffer.
 * @param {number} x - Left.
 * @param {number} y - Top.
 * @param {number} width - Width.
 * @param {number} height - Height.
 * @param {Uint8Array} indices - Palette indices, packed or one per pixel.
 * @param {Uint8Array} palette - RGB triples.
 * @param {number} paletteSize - Colours in the palette.
 * @param {number} bytesPerPixel - 0 for one-bit, 1 for eight-bit indices.
 * @returns {void}
 */
function paintPalette(surface, x, y, width, height, indices, palette, paletteSize, bytesPerPixel) {
	for (let row = 0; row < height; row++) {
		if (bytesPerPixel === 0) {
			// One bit per pixel, most significant bit leftmost, rows byte-aligned.
			const stride = (width + 7) >> 3;
			const line = indices.subarray(row * stride, row * stride + stride);
			for (let column = 0; column < width; column++) {
				const bit = (line[column >> 3] >> (7 - (column & 7))) & 1;
				const entry = bit * TPIXEL_BYTES;
				setRgb(surface, x + column, y + row, palette[entry], palette[entry + 1], palette[entry + 2]);
			}
		} else {
			const line = indices.subarray(row * width, row * width + width);
			for (let column = 0; column < width; column++) {
				const entry = line[column] * TPIXEL_BYTES;
				setRgb(surface, x + column, y + row, palette[entry], palette[entry + 1], palette[entry + 2]);
			}
		}
	}
}

/**
 * Undo the Tight gradient filter.
 *
 * The encoder stored differences from a prediction built from the left and
 * above neighbours, both of which are the already-reconstructed values, so
 * this has to run left to right, top to bottom, per component.
 *
 * @param {import("./display.js").Surface} surface - Framebuffer.
 * @param {number} x - Left.
 * @param {number} y - Top.
 * @param {number} width - Width.
 * @param {number} height - Height.
 * @param {Uint8Array} differences - Filtered values, three bytes per pixel.
 * @returns {void}
 */
function paintGradient(surface, x, y, width, height, differences) {
	const previous = new Uint8Array(width * TPIXEL_BYTES);
	const current = new Uint8Array(width * TPIXEL_BYTES);
	for (let row = 0; row < height; row++) {
		for (let column = 0; column < width; column++) {
			const source = (row * width + column) * TPIXEL_BYTES;
			for (let component = 0; component < TPIXEL_BYTES; component++) {
				const above = row === 0 ? 0 : previous[column * TPIXEL_BYTES + component];
				const left = column === 0 ? 0 : current[(column - 1) * TPIXEL_BYTES + component];
				const upperLeft = row === 0 || column === 0 ? 0 : previous[(column - 1) * TPIXEL_BYTES + component];
				let predicted = above + left - upperLeft;
				if (predicted < 0) predicted = 0;
				if (predicted > 255) predicted = 255;
				current[column * TPIXEL_BYTES + component] = (differences[source + component] + predicted) & 0xff;
			}
			setRgb(
				surface,
				x + column,
				y + row,
				current[column * TPIXEL_BYTES],
				current[column * TPIXEL_BYTES + 1],
				current[column * TPIXEL_BYTES + 2]
			);
		}
		previous.set(current);
	}
}

/**
 * Read one ZRLE run length.
 *
 * The length is one more than the sum of the bytes that carry it, and 255
 * means "another byte follows".
 *
 * @param {Reader} reader - Stream cursor.
 * @returns {number} the run length.
 */
function readRunLength(reader) {
	let length = 1;
	for (;;) {
		const byte = reader.u8();
		length += byte;
		if (byte !== 255) break;
	}
	return length;
}

/**
 * ZRLE: 64x64 tiles, one persistent zlib stream, palette and run modes.
 *
 * @param {Reader} reader - Stream cursor.
 * @param {object} rect - Rectangle geometry.
 * @param {import("./display.js").Surface} surface - Framebuffer.
 * @param {DecoderState} state - Decoder state.
 * @returns {Promise<void>} resolution once the rectangle is painted.
 */
export async function decodeZrle(reader, rect, surface, state) {
	const { x, y, width, height } = rect;

	// The compressed block is length-prefixed, so everything this rectangle
	// needs can be checked for before the zlib stream is touched at all.
	if (reader.remaining < 4) return false;
	const length = reader.u32();
	if (reader.remaining < length) return false;
	const compressed = reader.bytes(length);
	if (state.zrleStream === null) state.zrleStream = new PersistentZlib();
	state.zrleStream.write(compressed);

	// The decoded length is not knowable from the geometry: it depends on which
	// subencoding the encoder chose for each tile. What the protocol does
	// guarantee is a flush per tile, so output becomes available tile by tile.
	// Each tile is therefore parsed speculatively against whatever has been
	// decoded so far, and retried once more output has arrived if the parse ran
	// off the end.
	const source = new ZrleSource(state.zrleStream);
	await source.fill(1);

	for (let tileY = 0; tileY < height; tileY += ZRLE_TILE) {
		const tileHeight = Math.min(ZRLE_TILE, height - tileY);
		for (let tileX = 0; tileX < width; tileX += ZRLE_TILE) {
			const tileWidth = Math.min(ZRLE_TILE, width - tileX);
			const originX = x + tileX;
			const originY = y + tileY;
			for (;;) {
				const start = source.offset;
				const tileReader = source.reader;
				try {
					decodeZrleTile(tileReader, surface, originX, originY, tileWidth, tileHeight);
					// `tileReader` reads inside the source’s own buffer, so its
					// offset is already absolute; only the distance from where this
					// tile started has actually been consumed.
					source.advance(tileReader.offset - start);
					break;
				} catch (error) {
					source.rewind(start);
					if (!(error instanceof RfbTruncated)) throw error;
					// Unconditionally pull: the buffer may still hold bytes, but
					// this tile ran past every one of them, so it needs more.
					if (!(await source.pull())) {
						throw new Error(`the ZRLE stream ended inside a tile at ${originX},${originY}`);
					}
				}
			}
		}
	}
	return true;
}

/**
 * The decoded side of the ZRLE stream, read forward as tiles consume it.
 *
 * Holds the chunks pulled from the stream and exposes them as one contiguous
 * buffer. A tile that parses against too few bytes rewinds and is retried once
 * more has arrived, which is what lets the decoded length stay unknown.
 */
class ZrleSource {
	#stream;
	#flat = new Uint8Array(0);
	#available = 0;
	#offset = 0;

	/** Bytes consumed before this buffer's retained prefix, kept for compaction. */
	#consumedTotal = 0;

	/**
	 * @param {import("./inflate.js").PersistentZlib} stream - The ZRLE stream.
	 */
	constructor(stream) {
		this.#stream = stream;
	}

	/** Parse position within the retained buffer. */
	get offset() {
		return this.#offset;
	}

	/** A fresh Reader positioned at the parse offset. */
	get reader() {
		return new Reader(this.#flat, this.#offset);
	}

	/**
	 * Move the parse position forward past bytes just consumed.
	 *
	 * @param {number} count - Bytes consumed.
	 * @returns {void}
	 */
	advance(count) {
		this.#offset += count;
		this.#consumedTotal += count;
		// Release the consumed prefix periodically so a long-lived connection
		// does not keep every tile it has ever decoded.
		if (this.#consumedTotal >= COMPACT_THRESHOLD) this.#compact();
	}

	/**
	 * Return the parse position to a previous value after a failed parse.
	 *
	 * @param {number} position - Offset to restore.
	 * @returns {void}
	 */
	rewind(position) {
		this.#offset = position;
	}

	/**
	 * Pull decoded chunks until at least `minimum` bytes sit past the offset.
	 *
	 * @param {number} minimum - Bytes wanted past the offset.
	 * @returns {Promise<boolean>} whether that many bytes are now available.
	 */
	async fill(minimum) {
		while (this.#available - this.#offset < minimum) {
			if (!(await this.pull())) return false;
		}
		return true;
	}

	/**
	 * Pull exactly one more chunk from the stream.
	 *
	 * Used when a tile parse ran past the buffer: the buffer may still hold
	 * bytes, but they are not enough, so the retry needs a fresh chunk rather
	 * than a re-check of what is already there.
	 *
	 * @returns {Promise<boolean>} whether a chunk arrived before the stream ended.
	 */
	async pull() {
		for (;;) {
			const next = await this.#stream.chunk();
			if (next === null) return false;
			if (next.length === 0) continue;
			const grown = new Uint8Array(this.#available + next.length);
			grown.set(this.#flat.subarray(0, this.#available), 0);
			grown.set(next, this.#available);
			this.#flat = grown;
			this.#available += next.length;
			return true;
		}
	}

	/** Drop the consumed prefix of the retained buffer. */
	#compact() {
		this.#flat = this.#flat.slice(this.#offset);
		this.#available -= this.#offset;
		this.#offset = 0;
		this.#consumedTotal = 0;
	}
}

/**
 * Decode one ZRLE tile.
 *
 * @param {Reader} reader - Stream cursor over the decompressed rectangle.
 * @param {import("./display.js").Surface} surface - Framebuffer.
 * @param {number} x - Tile left in framebuffer coordinates.
 * @param {number} y - Tile top in framebuffer coordinates.
 * @param {number} width - Tile width.
 * @param {number} height - Tile height.
 * @returns {void}
 */
function decodeZrleTile(reader, surface, x, y, width, height) {
	const subencoding = reader.u8();

	// The dispatch has to test the whole subencoding byte. Bit 7 is the
	// run-length flag, so masking it off first would make 128 — plain RLE —
	// indistinguishable from 0 — raw pixels — and 130-255 — palette RLE —
	// unreachable.
	if (subencoding === 0) {
		for (let index = 0; index < width * height; index++) {
			const r = reader.u8();
			const g = reader.u8();
			const b = reader.u8();
			setRgb(surface, x + (index % width), y + ((index / width) | 0), r, g, b);
		}
		return;
	}

	if (subencoding === 1) {
		const r = reader.u8();
		const g = reader.u8();
		const b = reader.u8();
		fillRect(surface, x, y, width, height, r, g, b);
		return;
	}

	if (subencoding === 128) {
		paintRuns(reader, surface, x, y, width, height, null);
		return;
	}

	if (subencoding >= 130) {
		const palette = readPalette(reader, subencoding - 128);
		paintRuns(reader, surface, x, y, width, height, palette);
		return;
	}

	if (subencoding >= ZRLE_MIN_PALETTE && subencoding <= ZRLE_MAX_PALETTE) {
		const paletteSize = subencoding;
		const palette = readPalette(reader, paletteSize);
		const packed = paletteSize <= 2 ? 1 : paletteSize <= 4 ? 2 : 4;
		const stride = packed === 1 ? (width + 7) >> 3 : packed === 2 ? (width + 3) >> 2 : (width + 1) >> 1;
		for (let row = 0; row < height; row++) {
			const line = reader.bytes(stride);
			for (let column = 0; column < width; column++) {
				const shift = packed === 1 ? 7 - (column & 7) : packed === 2 ? 6 - (column & 3) : 4 - (column & 1);
				const index = (line[Math.floor((column * packed) / 8)] >> shift) & ((1 << packed) - 1);
				const entry = index * TPIXEL_BYTES;
				setRgb(surface, x + column, y + row, palette[entry], palette[entry + 1], palette[entry + 2]);
			}
		}
		return;
	}

	throw new Error(`ZRLE subencoding ${subencoding} is not one this protocol version defines`);
}

/**
 * Read a ZRLE palette.
 *
 * @param {Reader} reader - Stream cursor.
 * @param {number} size - Number of colours.
 * @returns {Uint8Array} RGB triples.
 */
function readPalette(reader, size) {
	return Uint8Array.prototype.slice.call(reader.bytes(size * TPIXEL_BYTES));
}

/**
 * Paint one ZRLE tile in either plain RLE or palette RLE mode.
 *
 * @param {Reader} reader - Stream cursor.
 * @param {import("./display.js").Surface} surface - Framebuffer.
 * @param {number} x - Tile left.
 * @param {number} y - Tile top.
 * @param {number} width - Tile width.
 * @param {number} height - Tile height.
 * @param {Uint8Array | null} palette - Palette, or null for plain RLE.
 * @returns {void}
 */
function paintRuns(reader, surface, x, y, width, height, palette) {
	let written = 0;
	while (written < width * height) {
		let run;
		if (palette === null) {
			// Plain RLE: the first byte read is part of the colour, not an index.
			const colour = reader.bytes(TPIXEL_BYTES);
			run = readRunLength(reader);
			paintRun(surface, x, y, width, height, written, run, (column, row) => {
				setRgb(surface, x + column, y + row, colour[0], colour[1], colour[2]);
			});
			written += run;
			continue;
		}
		const index = reader.u8();
		if ((index & 0x80) !== 0) {
			run = readRunLength(reader);
			const entry = (index & 0x7f) * TPIXEL_BYTES;
			paintRun(surface, x, y, width, height, written, run, (column, row) => {
				setRgb(surface, x + column, y + row, palette[entry], palette[entry + 1], palette[entry + 2]);
			});
		} else {
			run = 1;
			const entry = index * TPIXEL_BYTES;
			paintRun(surface, x, y, width, height, written, run, (column, row) => {
				setRgb(surface, x + column, y + row, palette[entry], palette[entry + 1], palette[entry + 2]);
			});
		}
		written += run;
	}
}

/**
 * Paint a run of pixels, allowing it to cross a row boundary.
 *
 * @param {import("./display.js").Surface} surface - Framebuffer.
 * @param {number} x - Tile left.
 * @param {number} y - Tile top.
 * @param {number} width - Tile width.
 * @param {number} height - Tile height.
 * @param {number} start - Index of the run's first pixel in the tile.
 * @param {number} run - How many pixels the run covers.
 * @param {(column: number, row: number) => void} paint - Paints one pixel.
 * @returns {void}
 */
function paintRun(surface, x, y, width, height, start, run, paint) {
	const end = Math.min(start + run, width * height);
	for (let index = start; index < end; index++) {
		paint(index % width, (index / width) | 0);
	}
}

/**
 * Decode the Cursor pseudo-encoding into the cursor surface.
 *
 * @param {Reader} reader - Stream cursor.
 * @param {object} rect - Hotspot and size, as sent by the server.
 * @param {import("./display.js").CursorSurface} cursor - Cursor surface.
 * @returns {void}
 */
export function decodeCursor(reader, rect, cursor) {
	const { width, height } = rect;
	if (width === 0 || height === 0) {
		cursor.resize(0, 0);
		return;
	}
	const pixels = reader.bytes(width * height * TPIXEL_BYTES);
	const stride = (width + 7) >> 3;
	const mask = new Uint8Array(stride * height);
	for (let row = 0; row < height; row++) {
		const line = reader.bytes(stride);
		for (let column = 0; column < width; column++) {
			mask[row * stride + (column >> 3)] |= ((line[column >> 3] >> (7 - (column & 7))) & 1) << (column & 7);
		}
	}
	cursor.resize(width, height);
	cursor.paint(pixels, mask);
}
