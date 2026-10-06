import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MessageChannel } from 'node:worker_threads';

import { readCardTable, readScriptPack } from '../host/artifact.mjs';
import { PROTOCOL, createSession } from '../host/session.mjs';
import { CARDS, DECKS, DIST, SEED, browserEntry, cardReader, directDuel, stringify } from './vanilla.mjs';

const COLUMNS = ['code', 'alias', 'type', 'level', 'attribute', 'race', 'atk', 'def', 'lscale', 'rscale', 'link_marker', 'setcodes'];
const PRELUDE = new Map([
	['constant.lua', 'CONSTANT_LOADED = true'],
	['utility.lua', 'UTILITY_LOADED = CONSTANT_LOADED'],
]);
const SCRIPTS = new Map([...PRELUDE, ['COPYING', 'licence'], ['NOTICE', 'notice']]);
const encoder = new TextEncoder();

function cardTable(cards, { v = 1, columns = COLUMNS } = {}) {
	const field = (card) => ({ ...card, race: Number(card.race), atk: card.attack, def: card.defense, lscale: 0, rscale: 0, link_marker: 0 });
	return encoder.encode(JSON.stringify({ v, columns, cards: [...cards.values()].map((card) => columns.map((column) => field(card)[column])) }));
}

function scriptPack(entries, { magic = 'OCGS', version = 1 } = {}) {
	const sources = [...entries].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, source]) => [name, encoder.encode(source)]);
	const index = [];
	let offset = 0;
	for (const [name, bytes] of sources) {
		index.push([name, offset, bytes.length]);
		offset += bytes.length;
	}
	const head = encoder.encode(JSON.stringify(index));
	const pack = new Uint8Array(12 + head.length + offset);
	const view = new DataView(pack.buffer);
	pack.set(encoder.encode(magic), 0);
	view.setUint32(4, version, true);
	view.setUint32(8, head.length, true);
	pack.set(head, 12);
	let at = 12 + head.length;
	for (const [, bytes] of sources) {
		pack.set(bytes, at);
		at += bytes.length;
	}
	return pack;
}

{
	const table = readCardTable(cardTable(CARDS).buffer);
	assert.equal(table.count, CARDS.size);
	for (const [code, card] of CARDS) assert.deepEqual(table.read(code), { ...card, race: Number(card.race), lscale: 0, rscale: 0, linkMarker: 0 }, `card ${code}`);
	assert.equal(table.read(999), null, 'a code the table lacks reads as no card');
	const reversed = readCardTable(cardTable(CARDS, { columns: [...COLUMNS].reverse() }));
	assert.deepEqual(reversed.read(7), table.read(7), 'the columns are read by name, not by place');
	assert.throws(() => readCardTable(cardTable(CARDS, { v: 2 })), /version 2/);
	assert.throws(() => readCardTable(cardTable(CARDS, { columns: COLUMNS.filter((column) => column !== 'link_marker') })), /no link_marker column/);
	assert.throws(() => readCardTable('{}'), /ArrayBuffer/);

	const bytes = scriptPack(SCRIPTS);
	const pack = readScriptPack(bytes);
	assert.equal(pack.count, SCRIPTS.size, 'the licence and its notice are entries too');
	for (const [name, source] of SCRIPTS) assert.equal(pack.read(name), source);
	assert.equal(pack.read('c1.lua'), null, 'a script the pack lacks reads as none');
	const framed = new Uint8Array(bytes.length + 8);
	framed.set(bytes, 4);
	assert.equal(readScriptPack(framed.subarray(4, 4 + bytes.length)).read('utility.lua'), PRELUDE.get('utility.lua'), 'a view is read from where it starts');
	assert.throws(() => readScriptPack(scriptPack(SCRIPTS, { magic: 'NOPE' })), /bad magic/);
	assert.throws(() => readScriptPack(scriptPack(SCRIPTS, { version: 2 })), /version 2/);
	assert.throws(() => readScriptPack(bytes.subarray(0, bytes.length - 1)), /runs past the blob/);
	console.log(`artifact  ok  ${table.count} rows, ${pack.count} pack entries`);
}

const direct = await directDuel(await browserEntry());

