import { HINT, LOCATION, MSG, MSG_NAME, POS } from './constants.mjs';
import { declarableCodes } from './declare.mjs';
import { isPrompt } from './messages.mjs';
import { OUTCOME, PACK_PHASE, REGION, SHAPE, VERB } from './vocabulary.mjs';

const IDLE = Object.freeze({ SUMMON: 0, SP_SUMMON: 1, POS_CHANGE: 2, MONSTER_SET: 3, SPELL_SET: 4, ACTIVATE: 5, TO_BP: 6, TO_EP: 7, SHUFFLE: 8 });
const BATTLE = Object.freeze({ CHAIN: 0, BATTLE: 1, TO_M2: 2, TO_EP: 3 });
const command = (action, index) => (index << 16) | action;

const ZONES_PER_SIDE = 16;
const MONSTER_SLOTS = 7;
const SPELL_SLOTS = 6;
const CHAIN_ORDERING = 0x7f;

const DESCRIPTION_SHIFT = 20n;
const DESCRIPTION_MASK = (1n << DESCRIPTION_SHIFT) - 1n;

export function captionOf(description) {
	const value = BigInt(description);
	return { code: Number(value >> DESCRIPTION_SHIFT), index: Number(value & DESCRIPTION_MASK) };
}

const ownCaption = (description) => (BigInt(description) === 0n ? null : captionOf(description));

const fail = (what) => {
	throw new Error(`prompt: ${what}`);
};

const scalar = (value, what) => {
	const number = Number(value);
	if (!Number.isSafeInteger(number)) fail(`${what} ${value} does not fit a number`);
	return number;
};

const seatOf = (player) => ({ kind: 'seat', seat: player });

const POSITIONS = [
	[POS.FACEUP_ATTACK, VERB.specialAtk, REGION.ATK],
	[POS.FACEUP_DEFENSE, VERB.specialDef, REGION.DEF],
	[POS.FACEDOWN_DEFENSE, VERB.setMonster, REGION.SET_DEF],
	[POS.FACEDOWN_ATTACK, VERB.setAttack, null],
];

function bitsOf(mask) {
	const value = BigInt(mask);
	const bits = [];
	for (let bit = 0n; bit < 64n; bit++) {
		if ((value >> bit) & 1n) bits.push(Number(bit));
	}
	return bits;
}

