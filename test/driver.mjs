import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { generate } from '../tools/constants.mjs';
import { Writer } from '../driver/memory.mjs';
import {
	ATTRIBUTE, DUEL, DUEL_STATUS, LOCATION, LOG_TYPE, MSG, MSG_NAME, POS, QUERY, RACE,
	advance, clockFromSeed, createEngine, decodeMessages, encodeResponse, loadDecks, play, replay, shuffled,
} from '../driver/index.mjs';
import { CARDS, DECKS, DIST, SEED, TEAM, bot, browserEntry, cardReader, stringify } from './vanilla.mjs';

const HERE = new URL('./', import.meta.url);

{
	const constants = await readFile(new URL('../core/ocgapi_constants.h', HERE), 'utf8');
	const types = await readFile(new URL('../core/ocgapi_types.h', HERE), 'utf8');
	assert.equal(await readFile(new URL('../driver/constants.mjs', HERE), 'utf8'), generate(constants, types), 'driver/constants.mjs is stale: node tools/constants.mjs');
	console.log('constants  ok');
}

const browser = await browserEntry();
const workerdModule = await WebAssembly.compile(await readFile(new URL('workerd/ocgcore.wasm', DIST)));
const { instantiate } = await import(new URL('workerd/instantiate.mjs', DIST));
const workerd = (options) => instantiate(workerdModule, options);

async function startDuel(entry, { seed = SEED, shuffle = true } = {}) {
	const lines = [];
	const engine = await createEngine(entry, { log: (entry) => lines.push(entry) });
	const duel = engine.createDuel({ seed, flags: DUEL.MODE_MR5, team1: TEAM, team2: TEAM, cardReader, scriptReader: () => null, clock: clockFromSeed(seed) });
	const orders = loadDecks(duel, DECKS, { seed, shuffle });
	duel.start();
	return { engine, duel, orders, lines };
}

function playOut(duel, answer = bot, options = {}) {
	const messages = [];
	const log = [];
	const result = play(
		duel,
		(prompt, batch) => {
			const response = answer(prompt, batch);
			if (response !== undefined) log.push({ kind: prompt.kind, answer: response });
			return response;
		},
		{ ...options, onBatch: (batch) => messages.push(...batch.messages) },
	);
	return { result, messages, log };
}

const streams = {};
for (const [name, entry] of [['browser', browser], ['workerd', workerd]]) {
	const { engine, duel, lines } = await startDuel(entry);
	assert.deepEqual(engine.version(), [11, 0]);
	const { result, messages, log } = playOut(duel);
	assert.equal(result.reason, 'win', `${name}: ${stringify(result)}`);
	assert.ok(result.decisions > 50, `${name}: ${result.decisions} decisions`);
	assert.deepEqual(lines, [], `${name}: the core logged ${stringify(lines)}`);
	const kinds = new Set(messages.map((message) => MSG_NAME[message.kind]));
	for (const expected of ['DRAW', 'NEW_TURN', 'NEW_PHASE', 'MOVE', 'SUMMONING', 'SUMMONED', 'ATTACK', 'BATTLE', 'DAMAGE', 'SELECT_IDLECMD', 'SELECT_BATTLECMD', 'SELECT_PLACE', 'SELECT_CHAIN', 'WIN']) {
		assert.ok(kinds.has(expected), `${name}: no ${expected} in the stream`);
	}
	const field = duel.queryField();
	assert.ok(field.players.some((player) => player.lp <= 0), `${name}: no player at or below 0 LP: ${stringify(field.players.map((player) => player.lp))}`);
	assert.equal(field.players[0].monsterZones.length, 7);
	assert.equal(field.players[0].spellZones.length, 8);
	const grave = duel.queryLocation({ controller: 0, location: LOCATION.GRAVE, flags: QUERY.CODE | QUERY.ATTACK | QUERY.REASON | QUERY.REASON_CARD | QUERY.IS_PUBLIC });
	assert.ok(grave.length > 0 && grave.every((card) => card && CARDS.has(card.code) && card.attack === CARDS.get(card.code).attack), `${name}: grave query`);
	assert.ok(grave.some((card) => card.reasonCard !== null), `${name}: a destroyed card names what destroyed it`);
	assert.equal(duel.query({ controller: 0, location: LOCATION.GRAVE, sequence: 0, flags: QUERY.CODE }).code, grave[0].code);
	assert.equal(duel.query({ controller: 0, location: LOCATION.MZONE, sequence: 6, flags: QUERY.CODE }), null, `${name}: an empty zone is null`);
	assert.equal(duel.queryCount(0, LOCATION.GRAVE), grave.length);
	streams[name] = { messages: stringify(messages), log, decisions: result.decisions };
	duel.destroy();
	console.log(`${name.padEnd(9)} ok  ${messages.length} messages, ${result.decisions} decisions, ${kinds.size} kinds`);
}
assert.equal(streams.browser.messages, streams.workerd.messages, 'the two entries diverged');

