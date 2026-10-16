import assert from 'node:assert/strict';

import { CHINT, DUEL, HINT, LOCATION, MSG, PHINT, POS, TYPE, clockFromSeed, createEngine, loadDecks, play, redact, redactQuery } from '../driver/index.mjs';
import { DECKS, SEED, TEAM, bot, browserEntry, cardReader } from './vanilla.mjs';

const browser = await browserEntry();

const SEAT_0 = [0];
const SEAT_1 = [1];
const GALLERY = [];
const BOTH = [0, 1];
const EVERYONE = [SEAT_0, SEAT_1, GALLERY, BOTH];

const at = (controller, location, sequence = 0, position = POS.FACEUP_ATTACK) => ({ controller, location, sequence, position });
const passes = (message, seats) => assert.equal(redact(message, seats), message, `${JSON.stringify(seats)} should pass whole`);
const withheld = (message, seats) => assert.equal(redact(message, seats), null, `${JSON.stringify(seats)} should be denied`);

{
	const prompt = { kind: MSG.SELECT_YESNO, player: 1, description: 0n };
	passes(prompt, SEAT_1);
	passes(prompt, BOTH);
	withheld(prompt, SEAT_0);
	withheld(prompt, GALLERY);

	const select = { kind: MSG.SELECT_CARD, player: 0, cancelable: false, min: 1, max: 1, cards: [{ code: 11, ...at(0, LOCATION.HAND) }, { code: 22, ...at(1, LOCATION.MZONE, 2, POS.FACEDOWN_DEFENSE) }] };
	const seen = redact(select, SEAT_0);
	assert.deepEqual(seen.cards.map((card) => card.code), [11, 0], 'the opponent\'s entry is zeroed for the asked player');
	assert.notEqual(seen, select);
	assert.equal(redact(select, BOTH).cards[1].code, 0, 'even for a recipient holding both seats: the rule is per prompt, not per viewer');
	withheld(select, SEAT_1);
	const own = { ...select, cards: [select.cards[0]] };
	passes(own, SEAT_0);
	const named = { ...select, player: 1, cards: [61027400, 42377643].map((code) => ({ code, controller: 1, location: 0, sequence: 0, position: 0 })) };
	passes(named, SEAT_1);
	passes(named, BOTH);

	const unselect = { kind: MSG.SELECT_UNSELECT_CARD, player: 1, finishable: true, cancelable: false, min: 1, max: 2, selectable: [{ code: 33, ...at(0, LOCATION.GRAVE) }], unselectable: [{ code: 44, ...at(1, LOCATION.GRAVE) }] };
	const built = redact(unselect, SEAT_1);
	assert.equal(built.selectable[0].code, 0);
	assert.equal(built.unselectable[0].code, 44);
	const sum = { kind: MSG.SELECT_SUM, player: 0, overshoot: false, sum: 8, min: 1, max: 3, must: [], cards: [{ code: 55, ...at(1, LOCATION.GRAVE), param: 4 }] };
	passes(sum, SEAT_0);
	console.log('prompts    ok');
}

