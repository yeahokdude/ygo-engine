import assert from 'node:assert/strict';

import {
	ATTRIBUTE, DUEL, HINT, LOCATION, MSG, MSG_NAME, OPCODE, POS, RACE, TYPE,
	advance, clockFromSeed, createEngine, createTranslator, encodeResponse, isPrompt, loadDecks, memberKey, play, replyFor, responseFor, vocabulary, zoneOf,
} from '../driver/index.mjs';
import { DECODED_KINDS } from '../driver/messages.mjs';
import { translatePrompt } from '../driver/prompts.mjs';
import { CARDS, DECKS, SEED, TEAM, bot, browserEntry, cardReader, stringify } from './vanilla.mjs';

const { OUTCOME, PACK_PHASE, REGION, SHAPE, VERB, ZONE, seatZone } = vocabulary;
const browser = await browserEntry();

const bytesOf = (kind, response) => Buffer.from(encodeResponse(kind, response)).toString('hex');

{
	const prompts = DECODED_KINDS.filter(isPrompt);
	const unruled = prompts.filter((kind) => {
		try {
			translatePrompt({ kind }, null);
		} catch (error) {
			return /no rule for/.test(error.message);
		}
		return false;
	});
	assert.deepEqual(unruled, []);
	assert.equal(prompts.length, 21);
	console.log('kinds      ok  21 translated');
}

{
	const engine = await createEngine(browser, { log: () => {} });
	const duel = engine.createDuel({ seed: SEED, flags: DUEL.MODE_MR5, team1: TEAM, team2: TEAM, cardReader, scriptReader: () => null, clock: clockFromSeed(SEED) });
	const orders = loadDecks(duel, DECKS, { seed: SEED });
	duel.start();
	const translator = createTranslator({ seats: [0, 1] });
	translator.open(orders);
	const families = {};
	let members = 0;
	let captioned = 0;
	const result = play(
		duel,
		(prompt) => {
			const translated = translator.prompt(prompt);
			assert.equal(translated.kind, prompt.kind);
			assert.equal(translated.player, prompt.player);
			if (translated.caption !== null) {
				captioned++;
				assert.equal(translated.caption.code, 0, `a scriptless duel captions with system strings only: ${stringify(translated.caption)}`);
			}
			families[translated.family] = (families[translated.family] ?? 0) + 1;
			members += translated.members.length;
			const held = new Set(translator.board().flatMap((seat) => [...seat.mzone, ...seat.szone, ...seat.deck, ...seat.hand, ...seat.grave, ...seat.removed, ...seat.extra].filter(Boolean).map((card) => card.inst)));
			for (const member of translated.members) {
				if (member.subject.kind === 'instance') assert.ok(held.has(member.subject.inst), `member ${JSON.stringify(member)} names a handle the shadow does not hold`);
			}
			assert.equal(new Set(translated.members.map(memberKey)).size, translated.members.length, 'members key apart');
			const raw = bot(prompt);
			const reply = replyFor(translated, raw);
			assert.equal(bytesOf(prompt.kind, responseFor(translated, reply)), bytesOf(prompt.kind, raw), `${MSG_NAME[prompt.kind]}: ${stringify(raw)} → ${stringify(reply)}`);
			return raw;
		},
		{ onBatch: (batch) => translator.translate(batch.messages) },
	);
	assert.equal(result.reason, 'win');
	assert.ok(families.idle > 0 && families.battle > 0 && families.zone > 0 && families.chain > 0 && families.cards > 0, stringify(families));
	assert.ok(captioned > 0 && captioned < result.decisions, `${captioned} captioned of ${result.decisions}`);
	duel.destroy();
	console.log(`vanilla    ok  ${result.decisions} prompts round-tripped, ${members} members, ${captioned} captioned — ${Object.entries(families).map(([family, count]) => `${family} ${count}`).join(', ')}`);
}

