/**
 * A canvas stand-in, so the decoders can be tested outside a browser.
 *
 * Only the surface the plugin actually uses is implemented: a 2D context that
 * can allocate an `ImageData`-shaped buffer and accept one. No pixels are
 * composited, because every assertion in these tests reads the framebuffer
 * buffer directly rather than the canvas.
 */

/**
 * A fake canvas of a fixed size.
 */
export class StubCanvas {
	/**
	 * @param {number} width - Width in pixels.
	 * @param {number} height - Height in pixels.
	 */
	constructor(width = 1, height = 1) {
		this.width = width;
		this.height = height;
		this.blits = [];
	}

	/**
	 * The subset of `getContext` this plugin uses.
	 *
	 * @returns {object} A stub 2D context.
	 */
	getContext() {
		const canvas = this;
		return {
			createImageData(width, height) {
				return { width, height, data: new Uint8ClampedArray(width * height * 4) };
			},
			putImageData(image, dx, dy, dirtyX, dirtyY, dirtyWidth, dirtyHeight) {
				canvas.blits.push({
					dx: dx,
					dy: dy,
					x: dirtyX ?? 0,
					y: dirtyY ?? 0,
					width: dirtyWidth ?? image.width,
					height: dirtyHeight ?? image.height
				});
			},
			clearRect() {}
		};
	}
}

/**
 * Read one pixel out of a framebuffer buffer.
 *
 * @param {Uint8ClampedArray} data - The framebuffer buffer.
 * @param {number} width - Framebuffer width, for the row stride.
 * @param {number} x - Column.
 * @param {number} y - Row.
 * @returns {[number, number, number]} Red, green and blue.
 */
export function pixelAt(data, width, x, y) {
	const offset = (y * width + x) * 4;
	return [data[offset], data[offset + 1], data[offset + 2]];
}

/**
 * Describe a framebuffer buffer as a comparable string.
 *
 * @param {Uint8ClampedArray} data - The framebuffer buffer.
 * @returns {string} one hex triplet per pixel.
 */
export function pixels(data) {
	let out = "";
	for (let index = 0; index < data.length; index += 4) {
		out += `${data[index].toString(16).padStart(2, "0")}${data[index + 1].toString(16).padStart(2, "0")}${data[index + 2].toString(16).padStart(2, "0")} `;
	}
	return out.trim();
}
