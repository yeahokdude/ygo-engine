import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';

import { DUEL, DUEL_STATUS, LOCATION, MSG, QUERY, clockFromSeed, createEngine, createTranslator, loadDecks, play, pollField, redact, replyFor, vocabulary } from '../driver/index.mjs';
import { PROTOCOL, createSession } from '../host/session.mjs';
import { DECKS, SEED, TEAM, bot, browserEntry, cardReader, stringify } from './vanilla.mjs';

const { SHAPE, TAG, VERB } = vocabulary;
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

const direct = await (async () => {
	const engine = await createEngine(browser, { log: () => {} });
	const duel = engine.createDuel({ seed: SEED, flags: DUEL.MODE_MR5, team1: TEAM, team2: TEAM, cardReader, scriptReader: () => null, clock: clockFromSeed(SEED) });
	const orders = loadDecks(duel, DECKS, { seed: SEED });
	duel.start();
	const translator = createTranslator({ seats: [0, 1], startingLP: STARTING_LP });
	translator.open(orders);
	const batches = [];
	const replies = [];
	const fields = [];
	const result = play(
		duel,
		(prompt) => {
			fields.push(pollField(duel));
			const answer = bot(prompt);
			replies.push(replyFor(translator.prompt(redact(prompt, [0, 1])), answer));
			return answer;
		},
		{
			onBatch: (batch) => {
				translator.translate(filtered(batch.messages, [0, 1]));
				batches.push(batch);
			},
		},
	);
	assert.equal(result.reason, 'win');
	fields.push(pollField(duel));
	duel.destroy();
	return { orders, batches, replies, fields, decisions: result.decisions };
})();

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
