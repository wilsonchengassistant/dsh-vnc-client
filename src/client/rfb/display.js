/**
 * The framebuffer surface.
 *
 * The pixel format is negotiated with the server rather than decoded as sent:
 * this asks for 32 bits per pixel with the red, green and blue channels in
 * ascending byte order, which is exactly `ImageData`'s layout, so a Raw
 * rectangle is a row-wise copy instead of a per-pixel swizzle.
 *
 * The framebuffer is kept as an `ImageData` buffer rather than as canvas
 * contents, because CopyRect and the palette encodings both need to read
 * pixels that were written earlier — reading them back out of a canvas would
 * mean a `getImageData` per rectangle.
 */

/** The pixel format this client asks for. */
export const REQUESTED_FORMAT = {
	bitsPerPixel: 32,
	depth: 24,
	bigEndian: false,
	trueColour: true,
	redMax: 255,
	greenMax: 255,
	blueMax: 255,
	redShift: 0,
	greenShift: 8,
	blueShift: 16
};

/** Off-screen scratch used to stage a whole-screen copy. */
export class Surface {
	#canvas;
	#context;
	#image;
	#width = 0;
	#height = 0;

	/**
	 * @param {HTMLCanvasElement} canvas - Canvas to paint into.
	 */
	constructor(canvas) {
		this.#canvas = canvas;
		this.#context = canvas.getContext("2d", { alpha: false });
	}

	/** Current framebuffer width. */
	get width() {
		return this.#width;
	}

	/** Current framebuffer height. */
	get height() {
		return this.#height;
	}

	/** Raw RGBA bytes of the whole framebuffer. */
	get data() {
		return this.#image.data;
	}

	/** The canvas being painted. */
	get canvas() {
		return this.#canvas;
	}

	/**
	 * Adopt a framebuffer size, reallocating only when it actually changed.
	 *
	 * @param {number} width - New width in pixels.
	 * @param {number} height - New height in pixels.
	 * @returns {void}
	 */
	resize(width, height) {
		if (width === this.#width && height === this.#height) return;
		this.#width = width;
		this.#height = height;
		this.#canvas.width = width;
		this.#canvas.height = height;
		this.#image = this.#context.createImageData(width, height);
		// A resized framebuffer is undefined content; black is the safe read.
		this.#image.data.fill(0);
	}

	/**
	 * Write one rectangle into the framebuffer buffer.
	 *
	 * @param {number} x - Left edge.
	 * @param {number} y - Top edge.
	 * @param {number} width - Rectangle width.
	 * @param {number} height - Rectangle height.
	 * @returns {void}
	 */
	put(x, y, width, height) {
		this.#context.putImageData(this.#image, 0, 0, x, y, width, height);
	}

	/**
	 * Copy one rectangle to another position, the CopyRect encoding's job.
	 *
	 * Rows are copied one at a time in the destination's own order, so an
	 * overlapping copy behaves as the protocol requires: the source is read
	 * exactly as it was before the rectangle started.
	 *
	 * @param {number} sx - Source left.
	 * @param {number} sy - Source top.
	 * @param {number} dx - Destination left.
	 * @param {number} dy - Destination top.
	 * @param {number} width - Width in pixels.
	 * @param {number} height - Height in pixels.
	 * @returns {void}
	 */
	copyRect(sx, sy, dx, dy, width, height) {
		const source = this.#snapshot(width, height, sx, sy);
		const target = this.#image.data;
		for (let row = 0; row < height; row++) {
			const from = row * width * 4;
			const to = ((dy + row) * this.#width + dx) * 4;
			target.set(source.subarray(from, from + width * 4), to);
		}
	}

	/**
	 * Read a rectangle out of the framebuffer.
	 *
	 * @param {number} x - Left edge.
	 * @param {number} y - Top edge.
	 * @param {number} width - Width in pixels.
	 * @param {number} height - Height in pixels.
	 * @returns {Uint8ClampedArray} an independent copy, row-major.
	 */
	#snapshot(width, height, x, y) {
		const out = new Uint8ClampedArray(width * height * 4);
		const source = this.#image.data;
		for (let row = 0; row < height; row++) {
			const from = ((y + row) * this.#width + x) * 4;
			out.set(source.subarray(from, from + width * 4), row * width * 4);
		}
		return out;
	}
}

/**
 * The cursor shape, which is its own small framebuffer.
 *
 * Kept separate from the framebuffer because it is positioned by the server
 * in framebuffer coordinates and drawn over the canvas rather than into it,
 * so a cursor update never dirties a region the screen update owns.
 */
export class CursorSurface {
	#canvas;
	#context;
	#width = 0;
	#height = 0;

	/**
	 * @param {HTMLCanvasElement} canvas - Canvas to paint the cursor into.
	 */
	constructor(canvas) {
		this.#canvas = canvas;
		this.#context = canvas.getContext("2d");
	}

	/** Cursor width, or 0 when the server has not sent one. */
	get width() {
		return this.#width;
	}

	/** Cursor height, or 0 when the server has not sent one. */
	get height() {
		return this.#width === 0 ? 0 : this.#height;
	}

	/** The canvas being painted. */
	get canvas() {
		return this.#canvas;
	}

	/**
	 * Adopt a cursor size and clear it.
	 *
	 * @param {number} width - New width in pixels.
	 * @param {number} height - New height in pixels.
	 * @returns {void}
	 */
	resize(width, height) {
		this.#width = width;
		this.#height = height;
		this.#canvas.width = width;
		this.#canvas.height = height;
		this.#context.clearRect(0, 0, width, height);
	}

	/**
	 * Paint a decoded cursor rectangle.
	 *
	 * The cursor uses the same negotiated pixel format as the framebuffer, and
	 * is carried with a one-bit mask, so transparent pixels are `mask` set.
	 *
	 * @param {Uint8Array} pixels - RGB rows, three bytes per pixel.
	 * @param {Uint8Array} mask - One byte per pixel; non-zero is opaque.
	 * @returns {void}
	 */
	paint(pixels, mask) {
		const image = this.#context.createImageData(this.#width, this.#height);
		for (let index = 0; index < this.#width * this.#height; index++) {
			const opaque = mask[index] === 0 ? 0 : 255;
			image.data[index * 4] = pixels[index * 3];
			image.data[index * 4 + 1] = pixels[index * 3 + 1];
			image.data[index * 4 + 2] = pixels[index * 3 + 2];
			image.data[index * 4 + 3] = opaque;
		}
		this.#context.putImageData(image, 0, 0);
	}
}
