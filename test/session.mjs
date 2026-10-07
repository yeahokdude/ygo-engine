import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';

import { ATTRIBUTE, DUEL_STATUS, LOCATION, MSG, QUERY, RACE, TYPE, clockFromSeed, createTranslator, redact, vocabulary } from '../driver/index.mjs';
import { PROTOCOL, createSession } from '../host/session.mjs';
import { DECKS, SEED, TEAM, browserEntry, cardReader, directDuel, stringify } from './vanilla.mjs';

const { EMZ, FLAG, OUTCOME, PACK_PHASE, SHAPE, TAG, VERB, ZONE, seatZone, zoneRef } = vocabulary;
const browser = await browserEntry();
const STARTING_LP = [TEAM.startingLP, TEAM.startingLP];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const until = async (frames, test) => {
	for (let waited = 0; waited < 1000; waited++) {
		if (frames.some(test)) return;
		await tick();
	}
	throw new Error('waited in vain');
};
const filtered = (messages, seats) => messages.map((message) => redact(message, seats)).filter((message) => message !== null);

const direct = await directDuel(browser);

function viewOf(seats) {
	const translator = createTranslator({ seats, startingLP: STARTING_LP });
	const steps = [];
	let rows = translator.open(direct.orders);
	let polls = 0;
	for (const batch of direct.batches) {
		rows.push(...translator.translate(filtered(batch.messages, seats)));
		if (!batch.win && batch.status === DUEL_STATUS.CONTINUE) continue;
		rows.push(...translator.stats(direct.fields[polls++]));
		const asked = batch.win || batch.status === DUEL_STATUS.END ? null : batch.prompt;
		const mine = asked !== null && seats.includes(asked.player);
		steps.push({ rows, prompt: mine ? translator.prompt(redact(asked, seats)) : null, waiting: asked !== null && !mine ? asked.player : null, retry: false });
		rows = [];
	}
	return steps;
}

function client(session, seats, { answers = true, answer = (_frame, recorded) => recorded } = {}) {
	const { port1, port2 } = new MessageChannel();
	const outlet = session.attach({ seats, send: (frame) => port1.postMessage(frame) });
	port1.on('message', (frame) => outlet.receive(frame));
	const frames = [];
	const steps = [];
	let decision = 0;
	let resolveEnd;
	const ended = new Promise((resolve) => {
		resolveEnd = resolve;
	});
	port2.on('message', (frame) => {
		frames.push(frame);
		if (frame.type === 'step') {
			const { type: _type, ...step } = frame;
			steps.push(step);
			if (frame.prompt === null && frame.waiting === null) return;
			const index = frame.retry ? decision - 1 : decision++;
			if (answers && frame.prompt !== null) {
				const reply = answer(frame, direct.replies[index]);
				if (reply !== undefined) port2.postMessage({ type: 'answer', kind: frame.prompt.kind, reply });
			}
		}
		if (frame.type === 'end') resolveEnd(frame);
	});
	return {
		frames,
		steps,
		ended,
		send: (frame) => port2.postMessage(frame),
		close: () => {
			port1.close();
			port2.close();
		},
	};
}

const OPEN = { type: 'open', protocol: PROTOCOL, seed: SEED.map(String), decks: DECKS };
const rowsOf = (steps) => steps.flatMap((step) => step.rows);

