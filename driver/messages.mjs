import { MSG, MSG_NAME } from './constants.mjs';
import { Reader } from './memory.mjs';

const place = (r) => ({ controller: r.u8(), location: r.u8(), sequence: r.u32(), position: r.u32() });
const cardAt = (r) => ({ code: r.u32(), ...place(r) });
const cardRef = (r) => ({ code: r.u32(), controller: r.u8(), location: r.u8(), sequence: r.u32() });
const cardRefNarrow = (r) => ({ code: r.u32(), controller: r.u8(), location: r.u8(), sequence: r.u8() });
const effectRef = (r) => ({ ...cardRef(r), description: r.u64(), clientMode: r.u8() });
const effectAt = (r) => ({ ...cardAt(r), description: r.u64(), clientMode: r.u8() });
const codeAndPosition = (r) => ({ code: r.u32(), position: r.u32() });
const bool = (r) => r.u8() !== 0;
const u32 = (r) => r.u32();
const u64 = (r) => r.u64();
const empty = () => ({});

export function readField(r) {
	const zone = (r) => (r.u8() ? { position: r.u8(), materials: r.u32() } : null);
	const duelOptions = r.u32();
	const players = r.list(2, (r) => ({
		lp: r.i32(),
		monsterZones: r.list(7, zone),
		spellZones: r.list(8, zone),
		deck: r.u32(),
		hand: r.u32(),
		grave: r.u32(),
		removed: r.u32(),
		extra: r.u32(),
		extraPendulum: r.u32(),
	}));
	const chains = r.list(r.u32(), (r) => ({
		...cardAt(r),
		triggeringController: r.u8(),
		triggeringLocation: r.u8(),
		triggeringSequence: r.u32(),
		description: r.u64(),
	}));
	return { duelOptions, players, chains };
}

const text = (r) => {
	const length = r.u16();
	const value = new TextDecoder().decode(r.take(length));
	r.u8();
	return { text: value };
};

const selection = (r) => ({ player: r.u8(), cancelable: bool(r), min: r.u32(), max: r.u32() });

