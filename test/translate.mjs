import assert from 'node:assert/strict';

import { DUEL, LOCATION, MSG, PHASE, POS, STATUS, clockFromSeed, createEngine, createTranslator, loadDecks, play, pollField, redact, statsOf, vocabulary, zoneOf } from '../driver/index.mjs';
import { unruledKinds } from '../driver/translate.mjs';
import { DECKS, SEED, TEAM, bot, browserEntry, cardReader, stringify } from './vanilla.mjs';

const { AUDIENCE, CHAIN, EMZ, FLAG, PACK_PHASE, TAG, VERB, ZONE, audienceRef, seatZone, zoneRef } = vocabulary;
const browser = await browserEntry();

assert.deepEqual(unruledKinds(), []);

{
	assert.equal(zoneOf(0, LOCATION.MZONE, 0), seatZone(0, ZONE.MZ[0]));
	assert.equal(zoneOf(1, LOCATION.SZONE, 5), seatZone(1, ZONE.FIELD));
	assert.equal(zoneOf(1, LOCATION.HAND, 3), seatZone(1, ZONE.HAND));
	assert.equal(zoneOf(0, LOCATION.MZONE, 5), EMZ[0]);
	assert.equal(zoneOf(1, LOCATION.MZONE, 6), EMZ[0], "seat 1's right shared zone is seat 0's left");
	assert.equal(zoneOf(0, LOCATION.MZONE, 6), zoneOf(1, LOCATION.MZONE, 5));
	assert.throws(() => zoneOf(0, LOCATION.SZONE, 6), /no zone/);
	assert.throws(() => zoneOf(0, LOCATION.OVERLAY, 0), /no zone/);
	console.log('zones      ok');
}

const played = await (async () => {
	const engine = await createEngine(browser, { log: () => {} });
	const duel = engine.createDuel({ seed: SEED, flags: DUEL.MODE_MR5, team1: TEAM, team2: TEAM, cardReader, scriptReader: () => null, clock: clockFromSeed(SEED) });
	const orders = loadDecks(duel, DECKS, { seed: SEED });
	duel.start();
	const translator = createTranslator({ seats: [0, 1] });
	const rows = [...translator.open(orders)];
	const batches = [];
	const fields = [];
	const have = new Map();
	const poll = (when) => {
		const field = pollField(duel);
		fields.push(field);
		const polled = translator.stats(field);
		assert.ok(polled.length <= 1, 'one STATS row per poll at most');
		for (const row of polled) {
			assert.equal(row.t, TAG.STATS);
			assert.equal(row.nums.length, row.insts.length * 4);
			row.insts.forEach((inst, i) => have.set(inst, row.nums.slice(i * 4, i * 4 + 4)));
		}
		rows.push(...polled);
		const board = translator.board();
		field.forEach(({ mzone, szone }, seat) => {
			for (const [cards, slots] of [[mzone, board[seat].mzone], [szone, board[seat].szone]]) {
				cards.forEach((card, index) => {
					if (card === null || !(card.position & POS.FACEUP)) return;
					assert.deepEqual(have.get(slots[index].inst), statsOf(card), `${when}: the numbers of ${seat}/${index}`);
				});
			}
		});
	};
	let audits = 0;
	const result = play(
		duel,
		(prompt) => {
			poll(`before decision ${audits}`);
			assert.deepEqual(translator.audit(duel), [], `the shadow drifted from the core before decision ${audits}`);
			audits++;
			return bot(prompt);
		},
		{
			onBatch: (batch) => {
				batches.push(batch);
				rows.push(...translator.translate(batch.messages));
			},
		},
	);
	assert.equal(result.reason, 'win');
	poll('after the win');
	assert.deepEqual(translator.audit(duel), [], 'the shadow drifted from the core by the end');
	assert.deepEqual(translator.stats(fields.at(-1)), [], 'the same field polled again writes nothing');
	duel.destroy();
	return { rows, batches, fields, orders, audits, decisions: result.decisions };
})();
{
	const { rows, batches, fields, audits, decisions } = played;
	const messages = batches.flatMap((batch) => batch.messages);
	assert.equal(audits, decisions);
	const count = (test) => rows.filter(test).length;
	assert.deepEqual(rows.slice(0, 2).map((row) => [row.t, row.to, row.cards.length]), [[TAG.SETUP, zoneRef(seatZone(0, ZONE.DECK)), 40], [TAG.SETUP, zoneRef(seatZone(1, ZONE.DECK)), 40]], 'the deal is two SETUPs, a deck each, binding nothing');
	assert.ok(rows.slice(0, 2).every((row) => row.cards.every((code) => code === 0)));
	const draws = messages.filter((message) => message.kind === MSG.DRAW);
	assert.equal(count((row) => row.t === TAG.MOVE && row.verb === VERB.draw), draws.length, 'every draw is a MOVE that narrates it');
	assert.deepEqual(rows.find((row) => row.verb === VERB.draw).cards, draws[0].cards.map((card) => card.code), 'a draw binds what was drawn');
	assert.equal(count((row) => row.t === TAG.TURN), messages.filter((message) => message.kind === MSG.NEW_TURN).length);
	const summons = messages.filter((message) => message.kind === MSG.SUMMONING).length;
	assert.ok(summons > 0);
	assert.equal(count((row) => row.verb === VERB.normalSummon), summons, 'a face-up arrival from the hand is a Normal Summon');
	assert.ok(count((row) => row.t === TAG.ATTACK) > 0);
	assert.ok(count((row) => row.t === TAG.LP && row.nums[0] < 0) > 0);
	assert.ok(count((row) => row.t === TAG.MOVE && row.verb === VERB.toGy) > 0, 'battle sends cards to the graveyard');
	const stats = rows.filter((row) => row.t === TAG.STATS);
	assert.ok(stats.length > 0 && stats.length < fields.length, `${stats.length} STATS rows over ${fields.length} polls: only what moved`);
	assert.equal(stats.reduce((total, row) => total + row.insts.length, 0), summons, 'one baseline per summon');
	assert.ok(stats.every((row) => row.insts.every((_, i) => row.nums[i * 4] >= 1000 && row.nums[i * 4 + 1] === 1000 && row.nums[i * 4 + 2] === 4 && row.nums[i * 4 + 3] === 0)));
	const battleStarts = messages.filter((message) => message.kind === MSG.NEW_PHASE && message.phase === PHASE.BATTLE_START).length;
	const battleRows = count((row) => row.t === TAG.PHASE && row.nums[0] === PACK_PHASE.BP);
	assert.ok(battleRows > 0 && battleRows === battleStarts, `${battleStarts} battle-phase entries, ${battleRows} rows`);
	assert.deepEqual(new Set(rows.filter((row) => row.t === TAG.PHASE).map((row) => row.nums[0])), new Set(Object.values(PACK_PHASE)), 'every phase of the pack is reached');
	for (const row of rows) {
		assert.ok(Object.values(TAG).includes(row.t), `row tag ${row.t}`);
		for (const key of Object.keys(row)) assert.ok(['t', 'actor', 'insts', 'cards', 'from', 'to', 'verb', 'reason', 'flags', 'nums'].includes(key), `column ${key}`);
		if (row.insts && row.cards && row.t !== TAG.SETUP) assert.equal(row.cards.length, row.insts.length, `cards parallel to insts on tag ${row.t}`);
	}
	console.log(`vanilla    ok  ${rows.length} rows from ${messages.length} messages, audited and polled at ${audits} boundaries, ${stats.length} STATS rows`);
}