{
	const resolve = { handle: ({ controller, location, sequence }) => 1000 + controller * 100 + location * 10 + sequence, zone: zoneOf };
	const translator = createTranslator({ seats: [0, 1] });
	translator.open([{ main: [1, 2, 3] }, { main: [4, 5, 6] }]);
	const at = (controller, location, sequence, position = POS.FACEUP_ATTACK) => ({ controller, location, sequence, position });
	const packPlace = (player, location, sequence) => (player << 16) | (location << 8) | sequence;
	const card = (code, controller, location, sequence, position) => ({ code, ...at(controller, location, sequence, position) });
	const translate = (message) => translatePrompt(message, resolve);
	const roundTrip = (message, raw) => {
		const prompt = translate(message);
		const reply = replyFor(prompt, raw);
		assert.equal(bytesOf(message.kind, responseFor(prompt, reply)), bytesOf(message.kind, raw), `${MSG_NAME[message.kind]}: ${stringify(raw)} → ${stringify(reply)}`);
		return { prompt, reply };
	};

	{
		const idle = {
			kind: MSG.SELECT_IDLECMD, player: 0,
			summonable: [card(1, 0, LOCATION.HAND, 0)], spSummonable: [card(1, 0, LOCATION.HAND, 0), card(7, 0, LOCATION.EXTRA, 0)], repositionable: [card(3, 0, LOCATION.MZONE, 2)],
			monsterSettable: [card(1, 0, LOCATION.HAND, 0)], spellSettable: [card(2, 0, LOCATION.HAND, 1)],
			activatable: [{ ...card(3, 0, LOCATION.MZONE, 2), description: (3n << 20n) | 1n, clientMode: 0 }, { ...card(3, 0, LOCATION.MZONE, 2), description: (3n << 20n) | 2n, clientMode: 1 }],
			toBp: true, toEp: true, canShuffle: true,
		};
		const { prompt } = roundTrip(idle, { action: 1, index: 1 });
		assert.equal(prompt.family, 'idle');
		assert.deepEqual(prompt.members.map((member) => member.verb), [VERB.normalSummon, VERB.specialSummon, VERB.specialSummon, VERB.position, VERB.setMonster, VERB.setSpellTrap, VERB.activate, VERB.activate, VERB.phase, VERB.phase, VERB.shuffleHand]);
		assert.deepEqual(prompt.members.slice(6, 8).map((member) => [member.description, member.clientMode, member.caption]), [[(3 << 20) | 1, undefined, { code: 3, index: 1 }], [(3 << 20) | 2, 1, { code: 3, index: 2 }]], 'one member per effect, keyed by description');
		assert.deepEqual(prompt.members.slice(8).map((member) => [member.description, member.payload]), [[PACK_PHASE.BP, 6], [PACK_PHASE.EP, 7], [undefined, 8]]);
		assert.equal(prompt.members[1].subject.inst, prompt.members[0].subject.inst, 'the same hand card in two lists is two members');
		for (const raw of [{ action: 0, index: 0 }, { action: 5, index: 1 }, { action: 6 }, { action: 8 }]) roundTrip(idle, raw);
		assert.throws(() => replyFor(prompt, { action: 2, index: 5 }), /no member/);
		assert.throws(() => responseFor(prompt, { shape: SHAPE.SUBSET, members: [0] }), /takes shape 1/);
		assert.throws(() => responseFor(prompt, { shape: SHAPE.ONE_OF, member: 11 }), /no member 11/);
		assert.throws(() => responseFor(prompt, { shape: SHAPE.TERMINAL, outcome: OUTCOME.DECLINE }), /cannot be walked away from/);
	}
	{
		const idle = {
			kind: MSG.SELECT_IDLECMD, player: 0, summonable: [],
			spSummonable: [
				{ ...card(1, 0, LOCATION.HAND, 0), positions: { own: POS.FACEUP_DEFENSE, across: 0 } },
				{ ...card(1, 0, LOCATION.HAND, 0), positions: { own: POS.FACEUP_DEFENSE, across: 0 } },
				{ ...card(7, 0, LOCATION.EXTRA, 0), positions: { own: POS.FACEUP, across: 0 } },
				{ ...card(8, 0, LOCATION.EXTRA, 1), positions: { own: POS.FACEUP_ATTACK | POS.FACEDOWN_DEFENSE, across: 0 } },
				{ ...card(9, 0, LOCATION.GRAVE, 0), positions: { own: POS.FACEDOWN_ATTACK, across: 0 } },
				card(10, 0, LOCATION.REMOVED, 0),
				{ ...card(11, 0, LOCATION.HAND, 1), positions: { own: 0, across: POS.FACEUP } },
				{ ...card(12, 0, LOCATION.HAND, 2), positions: { own: POS.FACEUP_ATTACK, across: POS.FACEUP_DEFENSE } },
			],
			repositionable: [], monsterSettable: [], spellSettable: [], activatable: [], toBp: false, toEp: true, canShuffle: false,
		};
		const { prompt } = roundTrip(idle, { action: 1, index: 0 });
		const summons = prompt.members.filter((member) => member.verb === VERB.specialSummon);
		assert.deepEqual(
			summons.map((member) => [member.code, member.regions, member.across, member.payload]),
			[
				[1, [REGION.DEF], undefined, 1],
				[7, [REGION.ATK, REGION.DEF], undefined, (2 << 16) | 1],
				[8, [REGION.ATK, REGION.SET_DEF], undefined, (3 << 16) | 1],
				[9, undefined, undefined, (4 << 16) | 1],
				[10, undefined, undefined, (5 << 16) | 1],
				[11, undefined, [REGION.ATK, REGION.DEF], (6 << 16) | 1],
				[12, [REGION.ATK], [REGION.DEF], (7 << 16) | 1],
			],
			'a card listed twice is one member, at its first index, each in the regions of the positions it may take on its own side and across',
		);
		for (const raw of [{ action: 1, index: 2 }, { action: 1, index: 5 }]) roundTrip(idle, raw);
		assert.throws(() => replyFor(prompt, { action: 1, index: 1 }), /no member/);
	}
	{
		const idle = {
			kind: MSG.SELECT_IDLECMD, player: 0, summonable: [],
			spSummonable: [
				{
					...card(7, 0, LOCATION.EXTRA, 0),
					positions: { own: POS.FACEUP, across: 0 },
					landings: [
						{ controller: 0, sequence: 6, positions: POS.FACEUP_ATTACK },
						{ controller: 1, sequence: 2, positions: POS.FACEUP_DEFENSE },
						{ controller: 1, sequence: 5, positions: POS.FACEUP_DEFENSE },
						{ controller: 0, sequence: 3, positions: POS.FACEDOWN_ATTACK },
					],
				},
				{ ...card(8, 0, LOCATION.HAND, 0), positions: { own: POS.FACEUP, across: 0 }, landings: [] },
			],
			repositionable: [], monsterSettable: [], spellSettable: [], activatable: [], toBp: false, toEp: true, canShuffle: false,
		};
		const { prompt } = roundTrip(idle, { action: 1, index: 1 });
		assert.deepEqual(
			prompt.members.filter((member) => member.verb === VERB.specialSummon).map((member) => [member.code, member.zones, member.regions, member.across]),
			[
				[7, [{ zone: seatZone(1, ZONE.MZ[2]), regions: [REGION.DEF] }, { zone: zoneOf(0, LOCATION.MZONE, 6), regions: [REGION.ATK, REGION.DEF] }], undefined, undefined],
				[8, [], undefined, undefined],
			],
			'a summon tried is in the zones it landed in, a shared zone named from either side once, each with the bands of the positions it took there — none that no band draws — and nothing read off its procedures',
		);
	}
	{
		const battle = { kind: MSG.SELECT_BATTLECMD, player: 1, activatable: [], attackable: [{ ...card(4, 1, LOCATION.MZONE, 0), canDirect: true }, { ...card(5, 1, LOCATION.MZONE, 1), canDirect: false }], toM2: false, toEp: true };
		const { prompt } = roundTrip(battle, { action: 1, index: 1 });
		assert.deepEqual(prompt.members.map((member) => [member.verb, member.direct, member.payload]), [[VERB.attack, true, 1], [VERB.attack, false, (1 << 16) | 1], [VERB.phase, undefined, 3]]);
		assert.equal(prompt.members[2].description, PACK_PHASE.EP);
	}
	{
		const yn = { kind: MSG.SELECT_EFFECTYN, player: 0, ...card(3, 0, LOCATION.MZONE, 2), description: (3n << 20n) | 4n };
		const { prompt } = roundTrip(yn, true);
		roundTrip(yn, false);
		assert.equal(prompt.family, 'yesno');
		assert.deepEqual(prompt.caption, { code: 3, index: 4 });
		assert.deepEqual(prompt.members.map((member) => [member.subject.kind, member.verb, member.payload]), [['instance', VERB.no, 0], ['instance', VERB.yes, 1]]);
		const { prompt: plain } = roundTrip({ kind: MSG.SELECT_YESNO, player: 1, description: 221n }, false);
		assert.deepEqual(plain.members.map((member) => member.subject), [{ kind: 'seat', seat: 1 }, { kind: 'seat', seat: 1 }]);
		assert.deepEqual(plain.caption, { code: 0, index: 221 });
	}
	{
		const { prompt } = roundTrip({ kind: MSG.SELECT_OPTION, player: 0, options: [573n, (45663742n << 20n) | 2n] }, 1);
		assert.equal(prompt.family, 'option');
		assert.deepEqual(prompt.members.map((member) => [member.verb, member.description, member.caption]), [[VERB.option, 0, { code: 0, index: 573 }], [VERB.option, 1, { code: 45663742, index: 2 }]]);
	}
	{
		const select = { kind: MSG.SELECT_CARD, player: 0, cancelable: true, min: 0, max: 2, cards: [card(1, 0, LOCATION.HAND, 0), card(2, 0, LOCATION.HAND, 1), card(0, 1, LOCATION.MZONE, 0)] };
		const { prompt, reply } = roundTrip(select, [2, 0]);
		assert.deepEqual(reply, { shape: SHAPE.SUBSET, members: [2, 0] });
		assert.deepEqual([prompt.family, prompt.min, prompt.max, prompt.cancelable, prompt.finishable], ['cards', 0, 2, true, false]);
		assert.deepEqual(prompt.members.map((member) => [member.verb, member.code]), [[VERB.pick, 1], [VERB.pick, 2], [VERB.pick, 0]], 'a zeroed code rides as 0');
		assert.deepEqual(roundTrip(select, null).reply, { shape: SHAPE.TERMINAL, outcome: OUTCOME.CANCEL });
		assert.throws(() => responseFor(prompt, { shape: SHAPE.SUBSET, members: [1, 1] }), /picked twice/);
		assert.throws(() => responseFor(prompt, { shape: SHAPE.TERMINAL, outcome: OUTCOME.EMPTY }), /offers 3/);
		assert.throws(() => responseFor(prompt, { shape: SHAPE.TERMINAL, outcome: OUTCOME.FINISH }), /cannot be finished/);
		assert.throws(() => responseFor({ ...prompt, cancelable: false }, { shape: SHAPE.TERMINAL, outcome: OUTCOME.CANCEL }), /cannot be walked away from/);
		const listed = [61027400, 42377643, 61027400];
		const named = { kind: MSG.SELECT_CARD, player: 1, cancelable: false, min: 1, max: 1, cards: listed.map((code) => ({ code, controller: 1, location: 0, sequence: 0, position: 0 })) };
		const { prompt: names, reply: picked } = roundTrip(named, [2]);
		assert.deepEqual(picked, { shape: SHAPE.SUBSET, members: [2] });
		assert.deepEqual([names.family, names.shape, names.min, names.max, names.cancelable], ['cards', SHAPE.SUBSET, 1, 1, false]);
		assert.deepEqual(names.members, listed.map((code, index) => ({ subject: { kind: 'seat', seat: 1 }, verb: VERB.pick, description: index, payload: index, code })), 'a list at no place is one member per entry, on the seat, a code listed twice two');
		assert.throws(() => translate({ ...select, cards: [...select.cards, { code: 1, controller: 0, location: 0, sequence: 0, position: 0 }] }), /no place/);
	}
	{
		const build = { kind: MSG.SELECT_UNSELECT_CARD, player: 0, finishable: true, cancelable: false, min: 1, max: 3, selectable: [card(1, 0, LOCATION.HAND, 0), card(2, 0, LOCATION.HAND, 1)], unselectable: [card(3, 0, LOCATION.MZONE, 2)] };
		const { prompt } = roundTrip(build, 2);
		assert.equal(prompt.family, 'build');
		assert.deepEqual(prompt.members.map((member) => [member.verb, member.payload]), [[VERB.pick, 0], [VERB.pick, 1], [VERB.unpick, 2]]);
		assert.deepEqual([prompt.min, prompt.max, prompt.cancelable, prompt.finishable], [1, 3, false, true]);
		assert.deepEqual(roundTrip(build, null).reply, { shape: SHAPE.TERMINAL, outcome: OUTCOME.FINISH });
		assert.deepEqual(replyFor(translate({ ...build, finishable: false, cancelable: true }), null), { shape: SHAPE.TERMINAL, outcome: OUTCOME.CANCEL });
		assert.deepEqual(replyFor(translate({ ...build, selectable: [], unselectable: [] }), null), { shape: SHAPE.TERMINAL, outcome: OUTCOME.EMPTY });
	}
	{
		const tribute = { kind: MSG.SELECT_TRIBUTE, player: 0, cancelable: true, min: 2, max: 2, cards: [{ code: 1, controller: 0, location: LOCATION.MZONE, sequence: 0, releaseParam: 1 }, { code: 2, controller: 0, location: LOCATION.MZONE, sequence: 1, releaseParam: 2 }] };
		const { prompt } = roundTrip(tribute, [1]);
		assert.equal(prompt.family, 'tribute');
		assert.deepEqual(prompt.members.map((member) => member.value), [1, 2]);
	}
	{
		const sum = { kind: MSG.SELECT_SUM, player: 0, overshoot: false, sum: 8, min: 1, max: 2, must: [{ ...card(1, 0, LOCATION.MZONE, 0), param: 4 }], cards: [{ ...card(2, 0, LOCATION.MZONE, 1), param: (6 << 16) | 4 }, { ...card(3, 0, LOCATION.MZONE, 2), param: 2 }] };
		const { prompt } = roundTrip(sum, [0]);
		assert.equal(prompt.family, 'sum');
		assert.deepEqual(prompt.sum, { target: 8, overshoot: false, must: [{ subject: { kind: 'instance', inst: resolve.handle(at(0, LOCATION.MZONE, 0)) }, code: 1, range: [4, 0] }] });
		assert.deepEqual(prompt.members.map((member) => member.range), [[4, 6], [2, 0]]);
		assert.equal(prompt.cancelable, false);
		assert.throws(() => responseFor(prompt, replyFor(prompt, null)), /cannot be walked away from/);
	}
	{
		const counter = { kind: MSG.SELECT_COUNTER, player: 0, counterType: 0x1001, count: 3, cards: [{ code: 1, controller: 0, location: LOCATION.MZONE, sequence: 0, count: 2 }, { code: 2, controller: 0, location: LOCATION.MZONE, sequence: 1, count: 4 }] };
		const { prompt, reply } = roundTrip(counter, [2, 1]);
		assert.equal(prompt.family, 'counter');
		assert.deepEqual([prompt.total, prompt.counterType, prompt.members.map((member) => member.count)], [3, 0x1001, [2, 4]]);
		assert.deepEqual(reply, { shape: SHAPE.ALLOCATION, allocation: [{ member: 0, amount: 2 }, { member: 1, amount: 1 }] });
		assert.deepEqual(responseFor(prompt, { shape: SHAPE.ALLOCATION, allocation: [{ member: 1, amount: 3 }] }), [0, 3]);
	}
	{
		const open = (1 << 0) | (1 << 4) | (1 << 10) | (1 << (16 + 6));
		const place = { kind: MSG.SELECT_PLACE, player: 1, count: 1, mask: ~open >>> 0 };
		const { prompt } = roundTrip(place, [{ player: 1, location: LOCATION.SZONE, sequence: 2 }]);
		assert.equal(prompt.family, 'zone');
		assert.deepEqual([prompt.min, prompt.max, prompt.cancelable], [1, 1, false]);
		assert.deepEqual(prompt.members.map((member) => [member.verb, member.subject.zone]), [
			[VERB.place, seatZone(1, ZONE.MZ[0])],
			[VERB.place, seatZone(1, ZONE.MZ[4])],
			[VERB.place, seatZone(1, ZONE.ST[2])],
			[VERB.place, zoneOf(0, LOCATION.MZONE, 6)],
		]);
		roundTrip(place, [{ player: 0, location: LOCATION.MZONE, sequence: 6 }]);
		const nowhere = translate({ ...place, mask: ~((1 << 7) | (1 << 14) | (1 << 15)) >>> 0 });
		assert.deepEqual(nowhere.members, [], 'bits that name no zone are not members');
		const disable = { kind: MSG.SELECT_DISFIELD, player: 0, count: 2, mask: ~open >>> 0 };
		const two = translate(disable);
		assert.deepEqual([two.family, two.min, two.max], ['zone', 2, 2]);
		const forCard = translatePrompt(place, resolve, 14558127n);
		assert.deepEqual([forCard.code, forCard.caption], [14558127, null]);
		assert.deepEqual([translatePrompt(place, resolve, null).code, prompt.caption], [0, null]);
		assert.deepEqual(translatePrompt(disable, resolve, 570n).caption, { code: 0, index: 570 });
		const shared = translate({ kind: MSG.SELECT_PLACE, player: 0, count: 1, mask: ~((1 << 5) | (1 << (16 + 6))) >>> 0 });
		assert.deepEqual(shared.members.map((member) => [member.subject.zone, member.payload]), [[zoneOf(0, LOCATION.MZONE, 5), packPlace(0, LOCATION.MZONE, 5)]]);
		roundTrip({ kind: MSG.SELECT_PLACE, player: 0, count: 1, mask: ~((1 << 5) | (1 << (16 + 6))) >>> 0 }, [{ player: 0, location: LOCATION.MZONE, sequence: 5 }]);
	}
	{
		const position = { kind: MSG.SELECT_POSITION, player: 0, code: 7, positions: POS.FACEUP_ATTACK | POS.FACEUP_DEFENSE | POS.FACEDOWN_DEFENSE | POS.FACEDOWN_ATTACK };
		const { prompt } = roundTrip(position, POS.FACEUP_DEFENSE);
		assert.equal(prompt.family, 'position');
		assert.equal(prompt.code, 7);
		assert.deepEqual(prompt.members.map((member) => [member.verb, member.regions, member.payload]), [
			[VERB.specialAtk, [REGION.ATK], POS.FACEUP_ATTACK],
			[VERB.specialDef, [REGION.DEF], POS.FACEUP_DEFENSE],
			[VERB.setMonster, [REGION.SET_DEF], POS.FACEDOWN_DEFENSE],
			[VERB.setAttack, undefined, POS.FACEDOWN_ATTACK],
		]);
		assert.deepEqual(translate({ ...position, positions: POS.FACEUP_ATTACK }).members.length, 1);
	}
	{
		const sort = { kind: MSG.SORT_CARD, player: 0, cards: [{ code: 1, controller: 0, location: LOCATION.GRAVE, sequence: 0 }, { code: 2, controller: 0, location: LOCATION.GRAVE, sequence: 1 }, { code: 3, controller: 0, location: LOCATION.GRAVE, sequence: 2 }] };
		const { prompt, reply } = roundTrip(sort, [2, 0, 1]);
		assert.deepEqual([prompt.family, prompt.cancelable, reply], ['sort', true, { shape: SHAPE.RANKING, order: [2, 0, 1] }]);
		assert.deepEqual(roundTrip(sort, null).reply, { shape: SHAPE.TERMINAL, outcome: OUTCOME.DECLINE });
		assert.throws(() => responseFor(prompt, { shape: SHAPE.RANKING, order: [1, 0] }), /ranks all 3/);
		roundTrip({ ...sort, kind: MSG.SORT_CHAIN }, [1, 0, 2]);
	}
	{
		const link = (code, sequence, description) => ({ ...card(code, 1, LOCATION.MZONE, sequence), description, clientMode: 0 });
		const chain = { kind: MSG.SELECT_CHAIN, player: 1, specialCount: 1, forced: false, hintTiming: [0x8, 0], chains: [link(4, 0, (4n << 20n) | 0n), link(5, 1, (5n << 20n) | 1n)] };
		const { prompt } = roundTrip(chain, 1);
		assert.deepEqual([prompt.family, prompt.cancelable, prompt.ordering, prompt.useful, prompt.timing], ['chain', true, false, true, [8, 0]]);
		assert.equal(translate({ ...chain, specialCount: 0 }).useful, false);
		assert.deepEqual(prompt.members.map((member) => [member.verb, member.description, member.payload]), [[VERB.activate, 4 << 20, 0], [VERB.activate, (5 << 20) | 1, 1]]);
		assert.deepEqual(roundTrip(chain, null).reply, { shape: SHAPE.TERMINAL, outcome: OUTCOME.DECLINE });
		const empty = translate({ ...chain, specialCount: 0, chains: [] });
		assert.equal(empty.useful, false);
		assert.deepEqual(replyFor(empty, null), { shape: SHAPE.TERMINAL, outcome: OUTCOME.EMPTY });
		assert.equal(responseFor(empty, { shape: SHAPE.TERMINAL, outcome: OUTCOME.EMPTY }), null);
		const forced = translate({ ...chain, forced: true, specialCount: 0x7f });
		assert.deepEqual([forced.cancelable, forced.ordering], [false, true]);
		assert.throws(() => responseFor(forced, { shape: SHAPE.TERMINAL, outcome: OUTCOME.DECLINE }), /cannot be walked away from/);
		assert.throws(() => translate({ ...chain, chains: [link(4, 0, 9n), link(4, 0, 9n)] }), /key the same/);
	}
	{
		const race = { kind: MSG.ANNOUNCE_RACE, player: 0, count: 2, available: BigInt(RACE.WARRIOR) | BigInt(RACE.DRAGON) | (1n << 62n) };
		const { prompt, reply } = roundTrip(race, BigInt(RACE.DRAGON) | (1n << 62n));
		assert.deepEqual([prompt.family, prompt.min, prompt.max], ['race', 2, 2]);
		const bitOf = (mask) => BigInt(mask).toString(2).length - 1;
		assert.deepEqual(prompt.members.map((member) => [member.verb, member.description]), [[VERB.declare, bitOf(RACE.WARRIOR)], [VERB.declare, bitOf(RACE.DRAGON)], [VERB.declare, 62]]);
		assert.deepEqual(reply, { shape: SHAPE.SUBSET, members: [1, 2] });
		const attribute = { kind: MSG.ANNOUNCE_ATTRIB, player: 0, count: 1, available: ATTRIBUTE.LIGHT | ATTRIBUTE.DARK };
		roundTrip(attribute, ATTRIBUTE.DARK);
		assert.equal(translate(attribute).family, 'attribute');
		assert.deepEqual(translate(attribute).members.map((member) => [member.verb, member.description]), [[VERB.declare, 4], [VERB.declare, 5]]);
		const number = { kind: MSG.ANNOUNCE_NUMBER, player: 0, options: [4n, 8n, 12n] };
		const numbered = roundTrip(number, 2).prompt;
		assert.equal(numbered.family, 'announce');
		assert.deepEqual(numbered.members.map((member) => [member.verb, member.value, member.payload]), [[VERB.declare, 4, 0], [VERB.declare, 8, 1], [VERB.declare, 12, 2]]);
		const pool = { codes: [5, 6, 7], read: (code) => ({ code, alias: code === 7 ? 5 : 0, setcodes: [], type: 0x11, attribute: 1, race: 1n }) };
		const card = { kind: MSG.ANNOUNCE_CARD, player: 1, opcodes: [0x11n, OPCODE.ISTYPE] };
		const announced = translatePrompt(card, resolve, null, pool);
		assert.deepEqual([announced.family, announced.shape, announced.cancelable], ['announce', SHAPE.ONE_OF, false]);
		assert.deepEqual(announced.members, [5, 6].map((code) => ({ subject: { kind: 'seat', seat: 1 }, verb: VERB.declare, description: code, payload: code, code })), 'one member per code the expression declares, an alias left out');
		assert.deepEqual(replyFor(announced, 6), { shape: SHAPE.ONE_OF, member: 1 });
		assert.equal(bytesOf(card.kind, responseFor(announced, { shape: SHAPE.ONE_OF, member: 1 })), bytesOf(card.kind, 6));
		assert.throws(() => translate(card), /holds none/);
		const pooled = createTranslator({ seats: [0, 1], pool });
		pooled.open([{ main: [5] }, { main: [6] }]);
		assert.deepEqual(pooled.prompt(card).members.map((member) => member.code), [5, 6], 'the translator declares from the pool it was given');
	}
	{
		const { prompt } = roundTrip({ kind: MSG.ROCK_PAPER_SCISSORS, player: 1 }, 3);
		assert.deepEqual([prompt.family, prompt.members.map((member) => [member.verb, member.description])], ['rps', [[VERB.rps, 1], [VERB.rps, 2], [VERB.rps, 3]]]);
	}
	{
		assert.throws(() => translate({ kind: MSG.DRAW, player: 0, cards: [] }), /is not a prompt/);
		assert.throws(() => responseFor(translate({ kind: MSG.ROCK_PAPER_SCISSORS, player: 0 }), { shape: 9 }), /takes shape 1, not 9/);
	}
	{
		translator.translate([{ kind: MSG.HINT, type: HINT.SELECTMSG, player: 0, description: (2n << 20n) | 1n }]);
		const first = translator.prompt({ kind: MSG.SELECT_YESNO, player: 0, description: 0n });
		assert.deepEqual(first.caption, { code: 2, index: 1 });
		assert.equal(translator.prompt({ kind: MSG.SELECT_YESNO, player: 0, description: 0n }).caption, null, 'consumed');
		translator.translate([{ kind: MSG.HINT, type: HINT.SELECTMSG, player: 0, description: 505n }, { kind: MSG.HINT, type: HINT.EVENT, player: 0, description: 7n }]);
		assert.deepEqual(translator.prompt({ kind: MSG.SELECT_YESNO, player: 0, description: 0n }).caption, { code: 0, index: 505 }, 'another hint kind leaves it standing');
		translator.translate([{ kind: MSG.HINT, type: HINT.SELECTMSG, player: 0, description: 505n }, { kind: MSG.HINT, type: HINT.SELECTMSG, player: 0, description: 0n }]);
		assert.equal(translator.prompt({ kind: MSG.SELECT_YESNO, player: 0, description: 0n }).caption, null, 'a zero hint clears it');
		translator.translate([{ kind: MSG.HINT, type: HINT.SELECTMSG, player: 0, description: 221n }]);
		assert.deepEqual(translator.prompt({ kind: MSG.SELECT_YESNO, player: 0, description: 9n }).caption, { code: 0, index: 221 }, 'a hint outranks the message\'s own caption');
		assert.throws(() => createTranslator({ seats: [0] }).prompt({ kind: MSG.SELECT_YESNO, player: 0, description: 0n }), /not open/);
	}
	console.log('cases      ok');
}