{
	const { duel } = await startDuel(browser);
	const { result, messages } = playOut(duel, replay(streams.browser.log));
	assert.equal(result.reason, 'win');
	assert.equal(stringify(messages), streams.browser.messages, 'the replayed stream differs');
	duel.destroy();
	console.log('replay    ok');
}

{
	assert.notDeepEqual(shuffled(DECKS[0].main, SEED, 0), shuffled(DECKS[0].main, SEED, 1), 'both seats dealt the same order');
	assert.notDeepEqual(shuffled(DECKS[0].main, SEED, 0), shuffled(DECKS[0].main, [5n, 6n, 7n, 8n], 0), 'two seeds dealt the same order');
	assert.deepEqual(shuffled(DECKS[0].main, SEED, 0), shuffled(DECKS[0].main, SEED, 0));
	const { duel: seeded } = await startDuel(browser, { seed: [9n, 9n, 9n, 9n] });
	const other = playOut(seeded);
	assert.notEqual(stringify(other.messages), streams.browser.messages, 'a different seed played the same duel');
	seeded.destroy();

	const { duel, orders } = await startDuel(browser, { shuffle: false });
	assert.deepEqual(orders[0].main, DECKS[0].main);
	const first = advance(duel);
	const draw = first.messages.find((message) => message.kind === MSG.DRAW && message.player === 0);
	assert.deepEqual(draw.cards.map((card) => card.code), DECKS[0].main.slice(0, 5), 'an unshuffled deck is drawn top first, as listed');
	duel.destroy();
	console.log('deal      ok');
}

{
	const { engine, duel } = await startDuel(browser);
	const opening = playOut(duel, bot, { decisionCap: 30 });
	assert.equal(opening.result.reason, 'decision-cap');
	const snapshot = engine.snapshot();
	const tail = playOut(duel);
	assert.equal(tail.result.reason, 'win');

	engine.restore(snapshot);
	const again = playOut(duel);
	assert.equal(stringify(again.messages), stringify(tail.messages), 'the restored duel played a different tail');

	const fresh = await createEngine(browser);
	fresh.restore(snapshot);
	const adopted = fresh.attach({ handle: duel.handle, payload: duel.payload, clock: duel.clock, cardReader, scriptReader: () => null });
	const elsewhere = playOut(adopted);
	assert.equal(stringify(elsewhere.messages), stringify(tail.messages), 'the duel restored on a fresh engine played a different tail');
	adopted.destroy();
	duel.destroy();
	console.log(`snapshot  ok  ${snapshot.length} bytes, tail of ${tail.messages.length} messages reproduced twice`);
}

{
	const { duel, lines } = await startDuel(browser);
	assert.equal(duel.loadScript('broken.lua', 'this is not lua'), false);
	assert.ok(lines.some((line) => line.channel === 'core' && line.type === LOG_TYPE.ERROR && /broken\.lua/.test(line.text)), stringify(lines));
	assert.equal(duel.loadScript('fine.lua', 'local x = 1'), true);
	duel.destroy();
	console.log('log       ok');
}

