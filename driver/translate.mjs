import { CHINT, HINT, LOCATION, MSG, MSG_NAME, PHASE, PHINT, POS, QUERY, REASON, STATUS } from './constants.mjs';
import { DECODED_KINDS, isPrompt } from './messages.mjs';
import { bitsOf, captionHint, translatePrompt } from './prompts.mjs';
import { redactQuery } from './redact.mjs';
import { AUDIENCE, CHAIN, DECLARATION, EMZ, FLAG, PACK_PHASE, TAG, VERB, ZONE, audienceRef, seatZone, zoneRef, zoneSpec } from './vocabulary.mjs';

const LIST_OF = { [LOCATION.DECK]: 'deck', [LOCATION.HAND]: 'hand', [LOCATION.GRAVE]: 'grave', [LOCATION.REMOVED]: 'removed', [LOCATION.EXTRA]: 'extra' };
const ZONE_OF = { [LOCATION.DECK]: ZONE.DECK, [LOCATION.HAND]: ZONE.HAND, [LOCATION.GRAVE]: ZONE.GY, [LOCATION.REMOVED]: ZONE.BANISH, [LOCATION.EXTRA]: ZONE.EXTRA };
const LOCATIONS = [LOCATION.MZONE, LOCATION.SZONE, LOCATION.DECK, LOCATION.HAND, LOCATION.GRAVE, LOCATION.REMOVED, LOCATION.EXTRA];
const LOCATION_NAME = Object.fromEntries(Object.entries(LOCATION).map(([name, value]) => [value, name]));

const PHASE_OF = {
	[PHASE.DRAW]: PACK_PHASE.DP,
	[PHASE.STANDBY]: PACK_PHASE.SP,
	[PHASE.MAIN1]: PACK_PHASE.M1,
	[PHASE.BATTLE_START]: PACK_PHASE.BP,
	[PHASE.BATTLE_STEP]: PACK_PHASE.BP,
	[PHASE.DAMAGE]: PACK_PHASE.BP,
	[PHASE.DAMAGE_CAL]: PACK_PHASE.BP,
	[PHASE.BATTLE]: PACK_PHASE.BP,
	[PHASE.MAIN2]: PACK_PHASE.M2,
	[PHASE.END]: PACK_PHASE.EP,
};

const DESCRIPTION_SHIFT = 20n;
const DESCRIPTION_MASK = (1n << DESCRIPTION_SHIFT) - 1n;
const textOf = (description) => [Number(description >> DESCRIPTION_SHIFT), Number(description & DESCRIPTION_MASK)];

export function zoneOf(controller, location, sequence) {
	if (location === LOCATION.MZONE) {
		if (sequence < 5) return seatZone(controller, ZONE.MZ[sequence]);
		if (sequence === 5 || sequence === 6) return EMZ[(sequence - 5) ^ controller];
	} else if (location === LOCATION.SZONE) {
		if (sequence < 5) return seatZone(controller, ZONE.ST[sequence]);
		if (sequence === 5) return seatZone(controller, ZONE.FIELD);
	} else if (ZONE_OF[location] !== undefined) {
		return seatZone(controller, ZONE_OF[location]);
	}
	throw new RangeError(`no zone for controller ${controller}, location ${location}, sequence ${sequence}`);
}

function landing(zone, position) {
	const spec = zoneSpec(zone);
	let flags = 0;
	if (spec.face === 'stated') flags |= FLAG.FACE_PRESENT | (position & POS.FACEUP ? FLAG.FACE_UP : 0);
	if (spec.kind === 'field') flags |= FLAG.POSITION_PRESENT | (spec.monster && position & POS.DEFENSE ? FLAG.POSITION_DEF : 0);
	return flags;
}

const DECLARED = {
	[HINT.CODE]: (value) => ({ verb: VERB.declare, cards: [Number(value)] }),
	[HINT.RACE]: (value) => ({ verb: VERB.declareRace, nums: bitsOf(value) }),
	[HINT.ATTRIB]: (value) => ({ verb: VERB.declareAttribute, nums: bitsOf(value) }),
	[HINT.NUMBER]: (value) => ({ verb: VERB.declareNumber, nums: [Number(value)] }),
};

