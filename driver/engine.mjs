import { CREATION, DUEL_STATUS, LOG_TYPE } from './constants.mjs';
import { Heap } from './memory.mjs';
import { decodeMessages } from './messages.mjs';
import { decodeQuery, decodeQueryField, decodeQueryLocation } from './queries.mjs';
import { encodeResponse } from './responses.mjs';

const CREATION_NAME = Object.fromEntries(Object.entries(CREATION).map(([name, value]) => [value, name]));
const PAGE = 65_536;
const LANDING_ASKS = 0x8000_0000;

export async function createEngine(instantiate, { log = defaultLog } = {}) {
	const duels = new Map();
	const module = await instantiate({
		print: (text) => log({ channel: 'stdout', text }),
		printErr: (text) => log({ channel: 'stderr', text }),
		handleDataReader: (payload, code, pointer) => duels.get(payload)?.readCard(code, pointer),
		handleScriptReader: (payload, _duel, name) => duels.get(payload)?.readScript(name) ?? null,
		handleLogHandler: (payload, text, type) => (duels.get(payload)?.log ?? log)({ channel: 'core', type, text }),
	});
	const heap = new Heap(module.wasmMemory);
	let nextPayload = 1;

	const upload = (bytes) => {
		const pointer = module._malloc(bytes.length + 1);
		heap.bytes.set(bytes, pointer);
		heap.bytes[pointer + bytes.length] = 0;
		return pointer;
	};
	const utf8 = new TextEncoder();

	const engine = {
		module,
		memory: module.wasmMemory,

		version() {
			const out = module._malloc(8);
			module._ocgapiGetVersion(out, out + 4);
			const version = [heap.view.getInt32(out, true), heap.view.getInt32(out + 4, true)];
			module._free(out);
			return version;
		},

		snapshot() {
			return new Uint8Array(module.wasmMemory.buffer.slice(0));
		},

		restore(bytes) {
			const shortfall = bytes.length - module.wasmMemory.buffer.byteLength;
			if (shortfall > 0) {
				const block = module._malloc(shortfall + PAGE);
				if (!block) throw new Error(`restore: could not grow memory by ${shortfall} bytes`);
				module._free(block);
				if (module.wasmMemory.buffer.byteLength < bytes.length) throw new Error('restore: memory did not grow to the snapshot');
			}
			heap.bytes.set(bytes);
			heap.bytes.fill(0, bytes.length);
		},

		createDuel({ seed, flags, team1, team2, cardReader, scriptReader, clock, log: duelLog = log }) {
			if (!Array.isArray(seed) || seed.length !== 4) throw new TypeError('seed: four 64-bit words');
			if (typeof clock !== 'number') throw new TypeError('clock: the millisecond time the duel is created at');
			const payload = nextPayload++;
			duels.set(payload, readers(cardReader, scriptReader, duelLog));

			const options = module._malloc(104);
			const out = module._malloc(4);
			{
				const view = heap.view;
				heap.bytes.fill(0, options, options + 104);
				seed.forEach((word, index) => view.setBigUint64(options + 8 * index, BigInt(word), true));
				view.setBigUint64(options + 32, BigInt(flags), true);
				for (const [team, at] of [[team1, 40], [team2, 52]]) {
					view.setUint32(options + at, team.startingLP, true);
					view.setUint32(options + at + 4, team.startingDrawCount, true);
					view.setUint32(options + at + 8, team.drawCountPerTurn, true);
				}
				for (const at of [68, 76, 84, 92]) view.setUint32(options + at, payload, true);
			}
			const status = withClock(clock, () => module._ocgapiCreateDuel(out, options));
			const handle = heap.view.getUint32(out, true);
			module._free(options);
			module._free(out);
			if (status !== CREATION.SUCCESS) {
				duels.delete(payload);
				throw new Error(`createDuel: ${CREATION_NAME[status] ?? status}`);
			}
			return duelOn(handle, payload, clock, () => duels.delete(payload));
		},

		attach({ handle, payload, clock, cardReader, scriptReader, log: duelLog = log }) {
			duels.set(payload, readers(cardReader, scriptReader, duelLog));
			if (payload >= nextPayload) nextPayload = payload + 1;
			return duelOn(handle, payload, clock, () => duels.delete(payload));
		},
	};

	function readers(cardReader, scriptReader, duelLog) {
		return {
			log: duelLog,
			readScript: scriptReader,
			readCard(code, pointer) {
				const row = cardReader(code);
				if (!row) return;
				const setcodes = row.setcodes ?? [];
				const list = module._malloc(2 * (setcodes.length + 1));
				const view = heap.view;
				setcodes.forEach((setcode, index) => view.setUint16(list + 2 * index, setcode, true));
				view.setUint16(list + 2 * setcodes.length, 0, true);
				view.setUint32(pointer, row.code, true);
				view.setUint32(pointer + 4, row.alias ?? 0, true);
				view.setUint32(pointer + 8, list, true);
				view.setUint32(pointer + 12, row.type ?? 0, true);
				view.setUint32(pointer + 16, row.level ?? 0, true);
				view.setUint32(pointer + 20, row.attribute ?? 0, true);
				view.setBigUint64(pointer + 24, BigInt(row.race ?? 0), true);
				view.setInt32(pointer + 32, row.attack ?? 0, true);
				view.setInt32(pointer + 36, row.defense ?? 0, true);
				view.setUint32(pointer + 40, row.lscale ?? 0, true);
				view.setUint32(pointer + 44, row.rscale ?? 0, true);
				view.setUint32(pointer + 48, row.linkMarker ?? 0, true);
			},
		};
	}

	function duelOn(handle, payload, clock, release) {
		const call = (fn) => withClock(clock, fn);
		const lengthOut = module._malloc(4);
		const readBuffer = (pointer) => {
			const length = heap.view.getUint32(lengthOut, true);
			return pointer && length ? heap.bytes.slice(pointer, pointer + length) : new Uint8Array(0);
		};
		const queryInfo = ({ flags, controller, location, sequence = 0, overlaySequence = 0 }) => {
			const info = module._malloc(20);
			const view = heap.view;
			view.setUint32(info, flags, true);
			view.setUint8(info + 4, controller);
			view.setUint32(info + 8, location, true);
			view.setUint32(info + 12, sequence, true);
			view.setUint32(info + 16, overlaySequence, true);
			return info;
		};
		let alive = true;

		return {
			handle,
			payload,
			clock,

			loadScript(name, source) {
				const namePointer = upload(utf8.encode(name));
				const bytes = utf8.encode(source);
				const sourcePointer = upload(bytes);
				try {
					return call(() => module._ocgapiLoadScript(handle, sourcePointer, bytes.length, namePointer)) !== 0;
				} finally {
					module._free(sourcePointer);
					module._free(namePointer);
				}
			},

			newCard({ team, duelist = 0, code, controller, location, sequence, position }) {
				const info = module._malloc(24);
				const view = heap.view;
				heap.bytes.fill(0, info, info + 24);
				view.setUint8(info, team);
				view.setUint8(info + 1, duelist);
				view.setUint32(info + 4, code, true);
				view.setUint8(info + 8, controller);
				view.setUint32(info + 12, location, true);
				view.setUint32(info + 16, sequence, true);
				view.setUint32(info + 20, position, true);
				call(() => module._ocgapiDuelNewCard(handle, info));
				module._free(info);
			},

			start() {
				call(() => module._ocgapiStartDuel(handle));
			},

			process() {
				return call(() => module._ocgapiDuelProcess(handle));
			},

			messages() {
				const pointer = call(() => module._ocgapiDuelGetMessage(handle, lengthOut));
				return decodeMessages(readBuffer(pointer));
			},

			respond(kind, answer) {
				this.respondBytes(encodeResponse(kind, answer));
			},

			respondBytes(bytes) {
				const pointer = upload(bytes);
				call(() => module._ocgapiDuelSetResponse(handle, pointer, bytes.length));
				module._free(pointer);
			},

			query(info) {
				const pointer = queryInfo(info);
				const result = call(() => module._ocgapiDuelQuery(handle, lengthOut, pointer));
				module._free(pointer);
				return decodeQuery(readBuffer(result));
			},

			queryLocation(info) {
				const pointer = queryInfo(info);
				const result = call(() => module._ocgapiDuelQueryLocation(handle, lengthOut, pointer));
				module._free(pointer);
				return decodeQueryLocation(readBuffer(result));
			},

			queryField() {
				const result = call(() => module._ocgapiDuelQueryField(handle, lengthOut));
				return decodeQueryField(readBuffer(result));
			},

			queryCount(team, location) {
				return call(() => module._ocgapiDuelQueryCount(handle, team, location));
			},

			summonLanding({ controller, location, sequence }, kind) {
				const read = call(() => module._ocgapiDuelSummonLanding(handle, controller, location, sequence, kind)) >>> 0;
				if (read & LANDING_ASKS) return { asks: true };
				return { own: read & 0x7f, across: (read >>> 16) & 0x7f, positions: (read >>> 8) & 0xf };
			},

			destroy() {
				if (!alive) return;
				alive = false;
				call(() => module._ocgapiDestroyDuel(handle));
				module._free(lengthOut);
				release();
			},
		};
	}

	return engine;
}

function withClock(clock, fn) {
	const real = Date.now;
	Date.now = () => clock;
	try {
		return fn();
	} finally {
		Date.now = real;
	}
}

export function clockFromSeed(seed) {
	return 1_767_225_600_000 + Number(BigInt(seed[0]) % 86_400_000n);
}

function defaultLog(entry) {
	if (entry.channel === 'stdout' || (entry.channel === 'core' && entry.type !== LOG_TYPE.ERROR)) console.log(entry.text);
	else console.error(entry.text);
}

export { DUEL_STATUS };
