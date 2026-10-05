import { QUERY } from './constants.mjs';
import { Reader } from './memory.mjs';
import { readField } from './messages.mjs';

const place = (r) => ({ controller: r.u8(), location: r.u8(), sequence: r.u32(), position: r.u32() });
const optionalPlace = (r) => {
	const value = place(r);
	return value.location === 0 ? null : value;
};

const FIELDS = {
	[QUERY.CODE]: (r, card) => (card.code = r.u32()),
	[QUERY.POSITION]: (r, card) => (card.position = r.u32()),
	[QUERY.ALIAS]: (r, card) => (card.alias = r.u32()),
	[QUERY.TYPE]: (r, card) => (card.type = r.u32()),
	[QUERY.LEVEL]: (r, card) => (card.level = r.u32()),
	[QUERY.RANK]: (r, card) => (card.rank = r.u32()),
	[QUERY.ATTRIBUTE]: (r, card) => (card.attribute = r.u32()),
	[QUERY.RACE]: (r, card) => (card.race = r.u64()),
	[QUERY.ATTACK]: (r, card) => (card.attack = r.i32()),
	[QUERY.DEFENSE]: (r, card) => (card.defense = r.i32()),
	[QUERY.BASE_ATTACK]: (r, card) => (card.baseAttack = r.i32()),
	[QUERY.BASE_DEFENSE]: (r, card) => (card.baseDefense = r.i32()),
	[QUERY.REASON]: (r, card) => (card.reason = r.u32()),
	[QUERY.COVER]: (r, card) => (card.cover = r.u32()),
	[QUERY.REASON_CARD]: (r, card) => (card.reasonCard = optionalPlace(r)),
	[QUERY.EQUIP_CARD]: (r, card) => (card.equipTarget = optionalPlace(r)),
	[QUERY.TARGET_CARD]: (r, card) => (card.targets = r.list(r.u32(), place)),
	[QUERY.OVERLAY_CARD]: (r, card) => (card.overlays = r.list(r.u32(), (r) => r.u32())),
	[QUERY.COUNTERS]: (r, card) =>
		(card.counters = r.list(r.u32(), (r) => {
			const packed = r.u32();
			return { type: packed & 0xffff, count: packed >>> 16 };
		})),
	[QUERY.OWNER]: (r, card) => (card.owner = r.u8()),
	[QUERY.STATUS]: (r, card) => (card.status = r.u32()),
	[QUERY.IS_PUBLIC]: (r, card) => (card.isPublic = r.u8() !== 0),
	[QUERY.LSCALE]: (r, card) => (card.lscale = r.u32()),
	[QUERY.RSCALE]: (r, card) => (card.rscale = r.u32()),
	[QUERY.LINK]: (r, card) => (card.link = { rating: r.u32(), marker: r.u32() }),
	[QUERY.IS_HIDDEN]: (r, card) => (card.isHidden = r.u8() !== 0),
};

export function readQueriedCard(r) {
	const card = {};
	for (;;) {
		const size = r.u16();
		if (size === 0) return null;
		const end = r.at + size;
		const flag = r.u32();
		if (flag === QUERY.END) return card;
		const read = FIELDS[flag];
		if (!read) throw new Error(`no reader for query flag 0x${flag.toString(16)}`);
		read(r, card);
		if (r.at !== end) throw new Error(`query flag 0x${flag.toString(16)}: field is ${size} bytes, read ${r.at - (end - size)}`);
	}
}

export function decodeQuery(bytes) {
	if (bytes.length === 0) return null;
	return readQueriedCard(new Reader(bytes));
}

export function decodeQueryLocation(bytes) {
	const r = new Reader(bytes);
	const length = r.u32();
	const end = r.at + length;
	const cards = [];
	while (r.at < end) cards.push(readQueriedCard(r));
	return cards;
}

export function decodeQueryField(bytes) {
	return readField(new Reader(bytes));
}