const RULES = {
	[MSG.SELECT_IDLECMD]: (m, resolve) => ({
		family: 'idle',
		shape: SHAPE.ONE_OF,
		members: [
			...m.summonable.map((card, index) => cardMember(resolve, card, VERB.normalSummon, command(IDLE.SUMMON, index))),
			...m.spSummonable.map((card, index) => cardMember(resolve, card, VERB.specialSummon, command(IDLE.SP_SUMMON, index))),
			...m.repositionable.map((card, index) => cardMember(resolve, card, VERB.position, command(IDLE.POS_CHANGE, index))),
			...m.monsterSettable.map((card, index) => cardMember(resolve, card, VERB.setMonster, command(IDLE.MONSTER_SET, index))),
			...m.spellSettable.map((card, index) => cardMember(resolve, card, VERB.setSpellTrap, command(IDLE.SPELL_SET, index))),
			...m.activatable.map((effect, index) => effectMember(resolve, effect, command(IDLE.ACTIVATE, index))),
			...(m.toBp ? [phaseMember(m.player, PACK_PHASE.BP, command(IDLE.TO_BP, 0))] : []),
			...(m.toEp ? [phaseMember(m.player, PACK_PHASE.EP, command(IDLE.TO_EP, 0))] : []),
			...(m.canShuffle ? [{ subject: seatOf(m.player), verb: VERB.shuffleHand, payload: command(IDLE.SHUFFLE, 0) }] : []),
		],
	}),
	[MSG.SELECT_BATTLECMD]: (m, resolve) => ({
		family: 'battle',
		shape: SHAPE.ONE_OF,
		members: [
			...m.activatable.map((effect, index) => effectMember(resolve, effect, command(BATTLE.CHAIN, index))),
			...m.attackable.map((card, index) => cardMember(resolve, card, VERB.attack, command(BATTLE.BATTLE, index), { direct: card.canDirect })),
			...(m.toM2 ? [phaseMember(m.player, PACK_PHASE.M2, command(BATTLE.TO_M2, 0))] : []),
			...(m.toEp ? [phaseMember(m.player, PACK_PHASE.EP, command(BATTLE.TO_EP, 0))] : []),
		],
	}),

	[MSG.SELECT_EFFECTYN]: (m, resolve, hinted) => {
		const subject = { kind: 'instance', inst: handleOf(resolve, m) };
		return {
			family: 'yesno',
			shape: SHAPE.ONE_OF,
			caption: hinted === null ? ownCaption(m.description) : captionOf(hinted),
			members: [
				{ subject, verb: VERB.no, payload: 0, code: m.code },
				{ subject, verb: VERB.yes, payload: 1, code: m.code },
			],
		};
	},
	[MSG.SELECT_YESNO]: (m, _resolve, hinted) => ({
		family: 'yesno',
		shape: SHAPE.ONE_OF,
		caption: hinted === null ? ownCaption(m.description) : captionOf(hinted),
		members: [
			{ subject: seatOf(m.player), verb: VERB.no, payload: 0 },
			{ subject: seatOf(m.player), verb: VERB.yes, payload: 1 },
		],
	}),
	[MSG.SELECT_OPTION]: (m) => ({
		family: 'option',
		shape: SHAPE.ONE_OF,
		members: m.options.map((option, index) => ({ subject: seatOf(m.player), verb: VERB.option, description: index, payload: index, caption: captionOf(option) })),
	}),

	[MSG.SELECT_CARD]: (m, resolve) => ({
		family: 'cards',
		shape: SHAPE.SUBSET,
		min: m.min,
		max: m.max,
		cancelable: m.cancelable,
		members: m.cards.length > 0 && m.cards.every(atNoPlace) ? m.cards.map((card, index) => namedMember(m.player, card, index)) : m.cards.map((card, index) => cardMember(resolve, card, VERB.pick, index)),
	}),
	[MSG.SELECT_UNSELECT_CARD]: (m, resolve) => ({
		family: 'build',
		shape: SHAPE.ONE_OF,
		min: m.min,
		max: m.max,
		cancelable: m.cancelable,
		finishable: m.finishable,
		members: [
			...m.selectable.map((card, index) => cardMember(resolve, card, VERB.pick, index)),
			...m.unselectable.map((card, index) => cardMember(resolve, card, VERB.unpick, m.selectable.length + index)),
		],
	}),
	[MSG.SELECT_TRIBUTE]: (m, resolve) => ({
		family: 'tribute',
		shape: SHAPE.SUBSET,
		min: m.min,
		max: m.max,
		cancelable: m.cancelable,
		members: m.cards.map((card, index) => cardMember(resolve, card, VERB.pick, index, { value: card.releaseParam })),
	}),
	[MSG.SELECT_SUM]: (m, resolve) => ({
		family: 'sum',
		shape: SHAPE.SUBSET,
		min: m.min,
		max: m.max,
		sum: { target: m.sum, overshoot: m.overshoot, must: m.must.map((card) => ({ subject: { kind: 'instance', inst: handleOf(resolve, card) }, code: card.code, range: rangeOf(card.param) })) },
		members: m.cards.map((card, index) => cardMember(resolve, card, VERB.pick, index, { range: rangeOf(card.param) })),
	}),
	[MSG.SELECT_COUNTER]: (m, resolve) => ({
		family: 'counter',
		shape: SHAPE.ALLOCATION,
		total: m.count,
		counterType: m.counterType,
		members: m.cards.map((card, index) => cardMember(resolve, card, VERB.pick, index, { count: card.count })),
	}),

	[MSG.SELECT_PLACE]: (m, resolve, hinted) => ({ ...zonePrompt(m, resolve), code: hinted === null ? 0 : scalar(hinted, 'a card code'), caption: null }),
	[MSG.SELECT_DISFIELD]: (m, resolve) => zonePrompt(m, resolve),
	[MSG.SELECT_POSITION]: (m) => ({
		family: 'position',
		shape: SHAPE.ONE_OF,
		code: m.code,
		members: POSITIONS.filter(([position]) => m.positions & position).map(([position, verb, region]) => ({
			subject: seatOf(m.player),
			verb,
			payload: position,
			...(region === null ? {} : { regions: [region] }),
		})),
	}),

	[MSG.SORT_CARD]: (m, resolve) => ({
		family: 'sort',
		shape: SHAPE.RANKING,
		cancelable: true,
		members: m.cards.map((card, index) => cardMember(resolve, card, VERB.pick, index)),
	}),
	[MSG.SORT_CHAIN]: (m, resolve) => ({
		family: 'sort',
		shape: SHAPE.RANKING,
		cancelable: true,
		members: m.cards.map((card, index) => cardMember(resolve, card, VERB.pick, index)),
	}),

	[MSG.SELECT_CHAIN]: (m, resolve) => ({
		family: 'chain',
		shape: SHAPE.ONE_OF,
		cancelable: !m.forced,
		ordering: m.specialCount === CHAIN_ORDERING,
		useful: m.specialCount > 0,
		timing: m.hintTiming,
		members: m.chains.map((effect, index) => effectMember(resolve, effect, index)),
	}),

	[MSG.ANNOUNCE_RACE]: (m) => announceBits(m),
	[MSG.ANNOUNCE_ATTRIB]: (m) => announceBits(m),
	[MSG.ANNOUNCE_NUMBER]: (m) => ({
		family: 'announce',
		shape: SHAPE.ONE_OF,
		members: m.options.map((option, index) => ({ subject: seatOf(m.player), verb: VERB.declare, description: index, payload: index, value: scalar(option, 'a number option') })),
	}),
	[MSG.ANNOUNCE_CARD]: (m, _resolve, _hinted, pool) => ({
		family: 'announce',
		shape: SHAPE.ONE_OF,
		members: declarableCodes(pool ?? fail('ANNOUNCE_CARD declares from the card table, and this translator holds none'), m.opcodes).map((code) => ({
			subject: seatOf(m.player),
			verb: VERB.declare,
			description: code,
			payload: code,
			code,
		})),
	}),

	[MSG.ROCK_PAPER_SCISSORS]: (m) => ({
		family: 'rps',
		shape: SHAPE.ONE_OF,
		members: [1, 2, 3].map((hand) => ({ subject: seatOf(m.player), verb: VERB.rps, description: hand, payload: hand })),
	}),
};

