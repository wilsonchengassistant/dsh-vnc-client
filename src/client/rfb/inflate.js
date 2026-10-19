/**
 * zlib decompression for the compressed RFB encodings.
 *
 * Tight and ZRLE both wrap their payload in a zlib stream. Rather than ship an
 * inflate implementation, this uses the platform's: `DecompressionStream` has
 * been in every engine DSH's browser client targets (and in Node, which is what
 * makes these decoders testable outside a browser at all).
 *
 * The consequence is that decoding is asynchronous, which shapes the protocol
 * loop: {@link RfbClient} parses one server message at a time and awaits it
 * before touching the next, rather than overlapping decodes onto one buffer.
 */

/** The stream format RFB uses: a zlib wrapper, not raw DEFLATE. */
const ZLIB_FORMAT = "deflate";

/**
 * Inflate one zlib stream.
 *
 * @param {Uint8Array} bytes - The compressed stream, exactly as received.
 * @returns {Promise<Uint8Array>} the decompressed bytes.
 */
export async function inflate(bytes) {
	if (bytes.length === 0) return new Uint8Array(0);
	const source = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(ZLIB_FORMAT));
	const buffer = await new Response(source).arrayBuffer();
	return new Uint8Array(buffer);
}

/**
 * Inflate one zlib stream and read exactly `length` bytes from it.
 *
 * ZRLE always knows how many bytes its result holds, so a stream that decodes
 * to the wrong length means the stream and the rectangle disagree — which is
 * reported rather than silently padded or truncated.
 *
 * @param {Uint8Array} bytes - The compressed stream.
 * @param {number} length - How many bytes the protocol says it holds.
 * @returns {Promise<Uint8Array>} exactly `length` decompressed bytes.
 */
export async function inflateExact(bytes, length) {
	const plain = await inflate(bytes);
	if (plain.length !== length) {
		throw new Error(`a zlib stream decoded to ${plain.length} bytes where the protocol declared ${length}`);
	}
	return plain;
}

/**
 * Concatenate compressed segments into one zlib stream, then inflate.
 *
 * A zlib stream can legitimately arrive in several pieces when an encoder
 * flushes mid-rectangle; each piece resumes the same stream, so they are
 * joined before decompression rather than inflated separately.
 *
 * @param {Uint8Array[]} segments - Compressed segments, in order.
 * @returns {Promise<Uint8Array>} the decompressed bytes.
 */
export async function inflateSegments(segments) {
	if (segments.length === 1) return inflate(segments[0]);
	let total = 0;
	for (const segment of segments) total += segment.length;
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const segment of segments) {
		joined.set(segment, offset);
		offset += segment.length;
	}
	return inflate(joined);
}

/**
 * One zlib stream that outlives the rectangle carrying a chunk of it.
 *
 * Both Tight (four streams) and ZRLE (one) keep their deflate state across
 * rectangles: each rectangle appends to a stream that started earlier, and the
 * protocol guarantees a flush at every boundary. That rules out
 * `inflate()` per rectangle, and it also rules out simply holding a
 * `DecompressionStream` open and awaiting it, because a stream that is not
 * closed has no "done" signal.
 *
 * What makes it tractable is that the protocol always states how many bytes a
 * chunk decodes to. So this feeds compressed bytes in and collects exactly
 * that many bytes out, which is a well-defined stopping point even though the
 * stream itself is still open. Any surplus produced past that point is held
 * as pushback for the next chunk.
 */
export class PersistentZlib {
	#transform;
	#writer;
	#reader;
	#pushback = null;
	#error = null;
	#pending = null;

	/**
	 * Start a fresh stream.
	 *
	 * @returns {void}
	 */
	constructor() {
		this.#transform = new DecompressionStream(ZLIB_FORMAT);
		this.#writer = this.#transform.writable.getWriter();
		this.#reader = this.#transform.readable.getReader();
	}

	/**
	 * Discard this stream and start a new one at the next byte boundary.
	 *
	 * Called when the server sets a reset flag, and when a connection is
	 * reused: the old stream's back-reference window is no longer valid for
	 * anything that follows.
	 *
	 * @returns {void}
	 */
	reset() {
		this.#pushback = null;
		this.#pending?.catch(() => {});
		this.#writer?.cancel().catch(() => {});
		this.#reader?.cancel().catch(() => {});
		this.#transform = new DecompressionStream(ZLIB_FORMAT);
		this.#writer = this.#transform.writable.getWriter();
		this.#reader = this.#transform.readable.getReader();
	}

	/**
	 * Append compressed bytes to the stream.
	 *
	 * The returned promise deliberately settles only once the readable side has
	 * drained, so it is not awaited here: awaiting a write before reading is a
	 * deadlock against the readable side's own high-water mark. Failures are
	 * captured and re-thrown from the next read instead.
	 *
	 * @param {Uint8Array} bytes - Compressed bytes to append.
	 * @returns {void}
	 */
	write(bytes) {
		if (bytes.length === 0) return;
		this.#error = null;
		this.#pending = this.#writer.write(bytes);
		this.#pending.catch((error) => {
			this.#error = error;
		});
	}

	/**
	 * Take the next decoded chunk.
	 *
	 * @returns {Promise<Uint8Array | null>} the next bytes, or null at stream end.
	 */
	async chunk() {
		if (this.#pushback !== null) {
			const held = this.#pushback;
			this.#pushback = null;
			return held;
		}
		if (this.#error !== null) {
			const error = this.#error;
			this.#error = null;
			throw error;
		}
		const { value, done } = await this.#reader.read();
		return done ? null : value;
	}

	/**
	 * Take exactly `count` decoded bytes.
	 *
	 * Only usable where the protocol declares the decoded size in advance —
	 * Tight, where a rectangle's filtered length is known from its geometry.
	 * ZRLE, whose decoded size depends on choices only the encoder made, is
	 * read a chunk at a time instead.
	 *
	 * @param {number} count - How many bytes to return.
	 * @returns {Promise<Uint8Array>} exactly `count` bytes.
	 */
	async take(count) {
		const out = new Uint8Array(count);
		let filled = 0;
		while (filled < count) {
			const next = await this.chunk();
			if (next === null) {
				throw new Error("a zlib stream ended before the declared number of bytes was decoded");
			}
			const take = Math.min(next.length, count - filled);
			out.set(next.subarray(0, take), filled);
			filled += take;
			if (take < next.length) this.#pushback = next.subarray(take);
		}
		return out;
	}

	/**
	 * Append compressed bytes and return exactly the bytes they decode to.
	 *
	 * @param {Uint8Array} compressed - Bytes to append.
	 * @param {number} count - How many decoded bytes to return.
	 * @returns {Promise<Uint8Array>} the decoded bytes.
	 */
	async push(compressed, count) {
		this.write(compressed);
		return this.take(count);
	}

	/**
	 * Close the stream and release its locks.
	 *
	 * @returns {void}
	 */
	close() {
		this.#pushback = null;
		this.#pending?.catch(() => {});
		this.#writer?.releaseLock();
		this.#reader?.releaseLock();
		this.#writer = void 0;
		this.#reader = void 0;
	}
}
