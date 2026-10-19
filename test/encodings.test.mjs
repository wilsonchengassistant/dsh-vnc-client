/**
 * Rectangle decoders, checked by round-tripping server-shaped encodings.
 *
 * Every case builds the encoded bytes with the test's own encoder — written
 * from the specification text, not shared with the decoder — decodes them, and
 * compares the framebuffer against the pixels that were encoded.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Reader } from "../src/client/rfb/reader.js";
import { DecoderState, decodeCopyRect, decodeCursor, decodeHextile, decodeRaw, decodeTight, decodeZrle } from "../src/client/rfb/encodings.js";
import { CursorSurface, Surface } from "../src/client/rfb/display.js";
import { StubCanvas, pixelAt, pixels } from "./canvas-stub.mjs";
import {
	PersistentDeflate,
	encodeCopyRect,
	encodeHextileRaw,
	encodeHextileSolid,
	encodeHextileSubrect,
	encodeRaw,
	encodeTightCopy,
	encodeTightFill,
	encodeTightGradient,
	encodeTightPalette,
	encodeZrle,
	zrleTilePackedPalette,
	zrleTilePaletteRle,
	zrleTilePlainRle,
	zrleTileRaw,
	zrleTileSolid
} from "./encoders.mjs";

/**
 * A framebuffer of a deterministic pattern, in RGB triples.
 *
 * @param {number} width - Width.
 * @param {number} height - Height.
 * @returns {Uint8Array} three bytes per pixel, row-major.
 */
function pattern(width, height) {
	const out = new Uint8Array(width * height * 3);
	for (let index = 0; index < width * height; index++) {
		out[index * 3] = (index * 7) & 0xff;
		out[index * 3 + 1] = (index * 13) & 0xff;
		out[index * 3 + 2] = (index * 29) & 0xff;
	}
	return out;
}

/**
 * The framebuffer the decoders paint into, filled with a known sentinel.
 *
 * @param {number} width - Width.
 * @param {number} height - Height.
 * @returns {{surface: Surface, canvas: StubCanvas}} the surface and its canvas.
 */
function framebuffer(width, height) {
	const canvas = new StubCanvas(width, height);
	const surface = new Surface(canvas);
	surface.resize(width, height);
	// A colour no test uses, so an untouched pixel is detectable.
	for (let index = 0; index < surface.data.length; index += 4) {
		surface.data[index] = 1;
		surface.data[index + 1] = 2;
		surface.data[index + 2] = 3;
		surface.data[index + 3] = 255;
	}
	return { surface, canvas };
}

test("Raw paints every pixel", () => {
	const rect = { x: 2, y: 1, width: 7, height: 5 };
	const source = pattern(rect.width, rect.height);
	const { surface } = framebuffer(16, 16);
	decodeRaw(new Reader(encodeRaw(rect, source)), rect, surface);
	for (let row = 0; row < rect.height; row++) {
		for (let column = 0; column < rect.width; column++) {
			const offset = (row * rect.width + column) * 3;
			const expected = [source[offset], source[offset + 1], source[offset + 2]];
			assert.deepEqual(pixelAt(surface.data, 16, rect.x + column, rect.y + row), expected);
		}
	}
});

test("Raw leaves pixels outside the rectangle alone", () => {
	const rect = { x: 3, y: 4, width: 2, height: 2 };
	const { surface } = framebuffer(16, 16);
	decodeRaw(new Reader(encodeRaw(rect, new Uint8Array(12).fill(200))), rect, surface);
	assert.deepEqual(pixelAt(surface.data, 16, 2, 4), [1, 2, 3], "one column left is untouched");
	assert.deepEqual(pixelAt(surface.data, 16, 3, 4), [200, 200, 200]);
	assert.deepEqual(pixelAt(surface.data, 16, 3, 7), [1, 2, 3], "one row below is untouched");
});