{
	const private_ = { kind: MSG.HINT, type: HINT.SELECTMSG, player: 0, description: 500n };
	passes(private_, SEAT_0);
	passes(private_, BOTH);
	withheld(private_, SEAT_1);
	withheld(private_, GALLERY);

	const chosen = { kind: MSG.HINT, type: HINT.OPSELECTED, player: 1, description: 501n };
	passes(chosen, SEAT_0);
	passes(chosen, GALLERY);
	passes(chosen, BOTH);
	withheld(chosen, SEAT_1);

	const card = { kind: MSG.HINT, type: HINT.CARD, player: 1, description: 502n };
	for (const seats of EVERYONE) passes(card, seats);

	const hung = (type, place) => ({ kind: MSG.CARD_HINT, card: place, type, value: (14558127n << 20n) | 1n });
	const inHand = hung(CHINT.DESC_ADD, at(1, LOCATION.HAND, 2, POS.FACEDOWN));
	passes(inHand, SEAT_1);
	passes(inHand, BOTH);
	withheld(inHand, SEAT_0);
	withheld(inHand, GALLERY);
	withheld(hung(CHINT.DESC_ADD, at(0, LOCATION.MZONE, 1, POS.FACEDOWN_DEFENSE)), SEAT_1);
	for (const place of [at(0, LOCATION.MZONE, 1), at(1, LOCATION.HAND, 0, POS.FACEUP), at(0, LOCATION.GRAVE), at(0, LOCATION.MZONE | LOCATION.OVERLAY, 1, 2)]) {
		for (const seats of EVERYONE) passes(hung(CHINT.DESC_ADD, place), seats);
	}
	for (const seats of EVERYONE) passes(hung(CHINT.DESC_REMOVE, at(1, LOCATION.HAND, 2, POS.FACEDOWN)), seats);
	for (const seats of EVERYONE) passes(hung(CHINT.TURN, at(1, LOCATION.SZONE, 0, POS.FACEDOWN)), seats);
	for (const seats of EVERYONE) passes({ kind: MSG.PLAYER_HINT, player: 0, type: PHINT.DESC_ADD, description: 502n }, seats);
	console.log('hints      ok');
}

{
	const draw = { kind: MSG.DRAW, player: 0, cards: [{ code: 11, position: POS.FACEDOWN }, { code: 22, position: POS.FACEUP }] };
	passes(draw, SEAT_0);
	passes(draw, BOTH);
	for (const seats of [SEAT_1, GALLERY]) {
		const seen = redact(draw, seats);
		assert.deepEqual(seen.cards.map((card) => card.code), [0, 22], 'a face-up draw is public, a face-down one is not');
		assert.equal(seen.player, 0);
	}
	const shuffle = { kind: MSG.SHUFFLE_HAND, player: 1, codes: [11, 22, 33] };
	passes(shuffle, SEAT_1);
	assert.deepEqual(redact(shuffle, SEAT_0).codes, [0, 0, 0]);
	assert.deepEqual(redact({ ...shuffle, kind: MSG.SHUFFLE_EXTRA }, GALLERY).codes, [0, 0, 0]);
	const set = (code, extra = {}) => ({ code, position: POS.FACEDOWN, owner: 1, ...extra });
	const shuffled = { kind: MSG.SHUFFLE_SET_CARD, location: LOCATION.SZONE, from: [at(1, LOCATION.SZONE, 0, POS.FACEDOWN), at(1, LOCATION.SZONE, 2, POS.FACEDOWN)], to: [at(0, 0, 0, 0), at(0, 0, 0, 0)], landed: [set(11), set(22)] };
	passes(shuffled, SEAT_1);
	passes(shuffled, BOTH);
	for (const seats of [SEAT_0, GALLERY]) assert.deepEqual(redact(shuffled, seats).landed, [{ position: POS.FACEDOWN, owner: 1 }, { position: POS.FACEDOWN, owner: 1 }], 'a Set card is named to its controller alone, its owner to everyone');
	assert.equal(redact({ ...shuffled, landed: [set(11, { isHidden: true }), set(22)] }, SEAT_1).landed[0].code, undefined, 'a hidden one to nobody');
	passes({ ...shuffled, landed: undefined }, SEAT_0);
	const swap = { kind: MSG.TAG_SWAP, player: 0, deckCount: 30, extraPendulumCount: 0, deckTop: 0, hand: [{ code: 11, position: POS.FACEDOWN }], extra: [{ code: 22, position: POS.FACEDOWN }, { code: 33, position: POS.FACEUP }] };
	passes(swap, SEAT_0);
	const swapped = redact(swap, SEAT_1);
	assert.deepEqual(swapped.hand.map((card) => card.code), [0]);
	assert.deepEqual(swapped.extra.map((card) => card.code), [0, 33]);
	console.log('owner      ok');
}