const HELD = {
	[CHINT.TURN]: (value) => ({ nums: value ? [Number(value)] : [] }),
	[CHINT.CARD]: (value) => (value ? { cards: [Number(value)] } : {}),
	[CHINT.RACE]: (value) => ({ nums: bitsOf(value) }),
	[CHINT.ATTRIBUTE]: (value) => ({ nums: bitsOf(value) }),
	[CHINT.NUMBER]: (value) => ({ nums: value ? [Number(value)] : [] }),
};

function hintRow(m) {
	if (m.type === HINT.CARD) return { t: TAG.SHOW, cards: [Number(m.description)] };
	const declared = DECLARED[m.type];
	return declared ? { t: TAG.CHAT, actor: m.player, ...declared(BigInt(m.description)), text: DECLARATION } : null;
}

function moveVerb(from, location, sequence, position, reason) {
	switch (location) {
		case LOCATION.GRAVE:
			return VERB.toGy;
		case LOCATION.REMOVED:
			return position & POS.FACEUP ? VERB.banish : VERB.banishFd;
		case LOCATION.HAND:
			return VERB.toHand;
		case LOCATION.DECK:
			return sequence === 0 ? VERB.toDeckBottom : VERB.toDeckTop;
		case LOCATION.EXTRA:
			return position & POS.FACEUP ? VERB.toExtraFaceUp : VERB.toExtra;
		case LOCATION.MZONE:
			if (position & POS.FACEDOWN) return VERB.setMonster;
			if (reason & REASON.SPSUMMON) return position & POS.DEFENSE ? VERB.specialDef : VERB.specialAtk;
			return reason & REASON.SUMMON || from === LOCATION.HAND ? VERB.normalSummon : 0;
		case LOCATION.SZONE:
			return position & POS.FACEDOWN ? VERB.setSpellTrap : VERB.toSpellTrapUp;
		default:
			return 0;
	}
}

export const STATS_FLAGS = QUERY.POSITION | QUERY.ATTACK | QUERY.DEFENSE | QUERY.LEVEL | QUERY.RANK | QUERY.LINK | QUERY.STATUS | QUERY.IS_HIDDEN;
const STATUS_SHOWN = STATUS.DISABLED | STATUS.FORBIDDEN;

export function statsOf(card) {
	return [card.attack, card.defense, card.level || card.rank || card.link?.rating || 0, card.status & STATUS_SHOWN];
}

export function pollField(duel) {
	return [0, 1].map((controller) => ({
		mzone: duel.queryLocation({ controller, location: LOCATION.MZONE, flags: STATS_FLAGS }),
		szone: duel.queryLocation({ controller, location: LOCATION.SZONE, flags: STATS_FLAGS }),
	}));
}

const seatState = (lp) => ({ lp, mzone: new Array(7).fill(0), szone: new Array(8).fill(0), deck: [], hand: [], grave: [], removed: [], extra: [] });
const describe = ({ controller, location, sequence, position }) => `${controller}/${LOCATION_NAME[location & ~LOCATION.OVERLAY] ?? location}/${sequence}${location & LOCATION.OVERLAY ? `#${position}` : ''}`;