test("CopyRect moves a region and tolerates overlap", () => {
	const { surface } = framebuffer(8, 8);
	// Paint a known 4x4 block, then shift it one column right, overlapping.
	decodeRaw(new Reader(encodeRaw({ x: 0, y: 0, width: 4, height: 4 }, pattern(4, 4))), { x: 0, y: 0, width: 4, height: 4 }, surface);
	// Snapshot the block before the copy: after an overlapping copy the
	// source columns have themselves moved, so comparing against the live
	// framebuffer would compare the copy against itself.
	const before = [];
	for (let row = 0; row < 4; row++) {
		for (let column = 0; column < 4; column++) {
			before.push(pixelAt(surface.data, 8, column, row));
		}
	}
	const rect = { x: 1, y: 0, width: 4, height: 4 };
	decodeCopyRect(new Reader(encodeCopyRect(rect, 0, 0)), rect, surface);
	for (let row = 0; row < 4; row++) {
		for (let column = 0; column < 4; column++) {
			assert.deepEqual(pixelAt(surface.data, 8, 1 + column, row), before[row * 4 + column], `row ${row} column ${column}`);
		}
	}
});

test("Hextile solid tiles fill the rectangle", () => {
	const rect = { x: 0, y: 0, width: 40, height: 20 };
	const { surface } = framebuffer(40, 20);
	decodeHextile(new Reader(encodeHextileSolid(rect, [17, 34, 51])), rect, surface);
	for (let row = 0; row < 20; row++) {
		assert.deepEqual(pixelAt(surface.data, 40, 39, row), [17, 34, 51], `row ${row}`);
	}
});

test("Hextile subrectangles land on the tile background", () => {
	const rect = { x: 0, y: 0, width: 16, height: 16 };
	const { surface } = framebuffer(16, 16);
	decodeHextile(new Reader(encodeHextileSubrect(rect, [10, 10, 10], [200, 100, 50])), rect, surface);
	assert.deepEqual(pixelAt(surface.data, 16, 0, 0), [200, 100, 50], "subrectangle origin");
	assert.deepEqual(pixelAt(surface.data, 16, 1, 1), [200, 100, 50], "subrectangle interior");
	assert.deepEqual(pixelAt(surface.data, 16, 2, 2), [10, 10, 10], "outside the subrectangle");
	assert.deepEqual(pixelAt(surface.data, 16, 15, 15), [10, 10, 10], "tile corner");
});

test("Hextile raw subencoding paints a multi-tile rectangle", () => {
	const rect = { x: 0, y: 0, width: 33, height: 17 };
	const source = pattern(rect.width, rect.height);
	const { surface } = framebuffer(33, 17);
	decodeHextile(new Reader(encodeHextileRaw(rect, source)), rect, surface);
	for (let row = 0; row < 17; row++) {
		for (let column = 0; column < 33; column++) {
			const offset = (row * 33 + column) * 3;
			assert.deepEqual(
				pixelAt(surface.data, 33, column, row),
				[source[offset], source[offset + 1], source[offset + 2]],
				`row ${row} column ${column}`
			);
		}
	}
});

test("Tight fill paints the whole rectangle", async () => {
	const rect = { x: 0, y: 0, width: 20, height: 20 };
	const { surface } = framebuffer(20, 20);
	const reader = new Reader(encodeTightFill(rect, [9, 8, 7]));
	assert.equal(await decodeTight(reader, rect, surface, new DecoderState()), true);
	assert.deepEqual(pixelAt(surface.data, 20, 19, 19), [9, 8, 7]);
});

test("Tight palette paint through a shared stream across rectangles", async () => {
	const state = new DecoderState();
	const stream = new PersistentDeflate();
	const first = { x: 0, y: 0, width: 4, height: 4 };
	const second = { x: 4, y: 0, width: 4, height: 4 };
	const { surface } = framebuffer(8, 4);

	const palette = [
		[255, 0, 0],
		[0, 255, 0],
		[0, 0, 255],
		[255, 255, 255]
	];
	const indicesA = Uint8Array.from({ length: 16 }, (unused, index) => index % 4);
	const indicesB = Uint8Array.from({ length: 16 }, (unused, index) => (index + 2) % 4);

	// The first rectangle asks the decoder to reset stream 0, the second does
	// not: both must decode correctly from the one persistent stream.
	const bytesA = await encodeTightPalette(first, palette, indicesA, stream, 0, true);
	const bytesB = await encodeTightPalette(second, palette, indicesB, stream, 0, false);

	assert.equal(await decodeTight(new Reader(bytesA), first, surface, state), true);
	assert.equal(await decodeTight(new Reader(bytesB), second, surface, state), true);

	for (let index = 0; index < 16; index++) {
		const expectedA = palette[indicesA[index]];
		assert.deepEqual(pixelAt(surface.data, 8, index % 4, (index / 4) | 0), expectedA, `first tile ${index}`);
		const expectedB = palette[indicesB[index]];
		assert.deepEqual(pixelAt(surface.data, 8, 4 + (index % 4), (index / 4) | 0), expectedB, `second tile ${index}`);
	}
});