{
	const move = (to, code = 77) => ({ kind: MSG.MOVE, code, from: at(0, LOCATION.HAND, 3, POS.FACEDOWN), to, reason: 0 });
	const toDeck = move(at(1, LOCATION.DECK, 0, POS.FACEDOWN_DEFENSE));
	passes(toDeck, SEAT_1);
	passes(toDeck, BOTH);
	assert.equal(redact(toDeck, SEAT_0).code, 0, 'into the other player\'s deck: hidden from the giver too');
	assert.equal(redact(toDeck, GALLERY).code, 0);
	assert.equal(redact(move(at(1, LOCATION.HAND, 0, POS.FACEDOWN)), GALLERY).code, 0);
	assert.equal(redact(move(at(0, LOCATION.MZONE, 2, POS.FACEDOWN_DEFENSE)), SEAT_1).code, 0, 'set on the field: face-down');
	passes(move(at(0, LOCATION.MZONE, 2, POS.FACEUP_ATTACK)), SEAT_1);
	passes(move(at(0, LOCATION.GRAVE, 0, POS.FACEUP)), GALLERY);
	passes(move(at(0, LOCATION.GRAVE, 0, POS.FACEDOWN)), GALLERY);
	passes(move(at(0, LOCATION.OVERLAY, 0, POS.FACEDOWN)), GALLERY);
	passes(move(at(0, LOCATION.REMOVED, 0, POS.FACEUP)), GALLERY);
	assert.equal(redact(move(at(0, LOCATION.REMOVED, 0, POS.FACEDOWN)), GALLERY).code, 0, 'banished face-down');
	passes(move(at(1, LOCATION.DECK, 0, POS.FACEDOWN_DEFENSE), 0), SEAT_0);

	const set = { kind: MSG.SET, code: 88, ...at(0, LOCATION.SZONE, 1, POS.FACEDOWN) };
	for (const seats of EVERYONE) {
		const seen = redact(set, seats);
		assert.equal(seen.code, 0, `SET is zeroed for ${JSON.stringify(seats)}`);
		assert.equal(seen.sequence, 1);
	}
	passes({ ...set, code: 0 }, SEAT_0);

	const summon = { kind: MSG.SPSUMMONING, code: 99, ...at(1, LOCATION.MZONE, 0, POS.FACEDOWN_DEFENSE) };
	passes(summon, SEAT_1);
	assert.equal(redact(summon, SEAT_0).code, 0);
	passes({ ...summon, position: POS.FACEUP_ATTACK }, SEAT_0);
	console.log('moves      ok');
}

{
	const ref = (controller, location) => ({ code: 11, controller, location, sequence: 0 });
	const look = { kind: MSG.CONFIRM_CARDS, player: 0, cards: [ref(0, LOCATION.DECK), ref(0, LOCATION.DECK)] };
	passes(look, SEAT_0);
	withheld(look, SEAT_1);
	withheld(look, GALLERY);
	withheld({ ...look, cards: [ref(1, LOCATION.EXTRA)] }, SEAT_1);
	for (const seats of EVERYONE) passes({ ...look, cards: [ref(1, LOCATION.HAND)] }, seats);
	for (const seats of EVERYONE) passes({ ...look, cards: [] }, seats);

	const missed = { kind: MSG.MISSED_EFFECT, card: at(1, LOCATION.GRAVE), code: 11 };
	passes(missed, SEAT_1);
	withheld(missed, SEAT_0);
	withheld(missed, GALLERY);

	for (const seats of EVERYONE) passes({ kind: MSG.NEW_TURN, player: 1 }, seats);
	for (const seats of EVERYONE) passes({ kind: MSG.WIN, player: 0, reason: 0 }, seats);
	for (const seats of EVERYONE) passes({ kind: MSG.CONFIRM_DECKTOP, player: 0, cards: [ref(0, LOCATION.DECK)] }, seats);
	console.log('reveals    ok');
}