const atNoPlace = (card) => card.location === 0;

function handleOf(resolve, card) {
	if (atNoPlace(card)) fail('a card at no place, where the prompt names cards by their place');
	return resolve.handle(card);
}

const namedMember = (player, card, index) => ({ subject: seatOf(player), verb: VERB.pick, description: index, payload: index, code: card.code });

function cardMember(resolve, card, verb, payload, extra = {}) {
	return { subject: { kind: 'instance', inst: handleOf(resolve, card) }, verb, payload, code: card.code, ...extra };
}

function effectMember(resolve, effect, payload) {
	return cardMember(resolve, effect, VERB.activate, payload, {
		description: scalar(effect.description, 'a description'),
		...(effect.clientMode ? { clientMode: effect.clientMode } : {}),
		caption: captionOf(effect.description),
	});
}

const phaseMember = (player, phase, payload) => ({ subject: seatOf(player), verb: VERB.phase, description: phase, payload });

const rangeOf = (param) => [param & 0xffff, param >>> 16];

function zonePrompt(m, resolve) {
	const members = [];
	const named = new Set();
	for (let bit = 0; bit < 2 * ZONES_PER_SIDE; bit++) {
		if ((m.mask >>> bit) & 1) continue;
		const player = bit < ZONES_PER_SIDE ? m.player : 1 - m.player;
		const within = bit % ZONES_PER_SIDE;
		const monster = within < 8;
		const sequence = monster ? within : within - 8;
		if (monster ? sequence >= MONSTER_SLOTS : sequence >= SPELL_SLOTS) continue;
		const location = monster ? LOCATION.MZONE : LOCATION.SZONE;
		const zone = resolve.zone(player, location, sequence);
		if (named.has(zone)) continue;
		named.add(zone);
		members.push({ subject: { kind: 'zone', zone }, verb: VERB.place, payload: packPlace(player, location, sequence) });
	}
	return { family: 'zone', shape: SHAPE.SUBSET, min: m.count, max: m.count, members };
}