export function createTranslator({ seats, startingLP = [8000, 8000], pool = null }) {
	const holds = (player) => seats.includes(player);
	const table = [seatState(startingLP[0]), seatState(startingLP[1])];
	const cards = new Map();
	const materials = new Map();
	let nextInst = 1;
	let turnPlayer = null;
	let phase = 0;
	let opened = false;
	let hint = null;
	let consumed = null;
	const written = new Map();
	const described = new Map();

	const fail = (what) => {
		throw new Error(`translate: ${what}`);
	};

	function mint(code, position) {
		const inst = nextInst++;
		cards.set(inst, { code, position });
		return inst;
	}

	function retire(inst) {
		for (const unit of materials.get(inst) ?? []) retire(unit);
		materials.delete(inst);
		described.delete(inst);
		cards.delete(inst);
	}

	function hang(holder, removing, value) {
		const held = described.get(holder) ?? new Map();
		const count = held.get(value) ?? 0;
		if (removing && count === 0) return false;
		if (removing && count === 1) held.delete(value);
		else held.set(value, count + (removing ? -1 : 1));
		described.set(holder, held);
		return true;
	}

	function holding(place) {
		const { controller, location, sequence } = place;
		const seat = table[controller];
		if (seat === undefined) return 0;
		if (location & LOCATION.OVERLAY) {
			const host = holding({ controller, location: location & ~LOCATION.OVERLAY, sequence });
			return (materials.get(host) ?? [])[place.position] ?? 0;
		}
		if (location === LOCATION.MZONE) return seat.mzone[sequence] ?? 0;
		if (location === LOCATION.SZONE) return seat.szone[sequence] ?? 0;
		return seat[LIST_OF[location]]?.[sequence] ?? 0;
	}

	function at(place) {
		return holding(place) || fail(`no card at ${describe(place)}`);
	}

	function lift(inst) {
		for (const seat of table) {
			for (const slots of [seat.mzone, seat.szone]) {
				const slot = slots.indexOf(inst);
				if (slot !== -1) {
					slots[slot] = 0;
					return;
				}
			}
			for (const key of Object.values(LIST_OF)) {
				const index = seat[key].indexOf(inst);
				if (index !== -1) {
					seat[key].splice(index, 1);
					return;
				}
			}
		}
		for (const units of materials.values()) {
			const index = units.indexOf(inst);
			if (index !== -1) {
				units.splice(index, 1);
				return;
			}
		}
		fail(`handle ${inst} is nowhere`);
	}

	function place(inst, to) {
		const { controller, location, sequence } = to;
		if (location & LOCATION.OVERLAY) {
			const host = at({ controller, location: location & ~LOCATION.OVERLAY, sequence });
			const units = materials.get(host) ?? [];
			if (to.position > units.length) fail(`overlay index ${to.position} past ${units.length} units under ${host}`);
			units.splice(to.position, 0, inst);
			materials.set(host, units);
			return;
		}
		const seat = table[controller] ?? fail(`no seat ${controller}`);
		if (location === LOCATION.MZONE || location === LOCATION.SZONE) {
			const slots = location === LOCATION.MZONE ? seat.mzone : seat.szone;
			if (sequence >= slots.length) fail(`no slot ${describe(to)}`);
			if (slots[sequence]) fail(`${describe(to)} is occupied by ${slots[sequence]}`);
			slots[sequence] = inst;
			return;
		}
		const list = seat[LIST_OF[location]] ?? fail(`no location ${location}`);
		if (sequence > list.length) fail(`index ${sequence} past the ${list.length} cards at ${describe(to)}`);
		list.splice(sequence, 0, inst);
	}

	function learn(inst, code, position) {
		const known = cards.get(inst);
		if (code) known.code = code;
		if (position !== undefined) known.position = position;
	}

	const codeOf = (inst) => cards.get(inst).code;
	const positionOf = (inst) => cards.get(inst).position;
	const zoneAt = (p) => zoneOf(p.controller, p.location & ~LOCATION.OVERLAY, p.sequence);

	const revealAll = (actor, insts, verb = VERB.reveal) => ({ t: TAG.REVEAL, actor, insts, cards: insts.map(codeOf), to: audienceRef(AUDIENCE.ALL), verb });

	function reshuffle(player, key, orderedCodes) {
		const seat = table[player];
		const count = seat[key].length;
		if (orderedCodes && orderedCodes.length !== count) fail(`shuffle names ${orderedCodes.length} cards, the ${key} holds ${count}`);
		const positions = new Map();
		for (const inst of seat[key]) {
			const { code, position } = cards.get(inst);
			positions.set(code, [...(positions.get(code) ?? []), position]);
			retire(inst);
		}
		const fresh = [];
		for (let i = 0; i < count; i++) {
			const code = orderedCodes ? orderedCodes[i] : 0;
			fresh.push(mint(code, (code && positions.get(code)?.shift()) || POS.FACEDOWN));
		}
		return fresh;
	}

	const silent = () => {};
	const unsupported = (message) => fail(`no rule for ${MSG_NAME[message.kind]}: not a duel this driver hosts`);

	const RULES = {
		[MSG.DRAW]: (m, rows) => {
			const seat = table[m.player];
			const insts = m.cards.map(({ code, position }) => {
				const inst = seat.deck.pop() ?? fail(`player ${m.player} draws from an empty deck`);
				learn(inst, code, position);
				seat.hand.push(inst);
				return inst;
			});
			if (insts.length === 0) return;
			rows.push({ t: TAG.MOVE, actor: m.player, insts, cards: m.cards.map((c) => c.code), from: zoneRef(seatZone(m.player, ZONE.DECK)), to: zoneRef(seatZone(m.player, ZONE.HAND)), verb: VERB.draw });
			const shown = insts.filter((inst) => positionOf(inst) & POS.FACEUP);
			if (shown.length) rows.push(revealAll(m.player, shown));
		},

		[MSG.MOVE]: (m, rows) => {
			const { from, to } = m;
			if (from.location === 0) {
				const inst = mint(m.code, to.position);
				place(inst, to);
				const zone = zoneAt(to);
				let flags = landing(zone, to.position);
				if (to.location === LOCATION.DECK && to.sequence === 0) flags |= FLAG.AT_BOTTOM;
				rows.push({ t: TAG.CREATE, actor: to.controller, cards: [m.code], to: zoneRef(zone), flags, verb: VERB.create, reason: m.reason });
				return;
			}
			const inst = at(from);
			learn(inst, m.code);
			lift(inst);
			if (to.location === 0) {
				retire(inst);
				rows.push({ t: TAG.REMOVE, insts: [inst], verb: VERB.removeToken, reason: m.reason });
				return;
			}
			if (to.location & LOCATION.OVERLAY) {
				const host = at({ controller: to.controller, location: to.location & ~LOCATION.OVERLAY, sequence: to.sequence });
				place(inst, to);
				learn(inst, 0, POS.FACEUP_ATTACK);
				const zone = zoneAt(to);
				rows.push({ t: TAG.ATTACH, insts: [host, inst], cards: [0, m.code], to: zoneRef(zone), flags: landing(zone, positionOf(host)), reason: m.reason });
				return;
			}
			place(inst, to);
			learn(inst, 0, to.position);
			const zone = zoneAt(to);
			let flags = landing(zone, to.position);
			if (to.location === LOCATION.DECK && to.sequence === 0) flags |= FLAG.AT_BOTTOM;
			rows.push({ t: TAG.MOVE, insts: [inst], cards: [m.code], from: zoneRef(zoneAt(from)), to: zoneRef(zone), verb: moveVerb(from.location, to.location, to.sequence, to.position, m.reason), reason: m.reason, flags });
			if ((to.location === LOCATION.HAND || to.location === LOCATION.DECK) && to.position & POS.FACEUP) rows.push(revealAll(to.controller, [inst]));
		},

		[MSG.POS_CHANGE]: (m, rows) => {
			const inst = at(m);
			learn(inst, m.code, m.position);
			const zone = zoneAt(m);
			const spec = zoneSpec(zone);
			const wasUp = (m.previousPosition & POS.FACEUP) !== 0;
			const isUp = (m.position & POS.FACEUP) !== 0;
			if (spec.face !== 'stated') {
				if (isUp && !wasUp) rows.push(revealAll(m.controller, [inst]));
				return;
			}
			let flags = 0;
			let verb = 0;
			if (wasUp !== isUp) {
				flags |= FLAG.FACE_PRESENT | (isUp ? FLAG.FACE_UP : 0);
				verb = isUp ? VERB.flipUp : VERB.flipDown;
			}
			const wasDef = (m.previousPosition & POS.DEFENSE) !== 0;
			const isDef = (m.position & POS.DEFENSE) !== 0;
			if (spec.monster && wasDef !== isDef) {
				flags |= FLAG.POSITION_PRESENT | (isDef ? FLAG.POSITION_DEF : 0);
				if (!verb) verb = VERB.position;
			}
			if (flags === 0) return;
			rows.push({ t: TAG.FLIP, actor: m.controller, insts: [inst], cards: [m.code], flags, verb });
		},

		[MSG.FLIPSUMMONING]: (m, rows) => {
			const inst = at(m);
			learn(inst, m.code, m.position);
			rows.push({ t: TAG.FLIP, actor: m.controller, insts: [inst], cards: [m.code], flags: landing(zoneAt(m), m.position), verb: VERB.flipSummon });
		},

		[MSG.SWAP]: (m, rows) => {
			const first = at(m.first);
			const second = at(m.second);
			lift(first);
			lift(second);
			place(first, m.second);
			place(second, m.first);
			rows.push({ t: TAG.SWAP, insts: [first, second] });
		},

		[MSG.SHUFFLE_SET_CARD]: (m, rows) => {
			const insts = m.from.map(at);
			insts.forEach(lift);
			insts.forEach((inst, i) => {
				place(inst, m.to[i]);
				learn(inst, 0, m.to[i].position);
				const zone = zoneAt(m.to[i]);
				rows.push({ t: TAG.MOVE, insts: [inst], cards: [0], from: zoneRef(zoneAt(m.from[i])), to: zoneRef(zone), flags: landing(zone, m.to[i].position) });
			});
		},

		[MSG.SHUFFLE_DECK]: (m, rows) => {
			const fresh = reshuffle(m.player, 'deck', null);
			table[m.player].deck = fresh.reverse();
			rows.push({ t: TAG.SHUFFLE, actor: m.player, to: zoneRef(seatZone(m.player, ZONE.DECK)), nums: [fresh.length], verb: VERB.shuffleDeck });
		},
		[MSG.SHUFFLE_HAND]: (m, rows) => {
			const seat = table[m.player];
			const fresh = reshuffle(m.player, 'hand', m.codes);
			seat.hand = fresh;
			rows.push({ t: TAG.SHUFFLE, actor: m.player, to: zoneRef(seatZone(m.player, ZONE.HAND)), nums: [fresh.length], ...(m.codes.some(Boolean) ? { cards: [...m.codes] } : {}) });
			const up = fresh.filter((inst) => positionOf(inst) & POS.FACEUP);
			if (up.length) rows.push(revealAll(m.player, up));
		},
		[MSG.SHUFFLE_EXTRA]: (m, rows) => {
			const seat = table[m.player];
			const up = seat.extra.filter((inst) => positionOf(inst) & POS.FACEUP).map(positionOf);
			const fresh = reshuffle(m.player, 'extra', m.codes);
			seat.extra = fresh;
			const first = fresh.length - up.length;
			up.forEach((position, i) => learn(fresh[first + i], 0, position));
			const zone = seatZone(m.player, ZONE.EXTRA);
			rows.push({ t: TAG.SHUFFLE, actor: m.player, to: zoneRef(zone), nums: [fresh.length], flags: FLAG.FACE_PRESENT, ...(m.codes.some(Boolean) ? { cards: [...m.codes] } : {}) });
			const shown = fresh.slice(first);
			if (shown.length) rows.push({ t: TAG.FLIP, actor: m.player, insts: shown, cards: shown.map(codeOf), flags: FLAG.FACE_PRESENT | FLAG.FACE_UP, verb: VERB.flipUp });
		},

		[MSG.DECK_TOP]: (m, rows) => {
			const seat = table[m.player];
			const inst = seat.deck[seat.deck.length - 1 - m.depth] ?? fail(`no card ${m.depth} from the top of player ${m.player}'s deck`);
			learn(inst, m.code, m.position);
			rows.push(revealAll(m.player, [inst], VERB.revealTop));
		},
		[MSG.CONFIRM_DECKTOP]: (m, rows) => rows.push(revealAll(m.player, m.cards.map((card) => learnAt(card)), VERB.revealTop)),
		[MSG.CONFIRM_EXTRATOP]: (m, rows) => rows.push(revealAll(m.player, m.cards.map((card) => learnAt(card)), VERB.revealTop)),
		[MSG.CONFIRM_CARDS]: (m, rows) => {
			const insts = m.cards.map((card) => learnAt(card));
			const first = m.cards[0];
			if (first !== undefined && (first.location & (LOCATION.DECK | LOCATION.EXTRA)) !== 0) {
				rows.push({ t: TAG.REVEAL, actor: m.player, insts, cards: insts.map(codeOf), to: audienceRef(AUDIENCE.seat(m.player)), verb: VERB.reveal });
				return;
			}
			for (const seat of new Set(m.cards.map((card) => card.controller))) rows.push(revealAll(seat, insts.filter((_, i) => m.cards[i].controller === seat)));
		},

		[MSG.CHAINING]: (m, rows) => {
			const inst = at(m);
			learn(inst, m.code);
			const description = BigInt(m.description);
			rows.push({ t: TAG.ACTIVATE, actor: m.triggeringController, insts: [inst], cards: [m.code], verb: VERB.activate, nums: textOf(description) });
			rows.push({ t: TAG.CHAIN, actor: m.triggeringController, insts: [inst], nums: [CHAIN.LINK, m.chainCount] });
		},
		[MSG.CHAIN_SOLVING]: (m, rows) => rows.push({ t: TAG.CHAIN, nums: [CHAIN.SOLVING, m.chainCount] }),
		[MSG.CHAIN_SOLVED]: (m, rows) => rows.push({ t: TAG.CHAIN, nums: [CHAIN.SOLVED, m.chainCount] }),
		[MSG.CHAIN_NEGATED]: (m, rows) => rows.push({ t: TAG.CHAIN, nums: [CHAIN.NEGATED, m.chainCount] }),
		[MSG.CHAIN_DISABLED]: (m, rows) => rows.push({ t: TAG.CHAIN, nums: [CHAIN.DISABLED, m.chainCount] }),
		[MSG.CHAIN_END]: (m, rows) => rows.push({ t: TAG.CHAIN, nums: [CHAIN.END] }),

		[MSG.ATTACK]: (m, rows) => {
			const attacker = at(m.attacker);
			if (m.target.location === 0) rows.push({ t: TAG.ATTACK, actor: m.attacker.controller, insts: [attacker], flags: FLAG.DIRECT_ATTACK, verb: VERB.attack });
			else rows.push({ t: TAG.ATTACK, actor: m.attacker.controller, insts: [attacker, at(m.target)], verb: VERB.attack });
		},

		[MSG.BECOME_TARGET]: (m, rows) => rows.push({ t: TAG.TARGET, insts: m.cards.map(at), verb: VERB.target }),
		[MSG.CARD_SELECTED]: (m, rows) => rows.push({ t: TAG.TARGET, insts: m.cards.map(at), verb: VERB.target }),
		[MSG.RANDOM_SELECTED]: (m, rows) => rows.push({ t: TAG.TARGET, actor: m.player, insts: m.cards.map(at), verb: VERB.target }),
		[MSG.EQUIP]: (m, rows) => rows.push({ t: TAG.TARGET, insts: [at(m.card), at(m.target)], verb: VERB.target }),
		[MSG.CARD_TARGET]: (m, rows) => rows.push({ t: TAG.TARGET, insts: [at(m.card), at(m.target)], verb: VERB.target }),
		[MSG.CANCEL_TARGET]: silent,

		[MSG.NEW_TURN]: (m, rows) => {
			turnPlayer = m.player;
			rows.push({ t: TAG.TURN, actor: m.player, verb: VERB.turn });
		},
		[MSG.NEW_PHASE]: (m, rows) => {
			const next = PHASE_OF[m.phase] ?? fail(`no pack phase for ${m.phase}`);
			if (next === phase) return;
			if (turnPlayer === null) fail('a phase before the first turn');
			phase = next;
			rows.push({ t: TAG.PHASE, actor: turnPlayer, nums: [next], verb: VERB.phase });
		},

		[MSG.DAMAGE]: (m, rows) => lp(m.player, -m.amount, rows),
		[MSG.PAY_LPCOST]: (m, rows) => lp(m.player, -m.amount, rows),
		[MSG.RECOVER]: (m, rows) => lp(m.player, m.amount, rows),
		[MSG.LPUPDATE]: (m, rows) => lp(m.player, m.lp - table[m.player].lp, rows),

		[MSG.ADD_COUNTER]: (m, rows) => rows.push({ t: TAG.COUNTER, insts: [at(m)], nums: [m.count], verb: VERB.counter }),
		[MSG.REMOVE_COUNTER]: (m, rows) => rows.push({ t: TAG.COUNTER, insts: [at(m)], nums: [-m.count], verb: VERB.counter }),

		[MSG.TOSS_COIN]: (m, rows) => rows.push({ t: TAG.COIN, actor: m.player, nums: [...m.results], verb: VERB.coin }),
		[MSG.TOSS_DICE]: (m, rows) => rows.push({ t: TAG.DICE, actor: m.player, nums: [...m.results], verb: VERB.dice }),
		[MSG.HAND_RES]: (m, rows) => rows.push({ t: TAG.THROW, nums: [...m.hands] }),

		[MSG.REMOVE_CARDS]: (m, rows) => {
			const insts = m.cards.map(at);
			for (const inst of insts) {
				lift(inst);
				retire(inst);
			}
			rows.push({ t: TAG.REMOVE, insts });
		},

		[MSG.SET]: silent,
		[MSG.SUMMONING]: silent,
		[MSG.SUMMONED]: silent,
		[MSG.SPSUMMONING]: silent,
		[MSG.SPSUMMONED]: silent,
		[MSG.FLIPSUMMONED]: silent,
		[MSG.CHAINED]: silent,
		[MSG.BATTLE]: silent,
		[MSG.ATTACK_DISABLED]: silent,
		[MSG.DAMAGE_STEP_START]: silent,
		[MSG.DAMAGE_STEP_END]: silent,
		[MSG.MISSED_EFFECT]: silent,
		[MSG.FIELD_DISABLED]: silent,
		[MSG.HINT]: (m, rows) => {
			const hinted = captionHint(m);
			if (hinted !== undefined) hint = hinted;
			const row = hintRow(m);
			if (row !== null) rows.push(row);
		},
		[MSG.CARD_HINT]: (m, rows) => {
			if (m.type === CHINT.DESC_ADD || m.type === CHINT.DESC_REMOVE) {
				const removing = m.type === CHINT.DESC_REMOVE;
				const inst = removing ? holding(m.card) : at(m.card);
				const value = BigInt(m.value);
				if (inst && hang(inst, removing, value)) rows.push({ t: TAG.HINT, insts: [inst], nums: [m.type, ...textOf(value)] });
				return;
			}
			const held = HELD[m.type];
			if (!held) return;
			const { cards, nums = [] } = held(BigInt(m.value));
			rows.push({ t: TAG.HINT, insts: [at(m.card)], ...(cards ? { cards } : {}), nums: [m.type, ...nums] });
		},
		[MSG.PLAYER_HINT]: (m, rows) => {
			if (m.type !== PHINT.DESC_ADD && m.type !== PHINT.DESC_REMOVE) return;
			const value = BigInt(m.description);
			if (hang(-1 - m.player, m.type === PHINT.DESC_REMOVE, value)) rows.push({ t: TAG.HINT, actor: m.player, nums: [m.type, ...textOf(value)] });
		},
		[MSG.AI_NAME]: silent,
		[MSG.SHOW_HINT]: silent,
		[MSG.MATCH_KILL]: silent,
		[MSG.RETRY]: silent,
		[MSG.WIN]: silent,

		[MSG.SWAP_GRAVE_DECK]: unsupported,
		[MSG.REVERSE_DECK]: unsupported,
		[MSG.TAG_SWAP]: unsupported,
		[MSG.RELOAD_FIELD]: unsupported,
	};

	function learnAt(card) {
		const inst = at(card);
		learn(inst, card.code);
		return inst;
	}

	function lp(player, delta, rows) {
		if (delta === 0) return;
		table[player].lp += delta;
		rows.push({ t: TAG.LP, actor: player, nums: [delta], verb: VERB.lp });
	}

	return {
		open(loaded) {
			if (opened) fail('already open');
			opened = true;
			const rows = [];
			loaded.forEach(({ main, extra = [] }, seat) => {
				const deck = main.map((code) => mint(code, POS.FACEDOWN_DEFENSE));
				table[seat].deck = deck.reverse();
				if (main.length) rows.push({ t: TAG.SETUP, to: zoneRef(seatZone(seat, ZONE.DECK)), cards: main.map(() => 0) });
				table[seat].extra = extra.map((code) => mint(code, POS.FACEDOWN_DEFENSE));
				if (extra.length) rows.push({ t: TAG.SETUP, to: zoneRef(seatZone(seat, ZONE.EXTRA)), cards: holds(seat) ? [...extra] : extra.map(() => 0), flags: FLAG.FACE_PRESENT });
			});
			return rows;
		},

		translate(messages) {
			if (!opened) fail('not open');
			const rows = [];
			for (const message of messages) {
				if (message === null) continue;
				if (isPrompt(message.kind)) continue;
				const rule = RULES[message.kind] ?? fail(`no rule for message kind ${message.kind}${MSG_NAME[message.kind] ? ` (${MSG_NAME[message.kind]})` : ''}`);
				rule(message, rows);
			}
			return rows;
		},

		prompt(message) {
			if (!opened) fail('not open');
			const hinted = hint;
			hint = null;
			consumed = hinted;
			return translatePrompt(message, { handle: at, zone: zoneOf }, hinted, pool);
		},

		again() {
			hint = consumed;
		},

		stats(field) {
			if (!opened) fail('not open');
			const onField = new Set();
			const insts = [];
			const nums = [];
			field.forEach(({ mzone, szone }, controller) => {
				const seat = table[controller];
				for (const [cards, slots, name] of [[mzone, seat.mzone, 'MZONE'], [szone, seat.szone, 'SZONE']]) {
					cards.forEach((card, index) => {
						if (card === null) return;
						const inst = slots[index] || fail(`no card at ${controller}/${name}/${index} to carry stats`);
						onField.add(inst);
						if (!(card.position & POS.FACEUP)) return;
						const seen = redactQuery(card, controller, seats);
						if (seen.attack === undefined) return;
						const now = statsOf(seen);
						const last = written.get(inst);
						if (last !== undefined && last.every((value, i) => value === now[i])) return;
						written.set(inst, now);
						insts.push(inst);
						nums.push(...now);
					});
				}
			});
			for (const inst of written.keys()) if (!onField.has(inst)) written.delete(inst);
			return insts.length ? [{ t: TAG.STATS, insts, nums }] : [];
		},

		board() {
			const entry = (inst) => (inst ? { inst, ...cards.get(inst), materials: (materials.get(inst) ?? []).map((unit) => ({ inst: unit, ...cards.get(unit) })) } : null);
			return table.map((seat) => ({
				lp: seat.lp,
				mzone: seat.mzone.map(entry),
				szone: seat.szone.map(entry),
				deck: seat.deck.map(entry),
				hand: seat.hand.map(entry),
				grave: seat.grave.map(entry),
				removed: seat.removed.map(entry),
				extra: seat.extra.map(entry),
			}));
		},

		audit(duel) {
			const diffs = [];
			const field = duel.queryField();
			for (let controller = 0; controller < 2; controller++) {
				const seat = table[controller];
				if (field.players[controller].lp !== seat.lp) diffs.push({ where: `${controller}/lp`, core: field.players[controller].lp, shadow: seat.lp });
				for (const location of LOCATIONS) {
					const core = duel.queryLocation({ controller, location, flags: QUERY.CODE | QUERY.POSITION | QUERY.OVERLAY_CARD });
					const onField = location === LOCATION.MZONE || location === LOCATION.SZONE;
					const shadow = location === LOCATION.MZONE ? seat.mzone : location === LOCATION.SZONE ? seat.szone : seat[LIST_OF[location]];
					const where = `${controller}/${LOCATION_NAME[location]}`;
					if (core.length !== shadow.length) {
						diffs.push({ where, core: core.length, shadow: shadow.length });
						continue;
					}
					core.forEach((card, index) => {
						const inst = shadow[index];
						if ((card === null) !== !inst) return diffs.push({ where: `${where}/${index}`, core: card?.code ?? null, shadow: inst || null });
						if (card === null) return undefined;
						const known = cards.get(inst);
						if (known.code && known.code !== card.code) diffs.push({ where: `${where}/${index}/code`, core: card.code, shadow: known.code });
						const seen = (position) => (onField ? position : position & POS.FACEUP);
						if (known.code && seen(known.position) !== seen(card.position)) diffs.push({ where: `${where}/${index}/position`, core: card.position, shadow: known.position });
						const under = (materials.get(inst) ?? []).map(codeOf);
						const coreUnder = card.overlays ?? [];
						if (under.length !== coreUnder.length || under.some((code, i) => code && code !== coreUnder[i])) diffs.push({ where: `${where}/${index}/overlays`, core: coreUnder, shadow: under });
						return undefined;
					});
				}
			}
			return diffs;
		},
	};
}

export function unruledKinds() {
	const translator = createTranslator({ seats: [0, 1] });
	translator.open([{ main: [1] }, { main: [2] }]);
	const missing = [];
	for (const kind of DECODED_KINDS) {
		if (isPrompt(kind)) continue;
		try {
			translator.translate([{ kind }]);
		} catch (error) {
			if (/no rule for message kind/.test(error.message)) missing.push(kind);
		}
	}
	return missing;
}