{
	const session = createSession({ instantiate: browser, cardReader, scriptReader: () => null });
	const solo = client(session, [0, 1]);
	solo.send(OPEN);
	const end = await solo.ended;
	assert.equal(end.reason, 'win');
	assert.equal(end.decisions, direct.decisions);
	assert.deepEqual(Object.keys(end.win).sort(), ['player', 'reason'], "the win names a seat and the core's reason, not a message");
	assert.deepEqual(solo.frames[0], { type: 'opened', protocol: PROTOCOL, clock: clockFromSeed(SEED), seats: [0, 1] });
	assert.ok(solo.frames.every((frame) => !('messages' in frame)), "no frame carries the core's messages");
	assert.equal(stringify(solo.steps), stringify(viewOf([0, 1])), 'the frames carry the duel as rows and prompts');
	assert.equal(solo.steps[0].rows[0].t, TAG.SETUP, 'the first step opens with the deal');
	assert.ok(rowsOf(solo.steps).some((row) => row.t === TAG.STATS), "the field's numbers reach the outlet as rows");
	assert.ok(solo.steps.every((step) => step.waiting === null && step.retry === false), 'a solo step is never waiting on anyone');
	assert.equal(solo.steps.filter((step) => step.prompt !== null).length, direct.decisions, 'one prompt per decision');
	assert.equal(solo.frames.at(-1).type, 'end');

	const field = session.query({ field: true }, [0, 1]);
	assert.equal(field.players.length, 2);
	const grave = session.query({ location: { controller: 0, location: LOCATION.GRAVE, flags: QUERY.CODE | QUERY.POSITION } }, [0, 1]);
	assert.ok(grave.length > 0 && grave.every((card) => card.code > 0), 'the grave answers its codes');
	assert.equal(session.query({ card: { controller: 0, location: LOCATION.GRAVE, sequence: 0, flags: QUERY.CODE } }, [0, 1]).code, grave[0].code, 'one card, by its place');

	solo.send(OPEN);
	solo.send({ type: 'answer', kind: MSG.SELECT_IDLECMD, reply: { shape: SHAPE.ONE_OF, member: 0 } });
	await until(solo.frames, (frame) => frame.type === 'error' && frame.refused === 'answer');
	assert.match(solo.frames.find((frame) => frame.type === 'error' && frame.refused === 'open').message, /already has a duel/);
	assert.match(solo.frames.find((frame) => frame.type === 'error' && frame.refused === 'answer').message, /no prompt/);
	assert.throws(() => session.attach({ seats: [], send() {} }), /has ended/);
	session.close();
	assert.throws(() => session.query({ field: true }, [0, 1]), /no duel is open/, 'a closed session has nothing to ask');
	solo.close();
	console.log(`solo      ok  ${solo.steps.length} steps, ${rowsOf(solo.steps).length} rows, ${direct.decisions} decisions`);
}