function duelOver(post, inbox) {
	let decision = 0;
	return new Promise((resolve) => {
		inbox.on('message', (frame) => {
			if (frame.type === 'step' && frame.prompt !== null) post({ type: 'answer', kind: frame.prompt.kind, reply: direct.replies[decision++] });
			if (frame.type === 'end') resolve();
		});
	});
}

const expected = await (async () => {
	const { port1, port2 } = new MessageChannel();
	const session = createSession({ instantiate: await browserEntry(), cardReader, scriptReader: (name) => SCRIPTS.get(name) ?? null, prelude: [...PRELUDE.keys()] });
	const outlet = session.attach({ seats: [0, 1], send: (frame) => port1.postMessage(frame) });
	port1.on('message', (frame) => outlet.receive(frame));
	const frames = [];
	port2.on('message', (frame) => frames.push(frame));
	const over = duelOver((frame) => port2.postMessage(frame), port2);
	port2.postMessage({ type: 'open', protocol: PROTOCOL, seed: SEED.map(String), decks: DECKS });
	await over;
	session.close();
	port1.close();
	return frames;
})();

{
	const fetched = [];
	const { port1: scope, port2: page } = new MessageChannel();
	const listeners = [];
	globalThis.self = {
		postMessage: (frame) => scope.postMessage(frame),
		addEventListener: (type, listener) => type === 'message' && listeners.push(listener),
	};
	scope.on('message', (data) => listeners.forEach((listener) => listener({ data })));
	globalThis.fetch = async (url) => {
		fetched.push(String(url));
		return new Response(await readFile(new URL(url)), { headers: { 'content-type': 'application/wasm' } });
	};
	await import(new URL('browser/worker.mjs', DIST));
	assert.equal(listeners.length, 1, 'the entry listens on its scope');

	const frames = [];
	page.on('message', (frame) => frames.push(frame));
	const post = (frame, transfer = []) => page.postMessage(frame, transfer);
	const refusal = async (frame, refused) => {
		const before = frames.length;
		post(frame);
		for (let tick = 0; frames.length === before && tick < 1000; tick++) await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(frames.length, before + 1, `one answer to ${frame.type}`);
		const answer = frames.at(-1);
		assert.equal(answer.type, 'error');
		assert.equal(answer.refused, refused);
		return answer.message;
	};

	assert.match(await refusal({ type: 'open', protocol: PROTOCOL, seed: SEED.map(String), decks: DECKS }, 'open'), /first frame is load/);
	assert.match(await refusal({ type: 'load', cards: cardTable(CARDS), scripts: scriptPack(SCRIPTS, { magic: 'NOPE' }) }, 'load'), /bad magic/);
	assert.match(await refusal({ type: 'load', cards: cardTable(CARDS, { v: 2 }), scripts: scriptPack(SCRIPTS) }, 'load'), /version 2/);
	assert.match(await refusal({ type: 'load' }, 'load'), /ArrayBuffer/);
	assert.equal(fetched.length, 0, 'nothing is fetched before a duel opens');
	frames.length = 0;

	const cards = cardTable(CARDS).buffer;
	const scripts = scriptPack(SCRIPTS).buffer;
	post({ type: 'load', cards, scripts }, [cards, scripts]);
	assert.equal(cards.byteLength + scripts.byteLength, 0, 'the bytes are transferred, not copied');
	const over = duelOver(post, page);
	post({ type: 'open', protocol: PROTOCOL, seed: SEED.map(String), decks: DECKS });
	await over;
	assert.deepEqual(fetched, [new URL('browser/ocgcore.wasm', DIST).href], 'the engine fetches its wasm from beside the entry, once');
	assert.equal(frames.at(-1).type, 'end');
	assert.equal(frames.at(-1).reason, 'win');
	assert.equal(frames.at(-1).decisions, direct.decisions);
	assert.equal(stringify(frames), stringify(expected), 'the entry plays the duel a session over the same rows and scripts plays, frame for frame');

	assert.match(await refusal({ type: 'load', cards: cardTable(CARDS), scripts: scriptPack(SCRIPTS) }, 'load'), /unknown frame/);
	scope.close();
	console.log(`entry     ok  ${frames.length} frames, ${direct.decisions} decisions`);
}
