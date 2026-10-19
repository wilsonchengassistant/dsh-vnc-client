/**
 * A cursor over the RFB byte stream.
 *
 * The stream arrives in WebSocket messages whose boundaries have nothing to do
 * with the protocol's message boundaries, so every read is out of a rolling
 * buffer and the cursor tracks how much of it has been consumed.
 */

/** Thrown when a read runs past the end of the available bytes. */
export class RfbTruncated extends Error {
	/**
	 * @param {number} wanted - Bytes the read needed.
	 * @param {number} available - Bytes actually present.
	 */
	constructor(wanted, available) {
		super(`the RFB stream ended mid-read: needed ${wanted} bytes, had ${available}`);
		this.name = "RfbTruncated";
	}
}

/** Sequential big-endian reader over a byte buffer. */
export class Reader {
	#bytes;
	#view;
	#offset;

	/**
	 * @param {Uint8Array} bytes - Bytes to read.
	 * @param {number} offset - Starting position.
	 */
	constructor(bytes, offset = 0) {
		this.#bytes = bytes;
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.#offset = offset;
	}

	/** Current position. */
	get offset() {
		return this.#offset;
	}

	/** Set the current position. */
	set offset(value) {
		this.#offset = value;
	}

	/** Bytes not yet consumed. */
	get remaining() {
		return this.#bytes.length - this.#offset;
	}

	/**
	 * Require at least `count` more bytes, or fail loudly.
	 *
	 * A protocol desynchronization is unrecoverable — every subsequent offset
	 * would be wrong — so this throws rather than returning short data.
	 *
	 * @param {number} count - Bytes the caller is about to read.
	 * @returns {void}
	 */
	#require(count) {
		if (this.remaining < count) throw new RfbTruncated(count, this.remaining);
	}

	/** @returns {number} one unsigned byte. */
	u8() {
		this.#require(1);
		return this.#bytes[this.#offset++];
	}

	/** @returns {number} one signed byte. */
	i8() {
		this.#require(1);
		return this.#view.getInt8(this.#offset++);
	}

	/** @returns {number} one unsigned 16-bit big-endian value. */
	u16() {
		this.#require(2);
		const value = this.#view.getUint16(this.#offset);
		this.#offset += 2;
		return value;
	}

	/** @returns {number} one signed 16-bit big-endian value. */
	i16() {
		this.#require(2);
		const value = this.#view.getInt16(this.#offset);
		this.#offset += 2;
		return value;
	}

	/** @returns {number} one unsigned 32-bit big-endian value. */
	u32() {
		this.#require(4);
		const value = this.#view.getUint32(this.#offset);
		this.#offset += 4;
		return value;
	}

	/** @returns {number} one signed 32-bit big-endian value. */
	i32() {
		this.#require(4);
		const value = this.#view.getInt32(this.#offset);
		this.#offset += 4;
		return value;
	}

	/**
 * *Look at* a run of bytes without consuming them.
 *
 * Used to read a length field that is itself variable-width: the probe reads
 * it, the caller checks whether the payload that follows is present, and only
 * then consumes. Consuming first would make a short read unrecoverable, because
 * the cursor would already have moved.
 *
 * @param {number} count - Bytes to look at.
 * @returns {Uint8Array} a view over those bytes.
 */
	peek(count) {
		this.#require(count);
		return this.#bytes.subarray(this.#offset, this.#offset + count);
	}

	/**
	 * Read a run of bytes as a view over the same buffer, without copying.
	 *
	 * @param {number} count - Bytes to take.
	 * @returns {Uint8Array} the bytes.
	 */
	bytes(count) {
		this.#require(count);
		const slice = this.#bytes.subarray(this.#offset, this.#offset + count);
		this.#offset += count;
		return slice;
	}

	/**
	 * Read a run of bytes as a copy.
	 *
	 * @param {number} count - Bytes to take.
	 * @returns {Uint8Array} an independent copy.
	 */
	copy(count) {
		return Uint8Array.prototype.slice.call(this.bytes(count));
	}

	/**
	 * Skip forward without reading.
	 *
	 * @param {number} count - Bytes to pass over.
	 * @returns {void}
	 */
	skip(count) {
		this.#require(count);
		this.#offset += count;
	}
}