{
	const SPELL = 81;
	const LISTED = [5, 84, 5, 999];
	const rows = new Map(CARDS).set(SPELL, { code: SPELL, alias: 0, setcodes: [], type: TYPE.SPELL, level: 0, attribute: 0, race: 0, attack: 0, defense: 0 });
	const script = `function c${SPELL}.initial_effect(c)
	local e=Effect.CreateEffect(c)
	e:SetType(0x10)
	e:SetCode(1002)
	e:SetTarget(function(e,tp,eg,ep,ev,re,r,rp,chk)
		if chk==0 then return true end
		local said={}
		for _,one in ipairs({Duel.SelectCardsFromCodes(1-tp,BOUNDS[1],BOUNDS[2],BOUNDS[3],true,${LISTED.join(',')})}) do said[#said+1]=one[1]..':'..one[2] end
		Debug.Message('picked '..table.concat(said,','))
	end)
	c:RegisterEffect(e)
end`;
	const said = [];
	const engine = await createEngine(browser, { log: () => {} });
	const scripts = new Map([[`c${SPELL}.lua`, script]]);
	const duel = engine.createDuel({ seed: SEED, flags: DUEL.MODE_MR5, team1: TEAM, team2: TEAM, cardReader: (code) => rows.get(code) ?? null, scriptReader: (name) => scripts.get(name) ?? null, clock: clockFromSeed(SEED), log: ({ text }) => text.startsWith('picked') && said.push(text) });
	loadDecks(duel, [{ main: [SPELL, ...DECKS[0].main.slice(1)], extra: [] }, DECKS[1]], { seed: SEED, shuffle: false });
	duel.start();
	const asked = () => {
		for (;;) {
			const step = advance(duel);
			if (step.prompt !== null || step.retry) return step;
		}
	};
	const opening = asked();
	const idle = engine.snapshot();
	const activation = opening.prompt.activatable.findIndex((effect) => effect.code === SPELL);
	assert.notEqual(activation, -1, 'the spell in hand may be activated');
	const cases = [
		{ bounds: [1, 1, false], replies: [[0], [1], [2], [3]], refused: [[0, 1], []] },
		{ bounds: [0, 2, false], replies: [[3, 0], [], [1]], refused: [[0, 1, 2]] },
	];
	let taken = 0;
	for (const { bounds: [min, max, cancel], replies, refused } of cases) {
		engine.restore(idle);
		assert.ok(duel.loadScript('bounds.lua', `BOUNDS={${min},${max},${cancel}}`));
		duel.respond(MSG.SELECT_IDLECMD, { action: 5, index: activation });
		let step = asked();
		while (step.prompt?.kind === MSG.SELECT_PLACE) {
			const open = Array.from({ length: 5 }, (_, sequence) => sequence).find((sequence) => !((step.prompt.mask >>> (8 + sequence)) & 1));
			duel.respond(MSG.SELECT_PLACE, [{ player: 0, location: LOCATION.SZONE, sequence: open }]);
			step = asked();
		}
		assert.equal(step.prompt?.kind, MSG.SELECT_CARD, `${min}..${max} asks a card list`);
		const prompt = translatePrompt(step.prompt, null);
		assert.deepEqual([prompt.player, prompt.min, prompt.max, prompt.cancelable], [1, min, max, cancel || min === 0]);
		assert.deepEqual(prompt.members.map((member) => [member.subject.seat, member.code]), LISTED.map((code) => [1, code]), 'the list as the script gave it, on the seat it asks');
		const asking = engine.snapshot();
		for (const members of replies) {
			engine.restore(asking);
			said.length = 0;
			const reply = members.length === 0 ? { shape: SHAPE.TERMINAL, outcome: OUTCOME.CANCEL } : { shape: SHAPE.SUBSET, members };
			const response = responseFor(prompt, reply);
			assert.deepEqual(replyFor(prompt, response), reply);
			duel.respond(MSG.SELECT_CARD, response);
			assert.equal(asked().retry, false, `${stringify(reply)} is taken`);
			assert.deepEqual(said, [`picked ${members.map((member) => `${LISTED[member]}:${member + 1}`).join(',')}`], `${stringify(reply)} picks the codes its members carry`);
			taken++;
		}
		for (const members of refused) {
			engine.restore(asking);
			duel.respond(MSG.SELECT_CARD, members);
			assert.equal(asked().retry, true, `${stringify(members)} is refused by the core`);
		}
	}
	duel.destroy();
	console.log(`names      ok  ${taken} answers taken of a list at no place, each the codes its members carry`);
}
