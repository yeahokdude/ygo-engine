import { DUEL, LOCATION, MSG, POS, TYPE } from './constants.mjs';
import { EMZ, FLAG, ZONE, ZONES_PER_SEAT } from './vocabulary.mjs';

const PILES = new Map([
	[ZONE.GY, LOCATION.GRAVE],
	[ZONE.BANISH, LOCATION.REMOVED],
	[ZONE.DECK, LOCATION.DECK],
	[ZONE.EXTRA, LOCATION.EXTRA],
	[ZONE.HAND, LOCATION.HAND],
]);
const NOWHERE = Object.freeze({ controller: 0, location: 0, sequence: 0, position: 0 });

const faceUp = (flags) => (flags & FLAG.FACE_UP) !== 0;

export function placeOf(zone, seat) {
	const shared = EMZ.indexOf(zone);
	if (shared !== -1) return { controller: seat, location: LOCATION.MZONE, sequence: 5 + (shared ^ seat) };
	if (!Number.isInteger(zone) || zone < 1 || zone > 2 * ZONES_PER_SEAT) return null;
	const controller = Math.floor((zone - 1) / ZONES_PER_SEAT);
	const slot = zone - controller * ZONES_PER_SEAT;
	if (ZONE.MZ.includes(slot)) return { controller, location: LOCATION.MZONE, sequence: ZONE.MZ.indexOf(slot) };
	if (ZONE.ST.includes(slot)) return { controller, location: LOCATION.SZONE, sequence: ZONE.ST.indexOf(slot) };
	if (slot === ZONE.FIELD) return { controller, location: LOCATION.SZONE, sequence: 5 };
	return { controller, location: PILES.get(slot), sequence: 0 };
}

function positionOf(location, flags) {
	switch (location) {
		case LOCATION.MZONE:
			if (!faceUp(flags)) return POS.FACEDOWN_DEFENSE;
			return flags & FLAG.POSITION_DEF ? POS.FACEUP_DEFENSE : POS.FACEUP_ATTACK;
		case LOCATION.SZONE:
		case LOCATION.REMOVED:
			return faceUp(flags) ? POS.FACEUP : POS.FACEDOWN;
		case LOCATION.EXTRA:
			return faceUp(flags) ? POS.FACEUP_DEFENSE : POS.FACEDOWN_DEFENSE;
		case LOCATION.GRAVE:
			return POS.FACEUP;
		case LOCATION.HAND:
			return POS.FACEDOWN;
		default:
			return POS.FACEDOWN_DEFENSE;
	}
}

function extraDeckCard(type, duelFlags) {
	const extra = TYPE.FUSION | TYPE.SYNCHRO | TYPE.XYZ | TYPE.LINK | (duelFlags & DUEL.EXTRA_DECK_RITUAL ? TYPE.RITUAL : 0);
	return (type & TYPE.MONSTER && type & extra) !== 0 || (type & TYPE.FUSION) !== 0;
}

function scaleSlots(duelFlags) {
	if (!(duelFlags & DUEL.PZONE) || duelFlags & DUEL.SEPARATE_PZONE) return [];
	return duelFlags & DUEL['3_COLUMNS_FIELD'] ? [1, 3] : [0, 4];
}

function held({ field, disabled }, controller, location, sequence) {
	const locked = (player, bit) => ((disabled >>> (player * 16 + bit)) & 1) === 1;
	if (location === LOCATION.MZONE) {
		if (field[controller].mzone[sequence] !== null || locked(controller, sequence)) return true;
		return sequence >= 5 && (field[1 - controller].mzone[11 - sequence] !== null || locked(1 - controller, 11 - sequence));
	}
	return field[controller].szone[sequence] !== null || locked(controller, 8 + sequence);
}

export function conjureError({ seat, code, zone, flags }, row, table) {
	if (seat !== 0 && seat !== 1) return 'seat: 0 or 1';
	if (!Number.isInteger(code) || code <= 0) return 'code: a card code';
	if (!Number.isInteger(flags) || flags < 0) return 'flags: the flags its row lands with';
	const place = placeOf(zone, seat);
	if (place === null) return `no zone ${zone}`;
	if (row === null) return `no card ${code}`;
	const { controller, location, sequence } = place;
	const extra = extraDeckCard(row.type, table.duelFlags);
	if (location & (LOCATION.HAND | LOCATION.DECK) && extra) return 'an Extra Deck card is made in no hand and no main deck';
	if (location === LOCATION.EXTRA && !(faceUp(flags) ? row.type & TYPE.PENDULUM : extra)) return 'the Extra Deck takes an Extra Deck card face-down and a Pendulum face-up';
	if (location & LOCATION.ONFIELD && held(table, controller, location, sequence)) return `zone ${zone} is not free`;
	return null;
}

export function conjure(duel, { seat, code, zone, flags }, row, duelFlags) {
	const { controller, location, sequence } = placeOf(zone, seat);
	const position = positionOf(location, flags);
	let told = [location, sequence];
	let landed = sequence;
	if (location & LOCATION.ONFIELD) {
		const scale = scaleSlots(duelFlags).indexOf(sequence);
		if (location === LOCATION.SZONE && scale !== -1 && faceUp(flags) && row.type & TYPE.PENDULUM) told = [LOCATION.PZONE, scale];
	} else {
		const count = duel.queryCount(controller, location);
		const bottom = location === LOCATION.DECK && (flags & FLAG.AT_BOTTOM) !== 0;
		told = [location, bottom ? 1 : 0];
		if (bottom) landed = 0;
		else if (location === LOCATION.EXTRA && !faceUp(flags)) landed = count - duel.queryField().players[controller].extraPendulum;
		else landed = count;
	}
	const made = duel.loadScript('conjure', `Debug.AddCard(${code},${controller},${controller},${told[0]},${told[1]},${position},true)`);
	if (!made) throw new Error(`the core would not make card ${code}`);
	return { kind: MSG.MOVE, code, from: NOWHERE, to: { controller, location, sequence: landed, position }, reason: 0 };
}