const DECODERS = {
	[MSG.RETRY]: empty,
	[MSG.HINT]: (r) => ({ type: r.u8(), player: r.u8(), description: r.u64() }),
	[MSG.WIN]: (r) => ({ player: r.u8(), reason: r.u8() }),

	[MSG.SELECT_BATTLECMD]: (r) => ({
		player: r.u8(),
		activatable: r.list(r.u32(), effectRef),
		attackable: r.list(r.u32(), (r) => ({ ...cardRefNarrow(r), canDirect: bool(r) })),
		toM2: bool(r),
		toEp: bool(r),
	}),
	[MSG.SELECT_IDLECMD]: (r) => ({
		player: r.u8(),
		summonable: r.list(r.u32(), cardRef),
		spSummonable: r.list(r.u32(), cardRef),
		repositionable: r.list(r.u32(), cardRefNarrow),
		monsterSettable: r.list(r.u32(), cardRef),
		spellSettable: r.list(r.u32(), cardRef),
		activatable: r.list(r.u32(), effectRef),
		toBp: bool(r),
		toEp: bool(r),
		canShuffle: bool(r),
	}),
	[MSG.SELECT_EFFECTYN]: (r) => ({ player: r.u8(), ...cardAt(r), description: r.u64() }),
	[MSG.SELECT_YESNO]: (r) => ({ player: r.u8(), description: r.u64() }),
	[MSG.SELECT_OPTION]: (r) => ({ player: r.u8(), options: r.list(r.u8(), u64) }),
	[MSG.SELECT_CARD]: (r) => ({ ...selection(r), cards: r.list(r.u32(), cardAt) }),
	[MSG.SELECT_CHAIN]: (r) => ({
		player: r.u8(),
		specialCount: r.u8(),
		forced: bool(r),
		hintTiming: [r.u32(), r.u32()],
		chains: r.list(r.u32(), effectAt),
	}),
	[MSG.SELECT_PLACE]: (r) => ({ player: r.u8(), count: r.u8(), mask: r.u32() }),
	[MSG.SELECT_DISFIELD]: (r) => ({ player: r.u8(), count: r.u8(), mask: r.u32() }),
	[MSG.SELECT_POSITION]: (r) => ({ player: r.u8(), code: r.u32(), positions: r.u8() }),
	[MSG.SELECT_TRIBUTE]: (r) => ({ ...selection(r), cards: r.list(r.u32(), (r) => ({ ...cardRef(r), releaseParam: r.u8() })) }),
	[MSG.SORT_CHAIN]: (r) => ({ player: r.u8(), cards: r.list(r.u32(), (r) => ({ code: r.u32(), controller: r.u8(), location: r.u32(), sequence: r.u32() })) }),
	[MSG.SORT_CARD]: (r) => ({ player: r.u8(), cards: r.list(r.u32(), (r) => ({ code: r.u32(), controller: r.u8(), location: r.u32(), sequence: r.u32() })) }),
	[MSG.SELECT_COUNTER]: (r) => ({
		player: r.u8(),
		counterType: r.u16(),
		count: r.u16(),
		cards: r.list(r.u32(), (r) => ({ ...cardRefNarrow(r), count: r.u16() })),
	}),
	[MSG.SELECT_SUM]: (r) => ({
		player: r.u8(),
		overshoot: bool(r),
		sum: r.u32(),
		min: r.u32(),
		max: r.u32(),
		must: r.list(r.u32(), (r) => ({ ...cardAt(r), param: r.u32() })),
		cards: r.list(r.u32(), (r) => ({ ...cardAt(r), param: r.u32() })),
	}),
	[MSG.SELECT_UNSELECT_CARD]: (r) => ({
		player: r.u8(),
		finishable: bool(r),
		cancelable: bool(r),
		min: r.u32(),
		max: r.u32(),
		selectable: r.list(r.u32(), cardAt),
		unselectable: r.list(r.u32(), cardAt),
	}),

	[MSG.CONFIRM_DECKTOP]: (r) => ({ player: r.u8(), cards: r.list(r.u32(), cardRef) }),
	[MSG.CONFIRM_CARDS]: (r) => ({ player: r.u8(), cards: r.list(r.u32(), cardRef) }),
	[MSG.SHUFFLE_DECK]: (r) => ({ player: r.u8() }),
	[MSG.SHUFFLE_HAND]: (r) => ({ player: r.u8(), codes: r.list(r.u32(), u32) }),
	[MSG.SWAP_GRAVE_DECK]: (r) => ({ player: r.u8(), extraCount: r.u32(), extraDeckBits: r.take(r.u32()) }),
	[MSG.SHUFFLE_SET_CARD]: (r) => {
		const location = r.u8();
		const count = r.u8();
		return { location, from: r.list(count, place), to: r.list(count, place) };
	},
	[MSG.REVERSE_DECK]: empty,
	[MSG.DECK_TOP]: (r) => ({ player: r.u8(), depth: r.u32(), code: r.u32(), position: r.u32() }),
	[MSG.SHUFFLE_EXTRA]: (r) => ({ player: r.u8(), codes: r.list(r.u32(), u32) }),
	[MSG.NEW_TURN]: (r) => ({ player: r.u8() }),
	[MSG.NEW_PHASE]: (r) => ({ phase: r.u16() }),
	[MSG.CONFIRM_EXTRATOP]: (r) => ({ player: r.u8(), cards: r.list(r.u32(), cardRef) }),

	[MSG.MOVE]: (r) => ({ code: r.u32(), from: place(r), to: place(r), reason: r.u32() }),
	[MSG.POS_CHANGE]: (r) => ({ ...cardRefNarrow(r), previousPosition: r.u8(), position: r.u8() }),
	[MSG.SET]: cardAt,
	[MSG.SWAP]: (r) => ({ first: cardAt(r), second: cardAt(r) }),
	[MSG.FIELD_DISABLED]: (r) => ({ mask: r.u32() }),

	[MSG.SUMMONING]: cardAt,
	[MSG.SUMMONED]: empty,
	[MSG.SPSUMMONING]: cardAt,
	[MSG.SPSUMMONED]: empty,
	[MSG.FLIPSUMMONING]: cardAt,
	[MSG.FLIPSUMMONED]: empty,

	[MSG.CHAINING]: (r) => ({
		...cardAt(r),
		triggeringController: r.u8(),
		triggeringLocation: r.u8(),
		triggeringSequence: r.u32(),
		description: r.u64(),
		chainCount: r.u32(),
	}),
	[MSG.CHAINED]: (r) => ({ chainCount: r.u8() }),
	[MSG.CHAIN_SOLVING]: (r) => ({ chainCount: r.u8() }),
	[MSG.CHAIN_SOLVED]: (r) => ({ chainCount: r.u8() }),
	[MSG.CHAIN_END]: empty,
	[MSG.CHAIN_NEGATED]: (r) => ({ chainCount: r.u8() }),
	[MSG.CHAIN_DISABLED]: (r) => ({ chainCount: r.u8() }),

	[MSG.CARD_SELECTED]: (r) => ({ cards: r.list(r.u32(), place) }),
	[MSG.RANDOM_SELECTED]: (r) => ({ player: r.u8(), cards: r.list(r.u32(), place) }),
	[MSG.BECOME_TARGET]: (r) => ({ cards: r.list(r.u32(), place) }),

	[MSG.DRAW]: (r) => ({ player: r.u8(), cards: r.list(r.u32(), codeAndPosition) }),
	[MSG.DAMAGE]: (r) => ({ player: r.u8(), amount: r.u32() }),
	[MSG.RECOVER]: (r) => ({ player: r.u8(), amount: r.u32() }),
	[MSG.EQUIP]: (r) => ({ card: place(r), target: place(r) }),
	[MSG.LPUPDATE]: (r) => ({ player: r.u8(), lp: r.i32() }),
	[MSG.CARD_TARGET]: (r) => ({ card: place(r), target: place(r) }),
	[MSG.CANCEL_TARGET]: (r) => ({ card: place(r), target: place(r) }),
	[MSG.PAY_LPCOST]: (r) => ({ player: r.u8(), amount: r.u32() }),
	[MSG.ADD_COUNTER]: (r) => ({ counterType: r.u16(), controller: r.u8(), location: r.u8(), sequence: r.u8(), count: r.u16() }),
	[MSG.REMOVE_COUNTER]: (r) => ({ counterType: r.u16(), controller: r.u8(), location: r.u8(), sequence: r.u8(), count: r.u16() }),

	[MSG.ATTACK]: (r) => ({ attacker: place(r), target: place(r) }),
	[MSG.BATTLE]: (r) => ({
		attacker: { ...place(r), attack: r.u32(), defense: r.u32(), destroyed: bool(r) },
		target: { ...place(r), attack: r.u32(), defense: r.u32(), destroyed: bool(r) },
	}),
	[MSG.ATTACK_DISABLED]: empty,
	[MSG.DAMAGE_STEP_START]: empty,
	[MSG.DAMAGE_STEP_END]: empty,

	[MSG.MISSED_EFFECT]: (r) => ({ card: place(r), code: r.u32() }),
	[MSG.TOSS_COIN]: (r) => ({ player: r.u8(), results: r.list(r.u8(), (r) => r.u8()) }),
	[MSG.TOSS_DICE]: (r) => ({ player: r.u8(), results: r.list(r.u8(), (r) => r.u8()) }),
	[MSG.ROCK_PAPER_SCISSORS]: (r) => ({ player: r.u8() }),
	[MSG.HAND_RES]: (r) => {
		const packed = r.u8();
		return { hands: [packed & 3, packed >> 2] };
	},

	[MSG.ANNOUNCE_RACE]: (r) => ({ player: r.u8(), count: r.u8(), available: r.u64() }),
	[MSG.ANNOUNCE_ATTRIB]: (r) => ({ player: r.u8(), count: r.u8(), available: r.u32() }),
	[MSG.ANNOUNCE_CARD]: (r) => ({ player: r.u8(), opcodes: r.list(r.u8(), u64) }),
	[MSG.ANNOUNCE_NUMBER]: (r) => ({ player: r.u8(), options: r.list(r.u8(), u64) }),

	[MSG.CARD_HINT]: (r) => ({ card: place(r), type: r.u8(), value: r.u64() }),
	[MSG.TAG_SWAP]: (r) => {
		const player = r.u8();
		const deckCount = r.u32();
		const extraCount = r.u32();
		const extraPendulumCount = r.u32();
		const handCount = r.u32();
		const deckTop = r.u32();
		return { player, deckCount, extraPendulumCount, deckTop, hand: r.list(handCount, codeAndPosition), extra: r.list(extraCount, codeAndPosition) };
	},
	[MSG.RELOAD_FIELD]: readField,
	[MSG.AI_NAME]: text,
	[MSG.SHOW_HINT]: text,
	[MSG.PLAYER_HINT]: (r) => ({ player: r.u8(), type: r.u8(), description: r.u64() }),
	[MSG.MATCH_KILL]: (r) => ({ code: r.u32() }),
	[MSG.REMOVE_CARDS]: (r) => ({ cards: r.list(r.u32(), place) }),
};