{
	const bytes = (kind, answer) => [...encodeResponse(kind, answer)];
	assert.deepEqual(bytes(MSG.SELECT_IDLECMD, { action: 5, index: 3 }), [5, 0, 3, 0]);
	assert.deepEqual(bytes(MSG.SELECT_BATTLECMD, { action: 3 }), [3, 0, 0, 0]);
	assert.deepEqual(bytes(MSG.SELECT_EFFECTYN, true), [1, 0, 0, 0]);
	assert.deepEqual(bytes(MSG.SELECT_YESNO, false), [0, 0, 0, 0]);
	assert.deepEqual(bytes(MSG.SELECT_OPTION, 2), [2, 0, 0, 0]);
	assert.deepEqual(bytes(MSG.SELECT_CARD, [1, 0]), [0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
	assert.deepEqual(bytes(MSG.SELECT_CARD, null), [255, 255, 255, 255]);
	assert.deepEqual(bytes(MSG.SELECT_TRIBUTE, [4]), [0, 0, 0, 0, 1, 0, 0, 0, 4, 0, 0, 0]);
	assert.deepEqual(bytes(MSG.SELECT_SUM, [0, 2]), [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0]);
	assert.throws(() => encodeResponse(MSG.SELECT_SUM, null));
	assert.deepEqual(bytes(MSG.SELECT_UNSELECT_CARD, 7), [1, 0, 0, 0, 7, 0, 0, 0]);
	assert.deepEqual(bytes(MSG.SELECT_UNSELECT_CARD, null), [255, 255, 255, 255]);
	assert.deepEqual(bytes(MSG.SELECT_CHAIN, null), [255, 255, 255, 255]);
	assert.deepEqual(bytes(MSG.SELECT_CHAIN, 1), [1, 0, 0, 0]);
	assert.deepEqual(bytes(MSG.SELECT_PLACE, [{ player: 1, location: LOCATION.SZONE, sequence: 2 }]), [1, 8, 2]);
	assert.deepEqual(bytes(MSG.SELECT_DISFIELD, [{ player: 0, location: LOCATION.MZONE, sequence: 4 }, { player: 1, location: LOCATION.MZONE, sequence: 0 }]), [0, 4, 4, 1, 4, 0]);
	assert.deepEqual(bytes(MSG.SELECT_POSITION, POS.FACEDOWN_DEFENSE), [8, 0, 0, 0]);
	assert.deepEqual(bytes(MSG.SELECT_COUNTER, [2, 0, 1]), [2, 0, 0, 0, 1, 0]);
	assert.deepEqual(bytes(MSG.SORT_CARD, [2, 0, 1]), [2, 0, 1]);
	assert.deepEqual(bytes(MSG.SORT_CHAIN, null), [255]);
	assert.deepEqual(bytes(MSG.ANNOUNCE_RACE, RACE.DRAGON | RACE.YOKAI), [0, 0x20, 0, 0, 0, 0, 0, 0x40]);
	assert.deepEqual(bytes(MSG.ANNOUNCE_ATTRIB, ATTRIBUTE.DARK), [0x20, 0, 0, 0]);
	assert.deepEqual(bytes(MSG.ANNOUNCE_CARD, 46986414), [0xae, 0xf4, 0xcc, 0x02]);
	assert.deepEqual(bytes(MSG.ANNOUNCE_NUMBER, 3), [3, 0, 0, 0]);
	assert.deepEqual(bytes(MSG.ROCK_PAPER_SCISSORS, 2), [2, 0, 0, 0]);
	assert.throws(() => encodeResponse(MSG.DRAW, 1), /not a prompt/);
	assert.throws(() => encodeResponse(MSG.SELECT_OPTION, 1.5), /integer/);
	console.log('responses ok');
}

{
	const concat = (...parts) => {
		const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
		let at = 0;
		for (const part of parts) {
			out.set(part, at);
			at += part.length;
		}
		return out;
	};
	const framed = (kind, body) => {
		const payload = body.bytes();
		return concat(new Writer().u32(payload.length + 1).u8(kind).bytes(), payload);
	};
	const place = (writer, [controller, location, sequence, position]) => writer.u8(controller).u8(location).u32(sequence).u32(position);
	const one = (kind, body) => {
		const messages = decodeMessages(framed(kind, body));
		assert.equal(messages.length, 1);
		return messages[0];
	};

	assert.deepEqual(
		one(MSG.SELECT_SUM, place(place(new Writer().u8(1).u8(0).u32(8).u32(1).u32(3).u32(1).u32(11), [1, LOCATION.MZONE, 2, POS.FACEUP_ATTACK]).u32(4).u32(1).u32(22), [1, LOCATION.HAND, 0, 0]).u32(0x0002_0003)),
		{ kind: MSG.SELECT_SUM, player: 1, overshoot: false, sum: 8, min: 1, max: 3, must: [{ code: 11, controller: 1, location: LOCATION.MZONE, sequence: 2, position: POS.FACEUP_ATTACK, param: 4 }], cards: [{ code: 22, controller: 1, location: LOCATION.HAND, sequence: 0, position: 0, param: 0x0002_0003 }] },
	);
	assert.deepEqual(
		one(MSG.SORT_CARD, new Writer().u8(0).u32(2).u32(5).u8(0).u32(LOCATION.GRAVE).u32(3).u32(6).u8(1).u32(LOCATION.DECK).u32(0)),
		{ kind: MSG.SORT_CARD, player: 0, cards: [{ code: 5, controller: 0, location: LOCATION.GRAVE, sequence: 3 }, { code: 6, controller: 1, location: LOCATION.DECK, sequence: 0 }] },
	);
	assert.deepEqual(
		one(MSG.SHUFFLE_SET_CARD, place(place(place(place(new Writer().u8(LOCATION.SZONE).u8(2), [0, LOCATION.SZONE, 1, POS.FACEDOWN]), [0, LOCATION.SZONE, 3, POS.FACEDOWN]), [0, 0, 0, 0]), [0, LOCATION.SZONE, 3, 0])),
		{ kind: MSG.SHUFFLE_SET_CARD, location: LOCATION.SZONE, from: [{ controller: 0, location: LOCATION.SZONE, sequence: 1, position: POS.FACEDOWN }, { controller: 0, location: LOCATION.SZONE, sequence: 3, position: POS.FACEDOWN }], to: [{ controller: 0, location: 0, sequence: 0, position: 0 }, { controller: 0, location: LOCATION.SZONE, sequence: 3, position: 0 }] },
	);
	assert.deepEqual(
		one(MSG.SELECT_UNSELECT_CARD, place(new Writer().u8(1).u8(1).u8(0).u32(1).u32(2).u32(1).u32(9), [1, LOCATION.HAND, 4, 0]).u32(0)),
		{ kind: MSG.SELECT_UNSELECT_CARD, player: 1, finishable: true, cancelable: false, min: 1, max: 2, selectable: [{ code: 9, controller: 1, location: LOCATION.HAND, sequence: 4, position: 0 }], unselectable: [] },
	);
	assert.deepEqual(
		one(MSG.CHAINING, place(new Writer().u32(7), [0, LOCATION.SZONE, 2, POS.FACEUP]).u8(0).u8(LOCATION.SZONE).u32(2).u64(0x1234_5678_9abc_def0n).u32(1)),
		{ kind: MSG.CHAINING, code: 7, controller: 0, location: LOCATION.SZONE, sequence: 2, position: POS.FACEUP, triggeringController: 0, triggeringLocation: LOCATION.SZONE, triggeringSequence: 2, description: 0x1234_5678_9abc_def0n, chainCount: 1 },
	);
	assert.deepEqual(
		one(MSG.TAG_SWAP, new Writer().u8(1).u32(30).u32(1).u32(0).u32(2).u32(0).u32(3).u32(POS.FACEDOWN).u32(4).u32(POS.FACEDOWN).u32(5).u32(POS.FACEDOWN)),
		{ kind: MSG.TAG_SWAP, player: 1, deckCount: 30, extraPendulumCount: 0, deckTop: 0, hand: [{ code: 3, position: POS.FACEDOWN }, { code: 4, position: POS.FACEDOWN }], extra: [{ code: 5, position: POS.FACEDOWN }] },
	);
	assert.deepEqual(one(MSG.SHOW_HINT, new Writer().u16(2).u8(0x68).u8(0x69).u8(0)), { kind: MSG.SHOW_HINT, text: 'hi' });
	assert.deepEqual(one(MSG.HAND_RES, new Writer().u8(2 + (3 << 2))), { kind: MSG.HAND_RES, hands: [2, 3] });
	assert.deepEqual(one(MSG.LPUPDATE, new Writer().u8(0).i32(-500)), { kind: MSG.LPUPDATE, player: 0, lp: -500 });
	assert.deepEqual(one(MSG.ANNOUNCE_RACE, new Writer().u8(0).u8(1).u64(RACE.ALL)), { kind: MSG.ANNOUNCE_RACE, player: 0, count: 1, available: RACE.ALL });

	const two = decodeMessages(concat(framed(MSG.NEW_TURN, new Writer().u8(1)), framed(MSG.CHAIN_END, new Writer())));
	assert.deepEqual(two, [{ kind: MSG.NEW_TURN, player: 1 }, { kind: MSG.CHAIN_END }]);
	assert.throws(() => decodeMessages(framed(MSG.NEW_TURN, new Writer().u8(1).u8(1))), /left undecoded/);
	assert.throws(() => decodeMessages(framed(MSG.WAITING, new Writer())), /no decoder/);
	console.log('messages  ok');
}

{
	const { duel } = await startDuel(browser);
	const { result } = playOut(duel);
	assert.equal(result.reason, 'win');
	const after = advance(duel);
	assert.notEqual(after.status, DUEL_STATUS.END, 'the core is expected to keep going after a win; if it stopped, the loop may key on status');
	duel.destroy();
	console.log('after-win ok  status', after.status);
}
