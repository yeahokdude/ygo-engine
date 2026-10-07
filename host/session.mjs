import { DUEL, DUEL_STATUS, MSG, advance, clockFromSeed, createEngine, createTranslator, encodeResponse, loadDecks, pollField, redact, redactQuery, responseFor } from '../driver/index.mjs';
import { conjure, conjureError } from '../driver/conjure.mjs';

export const PROTOCOL = 5;

const TEAM = { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 };

const holds = (seats, player) => seats.includes(player);
const isSeat = (value) => value === 0 || value === 1;
const validSeats = (seats) => Array.isArray(seats) && seats.every(isSeat) && new Set(seats).size === seats.length;
const codes = (list) => Array.isArray(list) && list.every((code) => Number.isInteger(code) && code > 0);
const filtered = (messages, seats) => messages.map((message) => redact(message, seats)).filter((message) => message !== null);

const PROCESS = 'process';
const POLL = 'poll';

export function createSession({ instantiate, cardReader, scriptReader, prelude = [], log = () => {} }) {
	const outlets = new Set();
	let engine = null;
	let duel = null;
	let opening = false;
	let pending = null;
	let decisions = 0;
	let ended = false;
	let deal = null;
	let calls = [];
	let asked = 0;
	let field = null;
	let disabled = 0;
	let quiet = false;

	const broadcast = (frame) => {
		for (const outlet of [...outlets]) outlet.send(frame);
	};
	const end = (frame) => {
		if (ended) return;
		ended = true;
		pending = null;
		broadcast({ type: 'end', decisions, ...frame });
	};

	const poll = () => {
		calls.push(POLL);
		field = pollField(duel);
		return field;
	};

	const deliver = (messages, prompt, retry) => {
		const frames = [];
		const polled = poll();
		for (const outlet of [...outlets]) {
			const { seats, translator } = outlet;
			const mine = prompt !== null && holds(seats, prompt.player);
			const rows = outlet.lead.concat(translator.translate(filtered(messages, seats)), translator.stats(polled));
			outlet.lead = [];
			if (!retry) outlet.prompt = mine ? translator.prompt(redact(prompt, seats)) : null;
			frames.push([outlet, { type: 'step', rows, prompt: mine ? outlet.prompt : null, waiting: prompt !== null && !mine ? prompt.player : null, retry }]);
		}
		for (const [outlet, frame] of frames) outlet.send(frame);
	};

	const step = (answered = false, made = []) => {
		const messages = [...made];
		let outcome;
		try {
			for (;;) {
				const at = calls.length;
				calls.push(PROCESS);
				const batch = advance(duel);
				messages.push(...batch.messages);
				for (const message of batch.messages) if (message.kind === MSG.FIELD_DISABLED) disabled = message.mask;
				if (batch.win && !deal.handTest) {
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
				asked = at;
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

	const dealt = async () => {
		const fresh = await createEngine(instantiate, {
			log: (entry) => {
				if (!quiet) broadcast({ type: 'log', entry });
			},
		});
		const made = fresh.createDuel({
			...deal.duel,
			log: (entry) => {
				if (quiet) return;
				log(entry);
				broadcast({ type: 'log', entry });
			},
		});
		for (const name of prelude) {
			const source = scriptReader(name);
			if (source === null || !made.loadScript(name, source)) throw new Error(`prelude script refused: ${name}`);
		}
		const orders = loadDecks(made, deal.decks, { seed: deal.duel.seed, shuffle: deal.shuffle });
		made.start();
		return { fresh, made, orders };
	};

	const start = async (spec) => {
		const seed = spec.seed.map((word) => BigInt(word));
		const teams = [{ ...TEAM, ...spec.teams?.[0] }, { ...TEAM, ...spec.teams?.[1] }];
		const handTest = spec.handTest === true;
		const mode = spec.flags === undefined ? DUEL.MODE_MR5 : BigInt(spec.flags);
		const flags = handTest ? mode | DUEL.ATTACK_FIRST_TURN : mode;
		deal = { duel: { seed, flags, team1: teams[0], team2: teams[1], cardReader, scriptReader, clock: clockFromSeed(seed) }, decks: spec.decks, shuffle: spec.shuffle !== false, handTest };
		const { fresh, made, orders } = await dealt();
		engine = fresh;
		duel = made;
		const startingLP = teams.map((team) => team.startingLP);
		for (const outlet of outlets) {
			outlet.translator = createTranslator({ seats: outlet.seats, startingLP });
			outlet.lead = outlet.translator.open(orders);
		}
		for (const outlet of [...outlets]) outlet.send({ type: 'opened', protocol: PROTOCOL, clock: deal.duel.clock, seats: outlet.seats });
		step();
	};

	const repeat = (target, call) => {
		if (call === PROCESS) advance(target);
		else if (call === POLL) pollField(target);
		else if (call.respond) target.respondBytes(call.respond);
		else if (call.query) ask(target, call.query, call.seats);
		else conjure(target, call.made, cardReader(call.made.code), deal.duel.flags);
	};

	const make = async (made) => {
		const kept = calls.slice(0, asked);
		const row = cardReader(made.code);
		pending = null;
		quiet = true;
		try {
			const { fresh, made: rebuilt } = await dealt();
			for (const call of kept) repeat(rebuilt, call);
			duel.destroy();
			engine = fresh;
			duel = rebuilt;
			calls = kept;
			calls.push({ made });
			const move = conjure(duel, made, row, deal.duel.flags);
			quiet = false;
			for (const outlet of outlets) outlet.translator.again();
			step(false, [move]);
		} catch (error) {
			quiet = false;
			end({ reason: 'error', message: String(error?.message ?? error) });
		}
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
							let bytes;
							try {
								bytes = encodeResponse(pending.kind, responseFor(outlet.prompt, frame.reply));
							} catch (error) {
								return refuse(frame, String(error?.message ?? error));
							}
							duel.respondBytes(bytes);
							calls.push({ respond: bytes });
							return step(true);
						}
						case 'create': {
							if (outlet.seats.length !== 2) return refuse(frame, 'only an outlet holding both seats may make a card');
							if (pending === null) return refuse(frame, 'a card is made while a prompt is pending');
							const made = { seat: frame.seat, code: frame.code, zone: frame.zone, flags: frame.flags };
							const reason = conjureError(made, Number.isInteger(made.code) && made.code > 0 ? cardReader(made.code) : null, { field, disabled, duelFlags: deal.duel.flags });
							if (reason !== null) return refuse(frame, reason);
							return make(made);
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

		query(query, seats) {
			if (!validSeats(seats)) throw new TypeError('seats: a distinct subset of [0, 1]');
			if (duel === null) throw new Error('no duel is open');
			const answer = ask(duel, query, seats);
			calls.push({ query, seats: [...seats] });
			return answer;
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

function ask(duel, query, seats) {
	if (query?.field === true) return duel.queryField();
	if (query?.location) return duel.queryLocation(query.location).map((card) => redactQuery(card, query.location.controller, seats));
	if (query?.card) return redactQuery(duel.query(query.card), query.card.controller, seats);
	throw new TypeError('query: one of field, location, card');
}