test("Tight two-colour palette packs one bit per pixel", async () => {
	const rect = { x: 0, y: 0, width: 9, height: 2 };
	const { surface } = framebuffer(9, 2);
	const palette = [
		[1, 2, 3],
		[250, 251, 252]
	];
	const indices = Uint8Array.from({ length: 18 }, (unused, index) => index % 2);
	const bytes = await encodeTightPalette(rect, palette, indices, new PersistentDeflate());
	assert.equal(await decodeTight(new Reader(bytes), rect, surface, new DecoderState()), true);
	for (let index = 0; index < 18; index++) {
		assert.deepEqual(pixelAt(surface.data, 9, index % 9, (index / 9) | 0), palette[indices[index]], `pixel ${index}`);
	}
});

test("Tight copy filter round-trips raw pixels", async () => {
	const rect = { x: 0, y: 0, width: 8, height: 8 };
	const source = pattern(rect.width, rect.height);
	const { surface } = framebuffer(8, 8);
	const bytes = await encodeTightCopy(rect, source, new PersistentDeflate());
	assert.equal(await decodeTight(new Reader(bytes), rect, surface, new DecoderState()), true);
	for (let index = 0; index < rect.width * rect.height; index++) {
		assert.deepEqual(
			pixelAt(surface.data, 8, index % 8, (index / 8) | 0),
			[source[index * 3], source[index * 3 + 1], source[index * 3 + 2]],
			`pixel ${index}`
		);
	}
});

test("Tight gradient filter round-trips", async () => {
	const rect = { x: 0, y: 0, width: 8, height: 8 };
	const source = pattern(rect.width, rect.height);
	const { surface } = framebuffer(8, 8);
	const bytes = await encodeTightGradient(rect, source, new PersistentDeflate());
	assert.equal(await decodeTight(new Reader(bytes), rect, surface, new DecoderState()), true);
	for (let index = 0; index < rect.width * rect.height; index++) {
		assert.deepEqual(
			pixelAt(surface.data, 8, index % 8, (index / 8) | 0),
			[source[index * 3], source[index * 3 + 1], source[index * 3 + 2]],
			`pixel ${index}`
		);
	}
});

test("ZRLE raw tiles round-trip", async () => {
	const rect = { x: 0, y: 0, width: 70, height: 66 };
	const source = pattern(rect.width, rect.height);
	const { surface } = framebuffer(70, 66);
	const bytes = await encodeZrle(rect, source, (tile) => zrleTileRaw(source, tile, rect.width), new PersistentDeflate());
	assert.equal(await decodeZrle(new Reader(bytes), rect, surface, new DecoderState()), true);
	for (let row = 0; row < 66; row++) {
		for (let column = 0; column < 70; column++) {
			const offset = (row * 70 + column) * 3;
			assert.deepEqual(
				pixelAt(surface.data, 70, column, row),
				[source[offset], source[offset + 1], source[offset + 2]],
				`row ${row} column ${column}`
			);
		}
	}
});

test("ZRLE solid and packed-palette tiles coexist across a tile boundary", async () => {
	// Two tile rows, so the second tile is a different encoding from the first.
	const rect = { x: 0, y: 0, width: 64, height: 65 };
	const { surface } = framebuffer(64, 65);
	const palette = [
		[10, 20, 30],
		[40, 50, 60]
	];
	const indices = Uint8Array.from({ length: 64 * 64 }, (unused, index) => index % 2);

	const bytes = await encodeZrle(
		rect,
		new Uint8Array(0),
		(tile) => (tile.y === 0 ? zrleTilePackedPalette(palette, indices, tile) : zrleTileSolid([7, 7, 7])),
		new PersistentDeflate()
	);
	assert.equal(await decodeZrle(new Reader(bytes), rect, surface, new DecoderState()), true);
	assert.deepEqual(pixelAt(surface.data, 64, 0, 0), palette[0], "first pixel of the palette tile");
	assert.deepEqual(pixelAt(surface.data, 64, 1, 0), palette[1], "second pixel of the palette tile");
	assert.deepEqual(pixelAt(surface.data, 64, 63, 63), palette[1], "last pixel of the palette tile");
	assert.deepEqual(pixelAt(surface.data, 64, 0, 64), [7, 7, 7], "the next tile row is solid");
	assert.deepEqual(pixelAt(surface.data, 64, 63, 64), [7, 7, 7], "including its last pixel");
});