{
	const card = { code: 11, alias: 0, type: TYPE.MONSTER, level: 4, attack: 1000, defense: 2000, position: POS.FACEDOWN_DEFENSE, counters: [{ type: 1, count: 2 }], isPublic: false, isHidden: false, owner: 1 };
	assert.equal(redactQuery(card, 1, SEAT_1), card);
	assert.equal(redactQuery(card, 1, BOTH), card);
	const seen = redactQuery(card, 1, SEAT_0);
	assert.deepEqual(seen, { position: POS.FACEDOWN_DEFENSE, counters: [{ type: 1, count: 2 }], isPublic: false, isHidden: false, owner: 1 });
	assert.deepEqual(redactQuery(card, 1, GALLERY), seen);
	assert.equal(redactQuery({ ...card, position: POS.FACEUP_DEFENSE }, 1, SEAT_0).code, 11, 'face-up is public');
	assert.equal(redactQuery({ ...card, isPublic: true }, 1, GALLERY).code, 11, 'a card the core calls public is');
	assert.equal(redactQuery({ ...card, isHidden: true }, 1, SEAT_1).code, undefined, 'hidden: not even the controller');
	assert.equal(redactQuery(null, 0, SEAT_0), null);
	console.log('queries    ok');
}

{
	const engine = await createEngine(browser, { log: () => {} });
	const duel = engine.createDuel({ seed: SEED, flags: DUEL.MODE_MR5, team1: TEAM, team2: TEAM, cardReader, scriptReader: () => null, clock: clockFromSeed(SEED) });
	loadDecks(duel, DECKS, { seed: SEED });
	duel.start();
	const stream = [];
	const result = play(duel, bot, { onBatch: (batch) => stream.push(...batch.messages) });
	assert.equal(result.reason, 'win');

	const views = EVERYONE.map((seats) => stream.map((message) => redact(message, seats)));
	const [seat0, seat1, gallery, both] = views;
	const prompts = stream.filter((message) => message.player !== undefined && [MSG.SELECT_IDLECMD, MSG.SELECT_BATTLECMD, MSG.SELECT_CARD, MSG.SELECT_PLACE, MSG.SELECT_POSITION, MSG.SELECT_CHAIN].includes(message.kind));
	assert.ok(prompts.length > 100, `${prompts.length} prompts`);
	stream.forEach((message, index) => {
		if (prompts.includes(message)) {
			const [own, other] = message.player === 0 ? [seat0, seat1] : [seat1, seat0];
			assert.equal(own[index]?.kind, message.kind, `the prompt at ${index} reaches its player`);
			for (const [entry, card] of (message.cards ?? []).entries()) {
				assert.equal(own[index].cards[entry].code, card.controller === message.player ? card.code : 0, `prompt at ${index}, entry ${entry}`);
			}
			assert.equal(other[index], null, `the prompt at ${index} is withheld from the other seat`);
			assert.equal(gallery[index], null, `the prompt at ${index} is withheld from the gallery`);
			assert.deepEqual(both[index], own[index], `both seats read the prompt at ${index} as its player does`);
		} else {
			for (const view of [seat0, seat1, gallery]) {
				if (view[index] === null) assert.equal(message.kind, MSG.HINT, `withheld at ${index}: kind ${message.kind}`);
			}
			assert.equal(both[index], message, `both seats at ${index}: nothing else is denied (no card is ever set in this duel)`);
		}
		if (message.kind === MSG.DRAW) {
			assert.ok(gallery[index].cards.every((card) => card.code === 0), 'the gallery sees no draw');
			const own = message.player === 0 ? seat0 : seat1;
			const other = message.player === 0 ? seat1 : seat0;
			assert.equal(own[index], message);
			assert.ok(other[index].cards.every((card) => card.code === 0));
		}
	});
	const denied = new Set([MSG.HINT, MSG.DRAW, MSG.MOVE, MSG.SET]);
	stream.forEach((message, index) => {
		if (denied.has(message.kind) || prompts.includes(message)) return;
		for (const view of views) assert.equal(view[index], message, `kind ${message.kind} at ${index} passes to everyone`);
	});
	const draws = stream.filter((message) => message.kind === MSG.DRAW).length;
	const hiddenMoves = stream.filter((message, index) => message.kind === MSG.MOVE && gallery[index].code === 0).length;
	duel.destroy();
	console.log(`duel       ok  ${stream.length} messages: ${prompts.length} prompts withheld from the other seat, ${draws} draws hidden from the gallery, ${hiddenMoves} moves zeroed for it`);
}