{
	const session = createSession({ instantiate: browser, cardReader, scriptReader: () => null });
	const seat0 = client(session, [0]);
	const seat1 = client(session, [1]);
	const gallery = client(session, []);
	await session.open({ ...OPEN, seed: SEED });
	const ends = await Promise.all([seat0.ended, seat1.ended, gallery.ended]);
	assert.ok(ends.every((end) => end.reason === 'win' && end.decisions === direct.decisions), stringify(ends));

	for (const [player, own, other] of [[0, seat0, seat1], [1, seat1, seat0]]) {
		assert.equal(stringify(own.steps), stringify(viewOf([player])), `seat ${player} receives its view`);
		assert.ok(own.steps.every((step) => step.prompt === null || step.prompt.player === player), `seat ${player} is only ever asked as itself`);
		assert.ok(own.steps.every((step) => step.waiting === null || step.waiting === 1 - player), `seat ${player} only ever waits on the other`);
		const asked = own.steps.filter((step) => step.prompt !== null).length;
		const waited = own.steps.filter((step) => step.waiting !== null).length;
		assert.equal(asked + waited, direct.decisions, `every decision reaches seat ${player} as a prompt or a wait`);
		assert.equal(waited, other.steps.filter((step) => step.prompt !== null).length, 'what one seat waits on, the other answers');
		const draws = rowsOf(own.steps).filter((row) => row.t === TAG.MOVE && row.verb === VERB.draw);
		assert.ok(draws.some((row) => row.actor === player) && draws.some((row) => row.actor !== player), 'both seats drew');
		assert.ok(draws.every((row) => row.cards.every((code) => (row.actor === player ? code > 0 : code === 0))), `seat ${player} sees its own draws and nobody else's`);
	}
	assert.equal(stringify(gallery.steps), stringify(viewOf([])), 'the gallery receives its view');
	assert.ok(gallery.steps.every((step) => step.prompt === null), 'the gallery is never asked');
	assert.equal(gallery.steps.filter((step) => step.waiting !== null).length, direct.decisions, 'the gallery waits on every decision');
	const seen = rowsOf(gallery.steps).filter((row) => row.t === TAG.MOVE && row.verb === VERB.draw);
	assert.ok(seen.length > 0 && seen.every((row) => row.cards.every((code) => code === 0)), 'the gallery sees no draw');
	assert.equal(rowsOf(gallery.steps).length, rowsOf(seat0.steps).length, 'every recipient folds the same rows, binding differently');

	const field = session.query({ field: true }, []);
	const holder = field.players.findIndex((player) => player.hand > 0);
	assert.notEqual(holder, -1, 'somebody still holds a hand');
	const hand = { controller: holder, location: LOCATION.HAND, flags: QUERY.CODE | QUERY.POSITION };
	const galleryHand = session.query({ location: hand }, []);
	const ownHand = session.query({ location: hand }, [holder]);
	assert.ok(galleryHand.length > 0 && galleryHand.every((card) => card.code === undefined && card.position !== undefined), 'the gallery gets positions, not codes');
	assert.ok(ownHand.every((card) => card.code > 0), 'the holder gets the codes');
	session.close();
	for (const one of [seat0, seat1, gallery]) one.close();
	console.log(`match     ok  ${gallery.steps.length} steps to the gallery, ${direct.decisions} decisions split ${seat0.steps.filter((step) => step.prompt).length}/${seat1.steps.filter((step) => step.prompt).length}`);
}

{
	const session = createSession({ instantiate: browser, cardReader, scriptReader: () => null });
	let sabotaged = null;
	const solo = client(session, [0, 1], {
		answer: (frame, recorded) => {
			if (frame.prompt.family !== 'cards' || sabotaged !== null) return recorded;
			sabotaged = frame.prompt;
			return { shape: SHAPE.SUBSET, members: [] };
		},
	});
	solo.send(OPEN);
	const end = await solo.ended;
	assert.equal(end.reason, 'win');
	assert.equal(end.decisions, direct.decisions, 'a refused answer is not a decision');
	const retried = solo.steps.filter((step) => step.retry);
	assert.equal(retried.length, 1, 'one retry');
	assert.ok(sabotaged !== null && sabotaged.min === 1);
	assert.deepEqual(retried[0], { rows: [], prompt: sabotaged, waiting: null, retry: true }, 'the same prompt again, the same members');
	assert.equal(stringify(solo.steps.filter((step) => !step.retry)), stringify(viewOf([0, 1])), 'the duel is the same duel');
	session.close();
	solo.close();
	console.log('retry     ok');
}

