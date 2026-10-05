export class Heap {
	#memory;
	#buffer = null;
	#bytes = null;
	#view = null;

	constructor(memory) {
		this.#memory = memory;
	}

	#refresh() {
		if (this.#memory.buffer !== this.#buffer) {
			this.#buffer = this.#memory.buffer;
			this.#bytes = new Uint8Array(this.#buffer);
			this.#view = new DataView(this.#buffer);
		}
	}

	get bytes() {
		this.#refresh();
		return this.#bytes;
	}

	get view() {
		this.#refresh();
		return this.#view;
	}
}

export class Reader {
	constructor(bytes, start = 0, end = bytes.length) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.at = start;
		this.end = end;
	}

	get remaining() {
		return this.end - this.at;
	}

	#need(size) {
		if (this.at + size > this.end) throw new RangeError(`read of ${size} bytes at ${this.at} passes the end at ${this.end}`);
	}

	u8() {
		this.#need(1);
		return this.view.getUint8(this.at++);
	}

	i8() {
		this.#need(1);
		return this.view.getInt8(this.at++);
	}

	u16() {
		this.#need(2);
		const value = this.view.getUint16(this.at, true);
		this.at += 2;
		return value;
	}

	u32() {
		this.#need(4);
		const value = this.view.getUint32(this.at, true);
		this.at += 4;
		return value;
	}

	i32() {
		this.#need(4);
		const value = this.view.getInt32(this.at, true);
		this.at += 4;
		return value;
	}

	u64() {
		this.#need(8);
		const value = this.view.getBigUint64(this.at, true);
		this.at += 8;
		return value;
	}

	take(size) {
		this.#need(size);
		const out = this.bytes.slice(this.at, this.at + size);
		this.at += size;
		return out;
	}

	list(count, read) {
		const out = [];
		for (let index = 0; index < count; index++) out.push(read(this));
		return out;
	}
}

export class Writer {
	#bytes = new Uint8Array(64);
	#view = new DataView(this.#bytes.buffer);
	#at = 0;

	#room(size) {
		if (this.#at + size <= this.#bytes.length) return;
		const grown = new Uint8Array(Math.max(this.#bytes.length * 2, this.#at + size));
		grown.set(this.#bytes);
		this.#bytes = grown;
		this.#view = new DataView(grown.buffer);
	}

	u8(value) {
		this.#room(1);
		this.#view.setUint8(this.#at++, value);
		return this;
	}

	i8(value) {
		this.#room(1);
		this.#view.setInt8(this.#at++, value);
		return this;
	}

	i16(value) {
		this.#room(2);
		this.#view.setInt16(this.#at, value, true);
		this.#at += 2;
		return this;
	}

	u16(value) {
		this.#room(2);
		this.#view.setUint16(this.#at, value, true);
		this.#at += 2;
		return this;
	}

	i32(value) {
		this.#room(4);
		this.#view.setInt32(this.#at, value, true);
		this.#at += 4;
		return this;
	}

	u32(value) {
		this.#room(4);
		this.#view.setUint32(this.#at, value, true);
		this.#at += 4;
		return this;
	}

	u64(value) {
		this.#room(8);
		this.#view.setBigUint64(this.#at, BigInt(value), true);
		this.#at += 8;
		return this;
	}

	bytes() {
		return this.#bytes.slice(0, this.#at);
	}
}