const packPlace = (player, location, sequence) => (player << 16) | (location << 8) | sequence;
const unpackPlace = (packed) => ({ player: packed >>> 16, location: (packed >>> 8) & 0xff, sequence: packed & 0xff });

function announceBits(m) {
	return {
		family: 'announce',
		shape: SHAPE.SUBSET,
		min: m.count,
		max: m.count,
		members: bitsOf(m.available).map((bit) => ({ subject: seatOf(m.player), verb: VERB.declare, description: bit, payload: bit })),
	};
}

const subjectKey = (subject) => (subject.kind === 'instance' ? `i${subject.inst}` : subject.kind === 'zone' ? `z${subject.zone}` : `s${subject.seat}`);
export const memberKey = (member) => `${subjectKey(member.subject)}|${member.verb}|${member.description ?? 0}|${member.clientMode ?? 0}`;

export function translatePrompt(message, resolve, hinted = null, pool = null) {
	if (!isPrompt(message.kind)) fail(`${MSG_NAME[message.kind] ?? message.kind} is not a prompt`);
	const rule = RULES[message.kind] ?? fail(`no rule for ${MSG_NAME[message.kind]}`);
	const { members, caption = hinted === null ? null : captionOf(hinted), ...rest } = rule(message, resolve, hinted, pool);
	const keys = new Set();
	for (const member of members) {
		const key = memberKey(member);
		if (keys.has(key)) fail(`${MSG_NAME[message.kind]}: two members key the same: ${key}`);
		keys.add(key);
	}
	return { kind: message.kind, player: message.player, caption, min: 1, max: 1, cancelable: false, finishable: false, ...rest, members };
}

export function captionHint(message) {
	if (message.kind !== MSG.HINT || message.type !== HINT.SELECTMSG) return undefined;
	const value = BigInt(message.description);
	return value === 0n ? null : value;
}

const memberAt = (prompt, index) => {
	if (!Number.isInteger(index) || index < 0 || index >= prompt.members.length) fail(`no member ${index} of ${prompt.members.length}`);
	return prompt.members[index];
};

function oneOfResponse(prompt, payload) {
	switch (prompt.kind) {
		case MSG.SELECT_IDLECMD:
		case MSG.SELECT_BATTLECMD:
			return { action: payload & 0xffff, index: payload >>> 16 };
		case MSG.SELECT_EFFECTYN:
		case MSG.SELECT_YESNO:
			return payload === 1;
		default:
			return payload;
	}
}

function subsetResponse(prompt, payloads) {
	switch (prompt.kind) {
		case MSG.SELECT_PLACE:
		case MSG.SELECT_DISFIELD:
			return payloads.map(unpackPlace);
		case MSG.ANNOUNCE_RACE:
			return payloads.reduce((mask, bit) => mask | (1n << BigInt(bit)), 0n);
		case MSG.ANNOUNCE_ATTRIB:
			return payloads.reduce((mask, bit) => mask | (1 << bit), 0);
		default:
			return payloads;
	}
}

function terminalResponse(prompt, outcome) {
	switch (outcome) {
		case OUTCOME.EMPTY:
			if (prompt.members.length) fail(`EMPTY answers a prompt with nothing to pick, this one offers ${prompt.members.length}`);
			break;
		case OUTCOME.CANCEL:
		case OUTCOME.DECLINE:
			if (!prompt.cancelable) fail(`this ${prompt.family} prompt cannot be walked away from`);
			break;
		case OUTCOME.FINISH:
			if (!prompt.finishable) fail(`this ${prompt.family} prompt cannot be finished early`);
			break;
		default:
			fail(`no such outcome ${outcome}`);
	}
	return null;
}

