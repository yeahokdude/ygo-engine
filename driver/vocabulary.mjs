export const TAG = Object.freeze({
	SETUP: 1,
	CREATE: 3,
	SHUFFLE: 4,
	REMOVE: 5,
	MOVE: 10,
	ATTACH: 11,
	SWAP: 12,
	FLIP: 13,
	COUNTER: 15,
	LOCK: 16,
	RELATE: 17,
	REVEAL: 20,
	ACTIVATE: 30,
	TARGET: 31,
	ATTACK: 32,
	LP: 40,
	COIN: 41,
	DICE: 42,
	PHASE: 43,
	TURN: 45,
	THROW: 49,
	CHAT: 50,
	STATS: 60,
	CHAIN: 61,
	SHOW: 62,
	HINT: 63,
});

export const CHAIN = Object.freeze({ LINK: 1, SOLVING: 2, SOLVED: 3, NEGATED: 4, DISABLED: 5, END: 6 });

export const RELATION = Object.freeze({ EQUIP: 1, TARGET: 2 });

export const VERB = Object.freeze({
	activate: 1,
	normalSummon: 2,
	specialAtk: 3,
	specialDef: 4,
	setMonster: 5,
	setSpellTrap: 6,
	toSpellTrapUp: 7,
	position: 8,
	flipUp: 9,
	flipDown: 10,
	attack: 11,
	target: 12,
	reveal: 13,
	toGy: 15,
	banish: 16,
	banishFd: 17,
	toHand: 18,
	toDeckTop: 20,
	toDeckBottom: 21,
	toExtra: 22,
	toExtraFaceUp: 23,
	removeToken: 24,
	draw: 25,
	revealTop: 27,
	shuffleDeck: 29,
	counter: 34,
	create: 35,
	lp: 36,
	coin: 37,
	dice: 38,
	phase: 39,
	turn: 41,
	specialSummon: 44,
	pick: 45,
	unpick: 46,
	place: 47,
	yes: 48,
	no: 49,
	option: 50,
	declare: 51,
	shuffleHand: 52,
	rps: 53,
	setAttack: 54,
	flipSummon: 68,
	declareRace: 69,
	declareAttribute: 70,
	declareNumber: 71,
});

export const DECLARATION = '\u{1f5e3}\u{fe0f}\u{1f4e2}';

export const REGION = Object.freeze({
	ATK: 1,
	DEF: 2,
	SET_DEF: 3,
	FACE_UP: 4,
	SET: 5,
	TOP: 6,
	BOTTOM: 7,
	BANISH_UP: 8,
	BANISH_DOWN: 9,
});

export const SHAPE = Object.freeze({ ONE_OF: 1, SUBSET: 2, ALLOCATION: 3, RANKING: 4, TERMINAL: 5 });
export const OUTCOME = Object.freeze({ CANCEL: 1, FINISH: 2, DECLINE: 3, EMPTY: 4 });

export const FLAG = Object.freeze({
	FACE_PRESENT: 1,
	FACE_UP: 2,
	POSITION_PRESENT: 4,
	POSITION_DEF: 8,
	AT_BOTTOM: 16,
	DISPLAY: 32,
	DIRECT_ATTACK: 64,
});

export const ZONE = Object.freeze({
	MZ: Object.freeze([1, 2, 3, 4, 5]),
	ST: Object.freeze([6, 7, 8, 9, 10]),
	FIELD: 11,
	GY: 12,
	BANISH: 13,
	DECK: 14,
	EXTRA: 15,
	HAND: 16,
});
export const ZONES_PER_SEAT = 16;
export const EMZ = Object.freeze([61, 62]);

export const PACK_PHASE = Object.freeze({ DP: 1, SP: 2, M1: 3, BP: 4, M2: 5, EP: 6 });

export const AUDIENCE = Object.freeze({ ALL: 0, seat: (seat) => 1 + seat });

export const zoneRef = (zone) => zone * 2;
export const audienceRef = (audience) => audience * 2 + 1;

export const seatZone = (seat, slot) => seat * ZONES_PER_SEAT + slot;

const SLOT_SPEC = new Map([
	...ZONE.MZ.map((slot) => [slot, { kind: 'field', face: 'stated', monster: true }]),
	...ZONE.ST.map((slot) => [slot, { kind: 'field', face: 'stated', monster: false }]),
	[ZONE.FIELD, { kind: 'field', face: 'stated', monster: false }],
	[ZONE.GY, { kind: 'pile', face: 'up', monster: false }],
	[ZONE.BANISH, { kind: 'pile', face: 'stated', monster: false }],
	[ZONE.DECK, { kind: 'pile', face: 'down', monster: false }],
	[ZONE.EXTRA, { kind: 'pile', face: 'stated', monster: false }],
	[ZONE.HAND, { kind: 'hand', face: 'down', monster: false }],
]);
const EMZ_SPEC = { kind: 'field', face: 'stated', monster: true };

export function zoneSpec(zone) {
	if (EMZ.includes(zone)) return EMZ_SPEC;
	const spec = SLOT_SPEC.get(((zone - 1) % ZONES_PER_SEAT) + 1);
	if (!spec || zone < 1 || zone > 2 * ZONES_PER_SEAT) throw new RangeError(`no zone ${zone}`);
	return spec;
}