{
	const { batches, fields, orders } = played;
	const views = {};
	for (const [name, seats] of Object.entries({ seat0: [0], seat1: [1], gallery: [], both: [0, 1] })) {
		const translator = createTranslator({ seats });
		const rows = [...translator.open(orders)];
		let polls = 0;
		for (const batch of batches) {
			rows.push(...translator.translate(batch.messages.map((message) => redact(message, seats))));
			if (batch.prompt || batch.win) rows.push(...translator.stats(fields[polls++]));
		}
		assert.equal(polls, fields.length);
		views[name] = rows;
	}
	const shape = (rows) => stringify(rows.filter((row) => row.t !== TAG.REVEAL).map(({ cards, ...rest }) => rest));
	for (const name of ['seat0', 'seat1', 'gallery']) assert.equal(shape(views[name]), shape(views.both), `${name} names the same handles as the solo player`);
	const drawsOf = (rows, player) => rows.filter((row) => row.verb === VERB.draw && row.actor === player);
	assert.ok(drawsOf(views.seat0, 0).every((row) => row.cards.every((code) => code > 0)), 'a seat sees its own draws');
	assert.ok(drawsOf(views.seat0, 1).every((row) => row.cards.every((code) => code === 0)), "a seat does not see the other's");
	assert.ok(drawsOf(views.gallery, 0).every((row) => row.cards.every((code) => code === 0)), 'the gallery sees no draw');
	assert.equal(stringify(views.both), stringify(played.rows), 'the both-seats view is the god view');
	console.log('recipients ok');
}