{
	const session = createSession({ instantiate: browser, cardReader, scriptReader: () => null });
	const seat0 = client(session, [0], { answers: false });
	const seat1 = client(session, [1], { answers: false });
	const gallery = client(session, [], { answers: false });
	await session.open({ ...OPEN, seed: SEED });
	await until(seat0.frames, (frame) => frame.type === 'step');
	const first = seat0.frames.find((frame) => frame.type === 'step');
	assert.equal(first.prompt?.player, 0, 'player 0 is asked first');
	assert.equal(first.prompt.family, 'idle');
	const errors = (one) => one.frames.filter((frame) => frame.type === 'error');
	const reply = direct.replies[0];

	seat1.send({ type: 'answer', kind: first.prompt.kind, reply });
	seat0.send({ type: 'answer', kind: MSG.SELECT_YESNO, reply });
	seat0.send({ type: 'answer', kind: first.prompt.kind, reply: { shape: SHAPE.SUBSET, members: [0] } });
	seat0.send({ type: 'answer', kind: first.prompt.kind, reply: { shape: SHAPE.ONE_OF, member: first.prompt.members.length } });
	seat0.send({ type: 'answer', kind: first.prompt.kind, reply: { shape: SHAPE.TERMINAL, outcome: 1 } });
	seat0.send({ type: 'answer', kind: first.prompt.kind, reply: 7 });
	gallery.send(OPEN);
	seat0.send({ type: 'query', id: 1, field: true });
	seat0.send({ type: 'nonsense' });
	seat0.send(42);
	await until(seat0.frames, (frame) => frame.type === 'error' && frame.refused === null);
	await until(seat1.frames, (frame) => frame.type === 'error');
	await until(gallery.frames, (frame) => frame.type === 'error');
	assert.match(errors(seat1)[0].message, /player 0's to answer/);
	assert.equal(errors(seat1).length, 1);
	assert.match(errors(gallery)[0].message, /both seats may open/);
	const refused = errors(seat0).map((error) => [error.refused, error.message]);
	assert.deepEqual(
		refused.map(([type]) => type),
		['answer', 'answer', 'answer', 'answer', 'answer', 'query', 'nonsense', null],
	);
	assert.match(refused[0][1], /the pending prompt is kind/);
	assert.match(refused[1][1], /takes shape 1, not 2/);
	assert.match(refused[2][1], /no member \d+ of \d+/);
	assert.match(refused[3][1], /cannot be walked away from/);
	assert.match(refused[4][1], /reply: a shape/);
	assert.match(refused[5][1], /unknown frame "query"/, 'no outlet asks the core');
	assert.match(refused[6][1], /unknown frame "nonsense"/);
	assert.match(refused[7][1], /unknown frame 42/);
	assert.ok(seat0.frames.filter((frame) => frame.type === 'step').length === 1, 'a refused answer does not step the duel');
	assert.throws(() => session.attach({ seats: [], send() {} }), /before it opens/);
	assert.throws(() => session.query({}, [0]), /one of field, location, card/);
	assert.throws(() => session.query({ field: true }, [0, 0]), /distinct subset/);

	const fresh = createSession({ instantiate: browser, cardReader, scriptReader: () => null });
	const solo = client(fresh, [0, 1], { answers: false });
	solo.send({ ...OPEN, protocol: 1 });
	solo.send({ ...OPEN, decks: [DECKS[0]] });
	solo.send({ ...OPEN, decks: [DECKS[0], { main: [1, 'two'], extra: [] }] });
	await until(solo.frames, (frame) => frame.type === 'error' && /positive integers/.test(frame.message));
	assert.deepEqual(errors(solo).map((error) => error.message.split(' ').slice(0, 2).join(' ')), ['protocol 1', 'decks: one', 'a deck']);
	fresh.close();
	solo.close();

	session.close();
	const closed = await Promise.all([seat0.ended, seat1.ended, gallery.ended]);
	assert.ok(closed.every((end) => end.reason === 'closed' && end.decisions === 0));
	session.close();
	assert.equal(seat0.frames.filter((frame) => frame.type === 'end').length, 1);
	for (const one of [seat0, seat1, gallery]) one.close();
	console.log('refusals  ok');
}

const FUSION = 90;
const fusionReader = (code) =>
	code === FUSION ? { code, alias: 0, setcodes: [], type: TYPE.MONSTER | TYPE.FUSION, level: 6, attribute: ATTRIBUTE.DARK, race: RACE.FIEND, attack: 2400, defense: 2000 } : cardReader(code);

function passOn(prompt) {
	if (prompt.members.length === 0) return { shape: SHAPE.TERMINAL, outcome: OUTCOME.EMPTY };
	if (prompt.family === 'chain') return { shape: SHAPE.TERMINAL, outcome: OUTCOME.DECLINE };
	const ending = prompt.members.findIndex((member) => member.verb === VERB.phase && member.description === PACK_PHASE.EP);
	if (ending !== -1) return { shape: SHAPE.ONE_OF, member: ending };
	if (prompt.shape === SHAPE.SUBSET) return { shape: SHAPE.SUBSET, members: Array.from({ length: prompt.min }, (_, index) => index) };
	return { shape: SHAPE.ONE_OF, member: 0 };
}

async function conjured(script) {
	const session = createSession({ instantiate: browser, cardReader: fusionReader, scriptReader: () => null });
	const solo = client(session, [0, 1], { answers: false });
	const settled = async (count) => {
		await until(solo.frames, () => solo.steps.length >= count || solo.frames.some((frame) => frame.type === 'end'));
		return solo.steps.at(-1);
	};
	solo.send(OPEN);
	await script(solo, settled);
	const field = session.query({ location: { controller: 0, location: LOCATION.MZONE, flags: QUERY.CODE | QUERY.POSITION } }, [0, 1]);
	session.close();
	solo.close();
	return { frames: solo.frames, steps: solo.steps, field };
}

{
	const HAND = seatZone(0, ZONE.HAND);
	const play = async (solo, settled) => {
		const first = await settled(1);
		assert.equal(first.prompt.family, 'idle', 'the duel opens on the first idle command');
		solo.send({ type: 'create', seat: 0, code: 41, zone: HAND, flags: 0 });
		const made = await settled(2);
		assert.deepEqual(made.rows[0], { t: TAG.CREATE, actor: 0, cards: [41], to: zoneRef(HAND), flags: 0, verb: VERB.create, reason: 0 }, 'the card is made as a row');
		assert.equal(made.prompt.family, 'idle', 'the waiting prompt is asked again');
		const summons = (prompt) => prompt.members.filter((member) => member.verb === VERB.normalSummon);
		const fresh = summons(made.prompt).find((member) => !summons(first.prompt).some((old) => old.subject.inst === member.subject.inst));
		assert.ok(fresh !== undefined && fresh.code === 41, 'and offers the card made at once');
		solo.send({ type: 'answer', kind: made.prompt.kind, reply: { shape: SHAPE.ONE_OF, member: made.prompt.members.indexOf(fresh) } });
		for (let count = 3; ; count++) {
			const step = await settled(count);
			const moved = step.rows.find((row) => row.t === TAG.MOVE && row.insts?.[0] === fresh.subject.inst);
			if (moved !== undefined) {
				assert.equal(moved.verb, VERB.normalSummon, 'the card made is Normal Summoned');
				return;
			}
			solo.send({ type: 'answer', kind: step.prompt.kind, reply: passOn(step.prompt) });
		}
	};
	const live = await conjured(play);
	const again = await conjured(play);
	assert.equal(stringify(again.steps), stringify(live.steps), 'a card made is made the same way every time');
	assert.ok(live.field.some((card) => card?.code === 41), 'the core holds the card made where the rows say');

	const DECK = seatZone(1, ZONE.DECK);
	const drawn = await conjured(async (solo, settled) => {
		await settled(1);
		solo.send({ type: 'create', seat: 1, code: 7, zone: DECK, flags: 0 });
		let step = await settled(2);
		assert.equal(step.rows[0].t, TAG.CREATE);
		for (let count = 3; count < 40; count++) {
			solo.send({ type: 'answer', kind: step.prompt.kind, reply: passOn(step.prompt) });
			step = await settled(count);
			const draw = step.rows.find((row) => row.t === TAG.MOVE && row.verb === VERB.draw && row.actor === 1);
			if (draw !== undefined) {
				assert.deepEqual(draw.cards, [7], 'a card made on top of a Deck is its next draw');
				return;
			}
		}
		assert.fail('seat 1 never drew');
	});
	assert.ok(drawn.steps.length > 2);

	const bottom = await conjured(async (solo, settled) => {
		await settled(1);
		solo.send({ type: 'create', seat: 0, code: 9, zone: seatZone(0, ZONE.DECK), flags: FLAG.AT_BOTTOM });
		const made = await settled(2);
		assert.equal(made.rows[0].flags, FLAG.AT_BOTTOM, 'a card made under a Deck says so');
		solo.send({ type: 'create', seat: 0, code: FUSION, zone: seatZone(0, ZONE.EXTRA), flags: FLAG.FACE_PRESENT });
		const extra = await settled(3);
		assert.deepEqual(extra.rows[0], { t: TAG.CREATE, actor: 0, cards: [FUSION], to: zoneRef(seatZone(0, ZONE.EXTRA)), flags: FLAG.FACE_PRESENT, verb: VERB.create, reason: 0 });
		solo.send({ type: 'create', seat: 1, code: 12, zone: EMZ[0], flags: FLAG.FACE_PRESENT | FLAG.FACE_UP | FLAG.POSITION_PRESENT });
		const shared = await settled(4);
		assert.equal(shared.rows[0].to, zoneRef(EMZ[0]), 'a shared zone is made in from the seat that makes it');
		assert.equal(shared.rows[0].actor, 1);
	});
	assert.ok(bottom.steps.every((step) => step.prompt?.family === 'idle'));

	const refused = await conjured(async (solo, settled) => {
		const first = await settled(1);
		const reasons = [];
		for (const frame of [
			{ type: 'create', seat: 2, code: 41, zone: HAND, flags: 0 },
			{ type: 'create', seat: 0, code: 999, zone: HAND, flags: 0 },
			{ type: 'create', seat: 0, code: 41, zone: 99, flags: 0 },
			{ type: 'create', seat: 0, code: FUSION, zone: HAND, flags: 0 },
			{ type: 'create', seat: 0, code: 41, zone: seatZone(0, ZONE.EXTRA), flags: FLAG.FACE_PRESENT },
			{ type: 'create', seat: 0, code: 41, zone: seatZone(0, ZONE.MZ[2]), flags: 'up' },
		]) {
			solo.send(frame);
			await until(solo.frames, () => solo.frames.filter((one) => one.type === 'error').length > reasons.length);
			reasons.push(solo.frames.filter((one) => one.type === 'error').at(-1));
		}
		assert.ok(reasons.every((error) => error.refused === 'create'));
		assert.deepEqual(
			reasons.map((error) => error.message.split(' ').slice(0, 2).join(' ')),
			['seat: 0', 'no card', 'no zone', 'an Extra', 'the Extra', 'flags: the'],
		);
		solo.send({ type: 'create', seat: 0, code: 41, zone: seatZone(0, ZONE.MZ[2]), flags: FLAG.FACE_PRESENT | FLAG.FACE_UP | FLAG.POSITION_PRESENT });
		await settled(2);
		solo.send({ type: 'create', seat: 0, code: 42, zone: seatZone(0, ZONE.MZ[2]), flags: FLAG.FACE_PRESENT | FLAG.FACE_UP | FLAG.POSITION_PRESENT });
		await until(solo.frames, () => solo.frames.filter((one) => one.type === 'error').length > reasons.length);
		assert.match(solo.frames.filter((one) => one.type === 'error').at(-1).message, /is not free/);
		assert.equal(solo.steps.length, 2, 'a refused card makes nothing and asks nothing again');
		assert.equal(first.prompt.family, 'idle');
	});
	assert.ok(refused.field.some((card) => card?.code === 41));

	const session = createSession({ instantiate: browser, cardReader, scriptReader: () => null });
	const seat0 = client(session, [0], { answers: false });
	await session.open({ ...OPEN, seed: SEED });
	await until(seat0.frames, (frame) => frame.type === 'step');
	seat0.send({ type: 'create', seat: 0, code: 41, zone: HAND, flags: 0 });
	await until(seat0.frames, (frame) => frame.type === 'error');
	assert.match(seat0.frames.find((frame) => frame.type === 'error').message, /both seats may make a card/);
	session.close();
	seat0.close();
	console.log(`conjure   ok  ${live.steps.length} steps to a Normal Summon of a card made`);
}