test("ZRLE palette runs decode, including a run spanning a tile row", async () => {
	const rect = { x: 0, y: 0, width: 8, height: 2 };
	const { surface } = framebuffer(8, 2);
	const palette = [
		[1, 1, 1],
		[2, 2, 2],
		[3, 3, 3]
	];
	// Sixteen pixels as index 1, six as index 2, three as index 0: the middle
	// run crosses the row boundary at column 8.
	const runs = [
		{ index: 1, length: 10 },
		{ index: 2, length: 6 },
		{ index: 0, length: 1 }
	];
	const bytes = await encodeZrle(rect, new Uint8Array(0), (tile) => zrleTilePaletteRle(palette, runs), new PersistentDeflate());
	assert.equal(await decodeZrle(new Reader(bytes), rect, surface, new DecoderState()), true);
	for (let index = 0; index < 10; index++) {
		assert.deepEqual(pixelAt(surface.data, 8, index % 8, (index / 8) | 0), [2, 2, 2], `run one pixel ${index}`);
	}
	for (let index = 10; index < 16; index++) {
		assert.deepEqual(pixelAt(surface.data, 8, index % 8, (index / 8) | 0), [3, 3, 3], `run two pixel ${index}`);
	}
});

test("ZRLE plain runs decode a full tile", async () => {
	const rect = { x: 0, y: 0, width: 64, height: 64 };
	const { surface } = framebuffer(64, 64);
	const bytes = await encodeZrle(
		rect,
		new Uint8Array(0),
		(tile) => zrleTilePlainRle([9, 9, 9], tile.width * tile.height),
		new PersistentDeflate()
	);
	assert.equal(await decodeZrle(new Reader(bytes), rect, surface, new DecoderState()), true);
	assert.deepEqual(pixelAt(surface.data, 64, 63, 63), [9, 9, 9]);
});

test("ZRLE decodes several rectangles from one stream", async () => {
	const rect = { x: 0, y: 0, width: 64, height: 64 };
	const { surface } = framebuffer(64, 64);
	const state = new DecoderState();
	const stream = new PersistentDeflate();

	const first = pattern(64, 64);
	const second = pattern(64, 64).map((value, index) => (index * 3) & 0xff);

	const bytesA = await encodeZrle(rect, first, (tile) => zrleTileRaw(first, tile, rect.width), stream);
	const bytesB = await encodeZrle(rect, second, (tile) => zrleTileSolid([5, 5, 5]), stream);

	assert.equal(await decodeZrle(new Reader(bytesA), rect, surface, state), true);
	assert.equal(await decodeZrle(new Reader(bytesB), rect, surface, state), true);
	assert.deepEqual(pixelAt(surface.data, 64, 0, 0), [5, 5, 5], "the second rectangle overwrote the first");
});

test("the cursor pseudo-encoding decodes its shape and mask", () => {
	const width = 10;
	const height = 4;
	const cursor = new CursorSurface(new StubCanvas(width, height));
	const stride = (width + 7) >> 3;

	const pixelsBytes = new Uint8Array(width * height * 3).fill(120);
	const mask = new Uint8Array(stride * height);
	// Only the first two pixels of each row are visible.
	for (let row = 0; row < height; row++) {
		mask[row * stride] = 0b11000000;
	}

	const body = new Uint8Array(pixelsBytes.length + mask.length);
	body.set(pixelsBytes, 0);
	body.set(mask, pixelsBytes.length);

	decodeCursor(new Reader(body), { width, height }, cursor);
	assert.equal(cursor.width, width);
	assert.equal(cursor.height, height);
});