{
	const at = (controller, location, sequence, position = POS.FACEUP_ATTACK) => ({ controller, location, sequence, position });
	const move = (code, from, to, reason = 0) => ({ kind: MSG.MOVE, code, from, to, reason });
	const nowhere = at(0, 0, 0, 0);
	const fresh = () => {
		const translator = createTranslator({ seats: [0, 1], startingLP: [8000, 8000] });
		const setup = translator.open([{ main: [1, 2, 3], extra: [7] }, { main: [4, 5, 6] }]);
		return { translator, setup };
	};
	const H = { top0: 1, second0: 2, bottom0: 3, extra0: 4, top1: 5 };

	{
		const { setup } = fresh();
		assert.deepEqual(setup, [
			{ t: TAG.SETUP, to: zoneRef(seatZone(0, ZONE.DECK)), cards: [0, 0, 0] },
			{ t: TAG.SETUP, to: zoneRef(seatZone(0, ZONE.EXTRA)), cards: [7], flags: FLAG.FACE_PRESENT },
			{ t: TAG.SETUP, to: zoneRef(seatZone(1, ZONE.DECK)), cards: [0, 0, 0] },
		]);
		const gallery = createTranslator({ seats: [] });
		assert.deepEqual(gallery.open([{ main: [1], extra: [7] }, { main: [2] }])[1].cards, [0], 'the gallery is shown no Extra Deck');
	}

	{
		const { translator } = fresh();
		const drawn = translator.translate([{ kind: MSG.DRAW, player: 0, cards: [{ code: 1, position: POS.FACEDOWN_DEFENSE }, { code: 2, position: POS.FACEDOWN_DEFENSE }] }]);
		assert.deepEqual(drawn, [{ t: TAG.MOVE, actor: 0, insts: [H.top0, H.second0], cards: [1, 2], from: zoneRef(seatZone(0, ZONE.DECK)), to: zoneRef(seatZone(0, ZONE.HAND)), verb: VERB.draw }]);
		const summon = translator.translate([move(1, at(0, LOCATION.HAND, 0, POS.FACEDOWN), at(0, LOCATION.MZONE, 2), 0x2000400), { kind: MSG.SUMMONING, code: 1, ...at(0, LOCATION.MZONE, 2) }]);
		assert.deepEqual(summon, [{ t: TAG.MOVE, insts: [H.top0], cards: [1], from: zoneRef(seatZone(0, ZONE.HAND)), to: zoneRef(seatZone(0, ZONE.MZ[2])), verb: VERB.normalSummon, reason: 0x2000400, flags: FLAG.FACE_PRESENT | FLAG.FACE_UP | FLAG.POSITION_PRESENT }], 'the reason the core left on the card is the draw\'s; the hand says Normal Summon');
		const overlay = translator.translate([move(2, at(0, LOCATION.HAND, 0, POS.FACEDOWN), at(0, LOCATION.MZONE | LOCATION.OVERLAY, 2, 0), 8)]);
		assert.deepEqual(overlay, [{ t: TAG.ATTACH, insts: [H.top0, H.second0], cards: [0, 2], to: zoneRef(seatZone(0, ZONE.MZ[2])), flags: FLAG.FACE_PRESENT | FLAG.FACE_UP | FLAG.POSITION_PRESENT, reason: 8 }]);
		assert.deepEqual(translator.board()[0].mzone[2].materials.map((unit) => unit.inst), [H.second0]);
		translator.translate([move(1, at(0, LOCATION.MZONE, 2), at(0, LOCATION.GRAVE, 0, POS.FACEUP), 1)]);
		assert.deepEqual(translator.board()[0].grave[0].materials.map((unit) => unit.inst), [H.second0], 'the unit rode along');
		const detached = translator.translate([move(2, at(0, LOCATION.GRAVE | LOCATION.OVERLAY, 0, 0), at(0, LOCATION.GRAVE, 1, POS.FACEUP), 1)]);
		assert.deepEqual(detached[0].insts, [H.second0]);
		assert.deepEqual(translator.board()[0].grave.map((card) => [card.inst, card.materials.length]), [[H.top0, 0], [H.second0, 0]]);
	}

	{
		const { translator } = fresh();
		const born = translator.translate([move(99, nowhere, at(1, LOCATION.MZONE, 0, POS.FACEUP_DEFENSE), 0), { kind: MSG.SPSUMMONING, code: 99, ...at(1, LOCATION.MZONE, 0, POS.FACEUP_DEFENSE) }]);
		assert.deepEqual(born, [{ t: TAG.CREATE, actor: 1, cards: [99], to: zoneRef(seatZone(1, ZONE.MZ[0])), flags: FLAG.FACE_PRESENT | FLAG.FACE_UP | FLAG.POSITION_PRESENT | FLAG.POSITION_DEF, verb: VERB.create, reason: 0 }]);
		const token = 8;
		assert.equal(translator.board()[1].mzone[0].inst, token, 'minted after the deal');
		const gone = translator.translate([move(99, at(1, LOCATION.MZONE, 0, POS.FACEUP_DEFENSE), nowhere, 1)]);
		assert.deepEqual(gone, [{ t: TAG.REMOVE, insts: [token], verb: VERB.removeToken, reason: 1 }]);
		assert.equal(translator.board()[1].mzone[0], null);
		assert.throws(() => translator.translate([move(99, at(1, LOCATION.MZONE, 0), at(1, LOCATION.GRAVE, 0), 0)]), /no card at/);
	}

	{
		const { translator } = fresh();
		const toBottom = translator.translate([move(1, at(0, LOCATION.DECK, 2, POS.FACEDOWN), at(0, LOCATION.DECK, 0, POS.FACEDOWN), 0)]);
		assert.equal(toBottom[0].verb, VERB.toDeckBottom);
		assert.equal(toBottom[0].flags & FLAG.AT_BOTTOM, FLAG.AT_BOTTOM);
		assert.deepEqual(translator.board()[0].deck.map((card) => card.code), [1, 3, 2], 'bottom first, as the core lists a deck');
		const shuffled = translator.translate([{ kind: MSG.SHUFFLE_DECK, player: 0 }]);
		assert.deepEqual(shuffled, [{ t: TAG.SHUFFLE, actor: 0, to: zoneRef(seatZone(0, ZONE.DECK)), nums: [3], verb: VERB.shuffleDeck }]);
		assert.deepEqual(translator.board()[0].deck.map((card) => [card.inst, card.code]), [[10, 0], [9, 0], [8, 0]], 'fresh handles, the first minted on top, nothing known');
		const top = translator.translate([{ kind: MSG.DECK_TOP, player: 0, depth: 0, code: 3, position: POS.FACEUP_DEFENSE }]);
		assert.deepEqual(top, [{ t: TAG.REVEAL, actor: 0, insts: [8], cards: [3], to: audienceRef(AUDIENCE.ALL), verb: VERB.revealTop }]);
		const drawn = translator.translate([{ kind: MSG.DRAW, player: 0, cards: [{ code: 3, position: POS.FACEUP }] }]);
		assert.deepEqual(drawn.map((row) => row.t), [TAG.MOVE, TAG.REVEAL], 'a card drawn face-up is public in the hand');
	}

	{
		const { translator } = fresh();
		translator.translate([{ kind: MSG.DRAW, player: 0, cards: [{ code: 1, position: POS.FACEUP }, { code: 2, position: POS.FACEDOWN }, { code: 3, position: POS.FACEDOWN }] }]);
		const rows = translator.translate([{ kind: MSG.SHUFFLE_HAND, player: 0, codes: [3, 1, 2] }]);
		assert.deepEqual(rows, [
			{ t: TAG.SHUFFLE, actor: 0, to: zoneRef(seatZone(0, ZONE.HAND)), nums: [3], cards: [3, 1, 2] },
			{ t: TAG.REVEAL, actor: 0, insts: [9], cards: [1], to: audienceRef(AUDIENCE.ALL), verb: VERB.reveal },
		]);
		assert.deepEqual(translator.board()[0].hand.map((card) => [card.inst, card.code]), [[8, 3], [9, 1], [10, 2]]);
		const zeroed = createTranslator({ seats: [1] });
		zeroed.open([{ main: [1, 2] }, { main: [3] }]);
		zeroed.translate([{ kind: MSG.DRAW, player: 0, cards: [{ code: 0, position: POS.FACEDOWN }, { code: 0, position: POS.FACEDOWN }] }]);
		assert.deepEqual(zeroed.translate([{ kind: MSG.SHUFFLE_HAND, player: 0, codes: [0, 0] }]), [{ t: TAG.SHUFFLE, actor: 0, to: zoneRef(seatZone(0, ZONE.HAND)), nums: [2] }], 'an all-zero list binds nothing and is not carried');

		const extra = fresh().translator;
		const [summoned, returned] = extra.translate([move(7, at(0, LOCATION.EXTRA, 0, POS.FACEDOWN_DEFENSE), at(0, LOCATION.MZONE, 0), 0x800), move(7, at(0, LOCATION.MZONE, 0), at(0, LOCATION.EXTRA, 0, POS.FACEUP_DEFENSE), 1)]);
		assert.equal(summoned.verb, VERB.specialAtk, 'the core stamps a Special Summon before the move');
		assert.equal(returned.verb, VERB.toExtraFaceUp);
		assert.equal(extra.translate([move(7, at(0, LOCATION.EXTRA, 0, POS.FACEUP_DEFENSE), at(1, LOCATION.MZONE, 3, POS.FACEUP_DEFENSE), 0x800)])[0].verb, VERB.specialDef);
		extra.translate([move(7, at(1, LOCATION.MZONE, 3, POS.FACEUP_DEFENSE), at(0, LOCATION.EXTRA, 0, POS.FACEUP_DEFENSE), 1)]);
		const reshuffled = extra.translate([{ kind: MSG.SHUFFLE_EXTRA, player: 0, codes: [7] }]);
		assert.deepEqual(reshuffled.map((row) => [row.t, row.flags]), [[TAG.SHUFFLE, FLAG.FACE_PRESENT], [TAG.FLIP, FLAG.FACE_PRESENT | FLAG.FACE_UP]], 'the face-up Pendulum is turned back up');
		assert.equal(extra.board()[0].extra[0].position, POS.FACEUP_DEFENSE);
	}

	{
		const { translator } = fresh();
		translator.translate([{ kind: MSG.DRAW, player: 0, cards: [{ code: 1, position: POS.FACEDOWN }] }, move(1, at(0, LOCATION.HAND, 0, POS.FACEDOWN), at(0, LOCATION.MZONE, 1, POS.FACEDOWN_DEFENSE), 0)]);
		const flip = (previousPosition, position) => translator.translate([{ kind: MSG.POS_CHANGE, code: 1, controller: 0, location: LOCATION.MZONE, sequence: 1, previousPosition, position }]);
		assert.deepEqual(flip(POS.FACEDOWN_DEFENSE, POS.FACEUP_DEFENSE), [{ t: TAG.FLIP, actor: 0, insts: [H.top0], cards: [1], flags: FLAG.FACE_PRESENT | FLAG.FACE_UP, verb: VERB.flipUp }]);
		assert.deepEqual(flip(POS.FACEUP_DEFENSE, POS.FACEUP_ATTACK), [{ t: TAG.FLIP, actor: 0, insts: [H.top0], cards: [1], flags: FLAG.POSITION_PRESENT, verb: VERB.position }]);
		assert.deepEqual(flip(POS.FACEUP_ATTACK, POS.FACEDOWN_DEFENSE)[0].flags, FLAG.FACE_PRESENT | FLAG.POSITION_PRESENT | FLAG.POSITION_DEF);
		assert.deepEqual(flip(POS.FACEDOWN_DEFENSE, POS.FACEDOWN_DEFENSE), []);
		translator.translate([move(1, at(0, LOCATION.MZONE, 1, POS.FACEDOWN_DEFENSE), at(0, LOCATION.GRAVE, 0, POS.FACEDOWN), 1)]);
		assert.deepEqual(translator.translate([{ kind: MSG.POS_CHANGE, code: 1, controller: 0, location: LOCATION.GRAVE, sequence: 0, previousPosition: POS.FACEDOWN, position: POS.FACEUP }]).map((row) => row.t), [TAG.REVEAL]);
	}

	{
		const { translator } = fresh();
		translator.translate([
			{ kind: MSG.DRAW, player: 0, cards: [{ code: 1, position: POS.FACEDOWN }, { code: 2, position: POS.FACEDOWN }] },
			move(1, at(0, LOCATION.HAND, 0, POS.FACEDOWN), at(0, LOCATION.SZONE, 0, POS.FACEDOWN), 0),
			move(2, at(0, LOCATION.HAND, 0, POS.FACEDOWN), at(0, LOCATION.SZONE, 3, POS.FACEDOWN), 0),
		]);
		const swapped = translator.translate([{ kind: MSG.SWAP, first: { code: 1, ...at(0, LOCATION.SZONE, 0, POS.FACEDOWN) }, second: { code: 2, ...at(0, LOCATION.SZONE, 3, POS.FACEDOWN) } }]);
		assert.deepEqual(swapped, [{ t: TAG.SWAP, insts: [H.top0, H.second0] }]);
		assert.deepEqual(translator.board()[0].szone.map((card) => card?.inst ?? 0), [H.second0, 0, 0, H.top0, 0, 0, 0, 0]);
		const shuffled = translator.translate([{ kind: MSG.SHUFFLE_SET_CARD, location: LOCATION.SZONE, from: [at(0, LOCATION.SZONE, 0, POS.FACEDOWN), at(0, LOCATION.SZONE, 3, POS.FACEDOWN)], to: [at(0, LOCATION.SZONE, 3, POS.FACEDOWN), at(0, LOCATION.SZONE, 0, POS.FACEDOWN)] }]);
		assert.deepEqual(shuffled.map((row) => [row.t, row.insts[0], row.cards[0], row.to]), [[TAG.MOVE, H.second0, 0, zoneRef(seatZone(0, ZONE.ST[3]))], [TAG.MOVE, H.top0, 0, zoneRef(seatZone(0, ZONE.ST[0]))]]);
		assert.deepEqual(translator.board()[0].szone.map((card) => card?.inst ?? 0), [H.top0, 0, 0, H.second0, 0, 0, 0, 0]);
	}

	{
		const { translator } = fresh();
		assert.deepEqual(translator.translate([{ kind: MSG.DAMAGE, player: 1, amount: 3000 }, { kind: MSG.LPUPDATE, player: 1, lp: 4000 }, { kind: MSG.RECOVER, player: 0, amount: 500 }, { kind: MSG.LPUPDATE, player: 0, lp: 8500 }]), [
			{ t: TAG.LP, actor: 1, nums: [-3000], verb: VERB.lp },
			{ t: TAG.LP, actor: 1, nums: [-1000], verb: VERB.lp },
			{ t: TAG.LP, actor: 0, nums: [500], verb: VERB.lp },
		]);
		assert.deepEqual(translator.board().map((seat) => seat.lp), [8500, 4000]);
		translator.translate([{ kind: MSG.DRAW, player: 0, cards: [{ code: 1, position: POS.FACEDOWN }] }, move(1, at(0, LOCATION.HAND, 0, POS.FACEDOWN), at(0, LOCATION.MZONE, 4), 0)]);
		translator.translate([{ kind: MSG.DRAW, player: 1, cards: [{ code: 4, position: POS.FACEDOWN }] }, move(4, at(1, LOCATION.HAND, 0, POS.FACEDOWN), at(1, LOCATION.MZONE, 6, POS.FACEUP_DEFENSE), 0)]);
		const counters = translator.translate([{ kind: MSG.ADD_COUNTER, counterType: 1, controller: 0, location: LOCATION.MZONE, sequence: 4, count: 2 }, { kind: MSG.REMOVE_COUNTER, counterType: 1, controller: 0, location: LOCATION.MZONE, sequence: 4, count: 1 }]);
		assert.deepEqual(counters.map((row) => [row.t, row.insts[0], row.nums[0]]), [[TAG.COUNTER, H.top0, 2], [TAG.COUNTER, H.top0, -1]]);
		const chaining = translator.translate([{ kind: MSG.CHAINING, code: 1, ...at(0, LOCATION.MZONE, 4), triggeringController: 1, triggeringLocation: LOCATION.MZONE, triggeringSequence: 4, description: (1n << 20n) | 3n, chainCount: 1 }, { kind: MSG.CHAINED, chainCount: 1 }]);
		assert.deepEqual(
			chaining,
			[
				{ t: TAG.ACTIVATE, actor: 1, insts: [H.top0], cards: [1], verb: VERB.activate, nums: [1, 3] },
				{ t: TAG.CHAIN, actor: 1, insts: [H.top0], nums: [CHAIN.LINK, 1] },
			],
			'an activation is the cue and the link it adds; CHAINED adds nothing to it',
		);
		assert.deepEqual(translator.translate([{ kind: MSG.CHAINING, code: 1, ...at(0, LOCATION.MZONE, 4), triggeringController: 0, triggeringLocation: 0, triggeringSequence: 0, description: 0n, chainCount: 2 }]).map((row) => row.nums), [[0, 0], [CHAIN.LINK, 2]], 'a plain activation describes nothing, and the link is numbered as the core numbers it');
		const life = translator.translate([{ kind: MSG.CHAIN_NEGATED, chainCount: 1 }, { kind: MSG.CHAIN_SOLVING, chainCount: 2 }, { kind: MSG.CHAIN_DISABLED, chainCount: 2 }, { kind: MSG.CHAIN_SOLVED, chainCount: 2 }, { kind: MSG.CHAIN_SOLVING, chainCount: 1 }, { kind: MSG.CHAIN_SOLVED, chainCount: 1 }, { kind: MSG.CHAIN_END }]);
		assert.deepEqual(life, [
			{ t: TAG.CHAIN, nums: [CHAIN.NEGATED, 1] },
			{ t: TAG.CHAIN, nums: [CHAIN.SOLVING, 2] },
			{ t: TAG.CHAIN, nums: [CHAIN.DISABLED, 2] },
			{ t: TAG.CHAIN, nums: [CHAIN.SOLVED, 2] },
			{ t: TAG.CHAIN, nums: [CHAIN.SOLVING, 1] },
			{ t: TAG.CHAIN, nums: [CHAIN.SOLVED, 1] },
			{ t: TAG.CHAIN, nums: [CHAIN.END] },
		]);
		const attacks = translator.translate([{ kind: MSG.ATTACK, attacker: at(0, LOCATION.MZONE, 4), target: at(1, LOCATION.MZONE, 6, POS.FACEUP_DEFENSE) }, { kind: MSG.ATTACK, attacker: at(0, LOCATION.MZONE, 4), target: nowhere }]);
		assert.deepEqual(attacks, [
			{ t: TAG.ATTACK, actor: 0, insts: [H.top0, H.top1], verb: VERB.attack },
			{ t: TAG.ATTACK, actor: 0, insts: [H.top0], flags: FLAG.DIRECT_ATTACK, verb: VERB.attack },
		]);
		assert.equal(translator.board()[1].mzone[6].inst, H.top1, "seat 1's slot 6 is the shared zone the row named");
		assert.equal(attacks[0].insts[1], H.top1);
		const targets = translator.translate([{ kind: MSG.BECOME_TARGET, cards: [at(1, LOCATION.MZONE, 6)] }, { kind: MSG.EQUIP, card: at(0, LOCATION.MZONE, 4), target: at(1, LOCATION.MZONE, 6) }, { kind: MSG.CANCEL_TARGET, card: at(0, LOCATION.MZONE, 4), target: at(1, LOCATION.MZONE, 6) }]);
		assert.deepEqual(targets, [
			{ t: TAG.TARGET, insts: [H.top1], verb: VERB.target },
			{ t: TAG.TARGET, insts: [H.top0, H.top1], verb: VERB.target },
		]);
		const looks = translator.translate([
			{ kind: MSG.CONFIRM_CARDS, player: 1, cards: [{ code: 2, controller: 0, location: LOCATION.DECK, sequence: 1 }] },
			{ kind: MSG.CONFIRM_CARDS, player: 1, cards: [{ code: 4, controller: 1, location: LOCATION.MZONE, sequence: 6 }] },
			{ kind: MSG.CONFIRM_DECKTOP, player: 0, cards: [{ code: 2, controller: 0, location: LOCATION.DECK, sequence: 1 }] },
		]);
		assert.deepEqual(looks.map((row) => [row.to, row.verb, row.cards[0]]), [
			[audienceRef(AUDIENCE.seat(1)), VERB.reveal, 2],
			[audienceRef(AUDIENCE.ALL), VERB.reveal, 4],
			[audienceRef(AUDIENCE.ALL), VERB.revealTop, 2],
		]);
		assert.equal(translator.board()[0].deck[1].code, 2, 'a look teaches the shadow the code');
		const tosses = translator.translate([{ kind: MSG.TOSS_COIN, player: 0, results: [1, 0] }, { kind: MSG.TOSS_DICE, player: 1, results: [6] }, { kind: MSG.REMOVE_CARDS, cards: [at(1, LOCATION.MZONE, 6)] }]);
		assert.deepEqual(tosses, [
			{ t: TAG.COIN, actor: 0, nums: [1, 0], verb: VERB.coin },
			{ t: TAG.DICE, actor: 1, nums: [6], verb: VERB.dice },
			{ t: TAG.REMOVE, insts: [H.top1] },
		]);
		assert.equal(translator.board()[1].mzone[6], null);
	}

	{
		const { translator } = fresh();
		assert.throws(() => translator.translate([{ kind: MSG.NEW_PHASE, phase: PHASE.DRAW }]), /before the first turn/);
		const rows = translator.translate([{ kind: MSG.NEW_TURN, player: 1 }, { kind: MSG.NEW_PHASE, phase: PHASE.DRAW }, { kind: MSG.NEW_PHASE, phase: PHASE.MAIN1 }, { kind: MSG.NEW_PHASE, phase: PHASE.BATTLE_START }, { kind: MSG.NEW_PHASE, phase: PHASE.BATTLE_STEP }, { kind: MSG.NEW_PHASE, phase: PHASE.DAMAGE }, { kind: MSG.NEW_PHASE, phase: PHASE.MAIN2 }, { kind: MSG.NEW_PHASE, phase: PHASE.END }]);
		assert.deepEqual(rows, [
			{ t: TAG.TURN, actor: 1, verb: VERB.turn },
			{ t: TAG.PHASE, actor: 1, nums: [PACK_PHASE.DP], verb: VERB.phase },
			{ t: TAG.PHASE, actor: 1, nums: [PACK_PHASE.M1], verb: VERB.phase },
			{ t: TAG.PHASE, actor: 1, nums: [PACK_PHASE.BP], verb: VERB.phase },
			{ t: TAG.PHASE, actor: 1, nums: [PACK_PHASE.M2], verb: VERB.phase },
			{ t: TAG.PHASE, actor: 1, nums: [PACK_PHASE.EP], verb: VERB.phase },
		]);
	}

	{
		const { translator } = fresh();
		const queried = (position, attack, defense, { level = 0, rank = 0, link = 0, status = 0, isHidden = false } = {}) => ({ position, attack, defense, level, rank, link: { rating: link, marker: 0 }, status, isHidden });
		const slots = (length, filled) => Array.from({ length }, (_, index) => filled[index] ?? null);
		const field = (m0 = {}, s0 = {}, m1 = {}, s1 = {}) => [{ mzone: slots(7, m0), szone: slots(8, s0) }, { mzone: slots(7, m1), szone: slots(8, s1) }];
		translator.translate([
			{ kind: MSG.DRAW, player: 0, cards: [{ code: 1, position: POS.FACEDOWN }, { code: 2, position: POS.FACEDOWN }] },
			move(1, at(0, LOCATION.HAND, 0, POS.FACEDOWN), at(0, LOCATION.MZONE, 2, POS.FACEDOWN_DEFENSE), 0),
			move(2, at(0, LOCATION.HAND, 0, POS.FACEDOWN), at(0, LOCATION.SZONE, 1, POS.FACEDOWN), 0),
		]);
		const monster = (attack, extra = {}) => queried(POS.FACEUP_ATTACK, attack, 1000, { level: 4, ...extra });
		const setSpell = queried(POS.FACEDOWN, 0, 0);
		assert.deepEqual(translator.stats(field({ 2: queried(POS.FACEDOWN_DEFENSE, 1000, 1000, { level: 4 }) }, { 1: setSpell })), [], 'nothing face-down');
		assert.deepEqual(translator.stats(field({ 2: monster(1000) }, { 1: setSpell })), [{ t: TAG.STATS, insts: [H.top0], nums: [1000, 1000, 4, 0] }], 'the first face-up poll is the baseline');
		assert.deepEqual(translator.stats(field({ 2: monster(1000) }, { 1: setSpell })), [], 'the same numbers again are nothing');
		assert.deepEqual(translator.stats(field({ 2: monster(1500) }, { 1: setSpell })), [{ t: TAG.STATS, insts: [H.top0], nums: [1500, 1000, 4, 0] }], 'a change is a row');
		assert.deepEqual(translator.stats(field({ 2: monster(1500) }, { 1: queried(POS.FACEUP, 0, 0) })), [{ t: TAG.STATS, insts: [H.second0], nums: [0, 0, 0, 0] }], 'a spell turned face-up is a baseline of zeros');
		assert.deepEqual(
			translator.stats(field({ 2: monster(1500, { status: STATUS.SUMMON_TURN | STATUS.PROC_COMPLETE }) }, { 1: queried(POS.FACEUP, 0, 0, { status: STATUS.DISABLED | STATUS.SET_TURN }) })),
			[{ t: TAG.STATS, insts: [H.second0], nums: [0, 0, 0, STATUS.DISABLED] }],
			"negated is the one drawn bit; the core's bookkeeping bits are not a change",
		);
		assert.deepEqual(
			translator.stats(field({ 2: queried(POS.FACEUP_ATTACK, 1500, 1000, { rank: 6 }) }, { 1: queried(POS.FACEUP, 0, 0, { status: STATUS.FORBIDDEN }) })),
			[{ t: TAG.STATS, insts: [H.top0, H.second0], nums: [1500, 1000, 6, 0, 0, 0, 0, STATUS.FORBIDDEN] }],
			"two cards moving in one poll are one row, in slot order; a rank rides the level's place",
		);
		const forbidden = queried(POS.FACEUP, 0, 0, { status: STATUS.FORBIDDEN });
		assert.deepEqual(translator.stats(field({ 2: queried(POS.FACEUP_ATTACK, 1500, 1000, { link: 2 }) }, { 1: forbidden }))[0].nums, [1500, 1000, 2, 0], "a link rating rides the level's place");
		assert.deepEqual(translator.stats(field({ 2: queried(POS.FACEUP_ATTACK, 9999, 1000, { link: 2, isHidden: true }) }, { 1: forbidden })), [], 'hidden: numbers nobody may have, its controller included');
		translator.translate([move(1, at(0, LOCATION.MZONE, 2), at(0, LOCATION.GRAVE, 0, POS.FACEUP), 1)]);
		assert.deepEqual(translator.stats(field({}, { 1: forbidden })), [], 'gone from the field, nothing to say');
		translator.translate([move(1, at(0, LOCATION.GRAVE, 0, POS.FACEUP), at(0, LOCATION.MZONE, 4), 0x800)]);
		assert.deepEqual(translator.stats(field({ 4: queried(POS.FACEUP_ATTACK, 1500, 1000, { link: 2 }) }, { 1: forbidden })), [{ t: TAG.STATS, insts: [H.top0], nums: [1500, 1000, 2, 0] }], 'back on the field, the same numbers are a baseline again');
		assert.throws(() => translator.stats(field({ 0: queried(POS.FACEUP_ATTACK, 1, 1) })), /no card at 0\/MZONE\/0 to carry stats/, 'a card the shadow does not hold is a drift');
		assert.throws(() => createTranslator({ seats: [0] }).stats(field()), /not open/);
	}

	{
		const { translator } = fresh();
		assert.throws(() => translator.translate([{ kind: MSG.TAG_SWAP }]), /TAG_SWAP/);
		assert.throws(() => translator.translate([{ kind: MSG.REVERSE_DECK }]), /REVERSE_DECK/);
		assert.throws(() => translator.translate([{ kind: 999 }]), /no rule for message kind 999/);
		assert.throws(() => translator.open([]), /already open/);
		assert.deepEqual(translator.translate([{ kind: MSG.SELECT_IDLECMD, player: 0 }, { kind: MSG.HINT, type: 1, player: 0, description: 0n }, null]), []);
		assert.throws(() => createTranslator({ seats: [0] }).translate([]), /not open/);
	}
	console.log('cases      ok');
}
