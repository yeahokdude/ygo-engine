import { DUEL, DUEL_STATUS, advance, clockFromSeed, createEngine, createTranslator, loadDecks, pollField, redact, redactQuery, responseFor } from '../driver/index.mjs';

export const PROTOCOL = 3;

const TEAM = { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 };

const holds = (seats, player) => seats.includes(player);
const isSeat = (value) => value === 0 || value === 1;
const validSeats = (seats) => Array.isArray(seats) && seats.every(isSeat) && new Set(seats).size === seats.length;
const codes = (list) => Array.isArray(list) && list.every((code) => Number.isInteger(code) && code > 0);
const filtered = (messages, seats) => messages.map((message) => redact(message, seats)).filter((message) => message !== null);

export function createSession({ instantiate, cardReader, scriptReader, prelude = [], log = () => {} }) {
	const outlets = new Set();
	let engine = null;
	let duel = null;
	let opening = false;
	let pending = null;
	let decisions = 0;
	let ended = false;

	const broadcast = (frame) => {
		for (const outlet of [...outlets]) outlet.send(frame);
	};
	const end = (frame) => {
		if (ended) return;
		ended = true;
		pending = null;
		broadcast({ type: 'end', decisions, ...frame });
	};

	const deliver = (messages, prompt, retry) => {
		const frames = [];
		const field = pollField(duel);
		for (const outlet of [...outlets]) {
			const { seats, translator } = outlet;
			const mine = prompt !== null && holds(seats, prompt.player);
			const rows = outlet.lead.concat(translator.translate(filtered(messages, seats)), translator.stats(field));
			outlet.lead = [];
			if (!retry) outlet.prompt = mine ? translator.prompt(redact(prompt, seats)) : null;
			frames.push([outlet, { type: 'step', rows, prompt: mine ? outlet.prompt : null, waiting: prompt !== null && !mine ? prompt.player : null, retry }]);
		}
		for (const [outlet, frame] of frames) outlet.send(frame);
	};

	const step = (answered = false) => {
		const messages = [];
		let outcome;
		try {
			for (;;) {
				const batch = advance(duel);
				messages.push(...batch.messages);
				if (batch.win) {
					outcome = { reason: 'win', win: { player: batch.win.player, reason: batch.win.reason } };
					break;
				}
				if (batch.status === DUEL_STATUS.END) {
					outcome = { reason: 'end' };
					break;
				}
				if (batch.status === DUEL_STATUS.CONTINUE) continue;
				if (batch.retry) {
					deliver(messages, pending, true);
					return;
				}
				if (!batch.prompt) throw new Error('the core is waiting on nothing');
				if (answered) decisions++;
				pending = batch.prompt;
				deliver(messages, pending, false);
				return;
			}
			if (answered) decisions++;
			pending = null;
			deliver(messages, null, false);
		} catch (error) {
			end({ reason: 'error', message: String(error?.message ?? error) });
			return;
		}
		end(outcome);
	};

	const start = async (spec) => {
		const seed = spec.seed.map((word) => BigInt(word));
		const clock = clockFromSeed(seed);
		const teams = [{ ...TEAM, ...spec.teams?.[0] }, { ...TEAM, ...spec.teams?.[1] }];
		engine = await createEngine(instantiate, { log: (entry) => broadcast({ type: 'log', entry }) });
		duel = engine.createDuel({
			seed,
			flags: spec.flags === undefined ? DUEL.MODE_MR5 : BigInt(spec.flags),
			team1: teams[0],
			team2: teams[1],
			cardReader,
			scriptReader,
			clock,
			log: (entry) => {
				log(entry);
				broadcast({ type: 'log', entry });
			},
		});
		for (const name of prelude) {
			const source = scriptReader(name);
			if (source === null || !duel.loadScript(name, source)) throw new Error(`prelude script refused: ${name}`);
		}
		const orders = loadDecks(duel, spec.decks, { seed, shuffle: spec.shuffle !== false });
		duel.start();
		const startingLP = teams.map((team) => team.startingLP);
		for (const outlet of outlets) {
			outlet.translator = createTranslator({ seats: outlet.seats, startingLP });
			outlet.lead = outlet.translator.open(orders);
		}
		for (const outlet of [...outlets]) outlet.send({ type: 'opened', protocol: PROTOCOL, clock, seats: outlet.seats });
		step();
	};

	const malformed = (spec) => {
		if (spec?.protocol !== PROTOCOL) return `protocol ${spec?.protocol} is not ${PROTOCOL}`;
		if (!Array.isArray(spec.seed) || spec.seed.length !== 4) return 'seed: four 64-bit words';
		if (!Array.isArray(spec.decks) || spec.decks.length !== 2) return 'decks: one per seat';
		for (const deck of spec.decks) {
			if (!codes(deck?.main) || !codes(deck?.extra ?? [])) return 'a deck is { main: code[], extra: code[] } of positive integers';
		}
		return null;
	};

	const session = {
		async open(spec) {
			const reason = malformed(spec);
			if (reason !== null) throw new TypeError(reason);
			if (duel !== null || opening) throw new Error('this session already has a duel');
			if (ended) throw new Error('this session has ended');
			opening = true;
			try {
				await start(spec);
			} catch (error) {
				end({ reason: 'error', message: String(error?.message ?? error) });
			} finally {
				opening = false;
			}
		},

		attach({ seats, send }) {
			if (!validSeats(seats)) throw new TypeError('seats: a distinct subset of [0, 1]');
			if (ended) throw new Error('this session has ended');
			if (duel !== null || opening) throw new Error('the duel is open: an outlet attaches before it opens');
			const outlet = { seats: [...seats], send, translator: null, lead: [], prompt: null };
			outlets.add(outlet);
			const refuse = (frame, message) => send({ type: 'error', message, refused: frame?.type ?? null });
			return {
				receive(frame) {
					switch (frame?.type) {
						case 'open': {
							if (outlet.seats.length !== 2) return refuse(frame, 'only an outlet holding both seats may open a duel');
							if (duel !== null || opening) return refuse(frame, 'this session already has a duel');
							if (ended) return refuse(frame, 'this session has ended');
							const reason = malformed(frame);
							if (reason !== null) return refuse(frame, reason);
							return session.open(frame);
						}
						case 'answer': {
							if (pending === null) return refuse(frame, 'no prompt is pending');
							if (!holds(outlet.seats, pending.player)) return refuse(frame, `the prompt is player ${pending.player}'s to answer`);
							if (frame.kind !== pending.kind) return refuse(frame, `the pending prompt is kind ${pending.kind}, not ${frame.kind}`);
							if (typeof frame.reply?.shape !== 'number') return refuse(frame, 'reply: a shape over member indices');
							try {
								duel.respond(pending.kind, responseFor(outlet.prompt, frame.reply));
							} catch (error) {
								return refuse(frame, String(error?.message ?? error));
							}
							return step(true);
						}
						default:
							return refuse(frame, `unknown frame ${JSON.stringify(frame?.type ?? frame)}`);
					}
				},
				detach() {
					outlets.delete(outlet);
				},
			};
		},

		query(ask, seats) {
			if (!validSeats(seats)) throw new TypeError('seats: a distinct subset of [0, 1]');
			if (duel === null) throw new Error('no duel is open');
			if (ask?.field === true) return duel.queryField();
			if (ask?.location) return duel.queryLocation(ask.location).map((card) => redactQuery(card, ask.location.controller, seats));
			if (ask?.card) return redactQuery(duel.query(ask.card), ask.card.controller, seats);
			throw new TypeError('query: one of field, location, card');
		},

		close() {
			end({ reason: 'closed' });
			duel?.destroy();
			duel = null;
			engine = null;
			outlets.clear();
		},
	};
	return session;
}