export const DECODED_KINDS = Object.freeze(Object.keys(DECODERS).map(Number));

const PROMPTS = new Set([
	MSG.SELECT_BATTLECMD, MSG.SELECT_IDLECMD, MSG.SELECT_EFFECTYN, MSG.SELECT_YESNO, MSG.SELECT_OPTION,
	MSG.SELECT_CARD, MSG.SELECT_CHAIN, MSG.SELECT_PLACE, MSG.SELECT_POSITION, MSG.SELECT_TRIBUTE,
	MSG.SORT_CHAIN, MSG.SELECT_COUNTER, MSG.SELECT_SUM, MSG.SELECT_DISFIELD, MSG.SORT_CARD,
	MSG.SELECT_UNSELECT_CARD, MSG.ANNOUNCE_RACE, MSG.ANNOUNCE_ATTRIB, MSG.ANNOUNCE_CARD,
	MSG.ANNOUNCE_NUMBER, MSG.ROCK_PAPER_SCISSORS,
]);

export function isPrompt(kind) {
	return PROMPTS.has(kind);
}

export function decodeMessages(bytes) {
	const messages = [];
	const stream = new Reader(bytes);
	while (stream.remaining > 0) {
		const length = stream.u32();
		const end = stream.at + length;
		const kind = stream.u8();
		const decoder = DECODERS[kind];
		if (!decoder) throw new Error(`no decoder for message kind ${kind}${MSG_NAME[kind] ? ` (${MSG_NAME[kind]})` : ''}`);
		const body = new Reader(bytes, stream.at, end);
		const message = { kind, ...decoder(body) };
		if (body.remaining !== 0) throw new Error(`${MSG_NAME[kind]}: ${body.remaining} bytes left undecoded`);
		messages.push(message);
		stream.at = end;
	}
	return messages;
}