export function responseFor(prompt, reply) {
	if (reply.shape === SHAPE.TERMINAL) return terminalResponse(prompt, reply.outcome);
	if (reply.shape !== prompt.shape) fail(`a ${prompt.family} prompt takes shape ${prompt.shape}, not ${reply.shape}`);
	switch (reply.shape) {
		case SHAPE.ONE_OF:
			return oneOfResponse(prompt, memberAt(prompt, reply.member).payload);
		case SHAPE.SUBSET: {
			if (new Set(reply.members).size !== reply.members.length) fail('a member is picked twice');
			return subsetResponse(prompt, reply.members.map((index) => memberAt(prompt, index).payload));
		}
		case SHAPE.ALLOCATION: {
			const counts = prompt.members.map(() => 0);
			for (const { member, amount } of reply.allocation) counts[memberAt(prompt, member).payload] = amount;
			return counts;
		}
		case SHAPE.RANKING:
			if (reply.order.length !== prompt.members.length) fail(`an order ranks all ${prompt.members.length} members, not ${reply.order.length}`);
			return [...reply.order];
		default:
			return fail(`no such shape ${reply.shape}`);
	}
}

function outcomeOfNull(prompt) {
	if (prompt.members.length === 0) return OUTCOME.EMPTY;
	switch (prompt.kind) {
		case MSG.SELECT_CHAIN:
		case MSG.SORT_CARD:
		case MSG.SORT_CHAIN:
			return OUTCOME.DECLINE;
		case MSG.SELECT_UNSELECT_CARD:
			return prompt.finishable ? OUTCOME.FINISH : OUTCOME.CANCEL;
		default:
			return OUTCOME.CANCEL;
	}
}

const indexOfPayload = (prompt, payload) => {
	const index = prompt.members.findIndex((member) => member.payload === payload);
	if (index === -1) fail(`no member of this ${prompt.family} prompt answers ${JSON.stringify(payload)}`);
	return index;
};

export function replyFor(prompt, response) {
	if (response === null) return { shape: SHAPE.TERMINAL, outcome: outcomeOfNull(prompt) };
	switch (prompt.kind) {
		case MSG.SELECT_IDLECMD:
		case MSG.SELECT_BATTLECMD:
			return { shape: SHAPE.ONE_OF, member: indexOfPayload(prompt, command(response.action, response.index ?? 0)) };
		case MSG.SELECT_EFFECTYN:
		case MSG.SELECT_YESNO:
			return { shape: SHAPE.ONE_OF, member: indexOfPayload(prompt, response ? 1 : 0) };
		case MSG.SELECT_PLACE:
		case MSG.SELECT_DISFIELD:
			return { shape: SHAPE.SUBSET, members: response.map(({ player, location, sequence }) => indexOfPayload(prompt, packPlace(player, location, sequence))) };
		case MSG.ANNOUNCE_RACE:
		case MSG.ANNOUNCE_ATTRIB:
			return { shape: SHAPE.SUBSET, members: bitsOf(response).map((bit) => indexOfPayload(prompt, bit)) };
		case MSG.SELECT_COUNTER:
			return { shape: SHAPE.ALLOCATION, allocation: response.flatMap((amount, index) => (amount ? [{ member: indexOfPayload(prompt, index), amount }] : [])) };
		case MSG.SORT_CARD:
		case MSG.SORT_CHAIN:
			return { shape: SHAPE.RANKING, order: [...response] };
		default:
			if (Array.isArray(response)) return { shape: SHAPE.SUBSET, members: response.map((payload) => indexOfPayload(prompt, payload)) };
			return { shape: SHAPE.ONE_OF, member: indexOfPayload(prompt, response) };
	}
}
