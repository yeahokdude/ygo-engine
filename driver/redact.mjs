import { CHINT, HINT, LOCATION, MSG, POS } from './constants.mjs';
import { isPrompt } from './messages.mjs';

const holds = (seats, player) => seats.includes(player);
const notOnly = (seats, player) => seats.length === 0 || seats.some((seat) => seat !== player);

function zeroed(cards, deny) {
	let changed = false;
	const out = cards.map((card) => {
		if (!deny(card) || card.code === 0) return card;
		changed = true;
		return { ...card, code: 0 };
	});
	return changed ? out : cards;
}

const faceDown = (card) => (card.position & POS.FACEUP) === 0;
const hiddenAt = (place) => (place.location & LOCATION.OVERLAY) === 0 && faceDown(place);
const ownersView = (message, key, seats) => {
	if (holds(seats, message.player)) return message;
	const cards = zeroed(message[key], faceDown);
	return cards === message[key] ? message : { ...message, [key]: cards };
};
const unnamed = (message, key) => {
	const cards = zeroed(message[key], (card) => card.controller !== message.player);
	return cards === message[key] ? message : { ...message, [key]: cards };
};

const PRIVATE_HINTS = new Set([HINT.EVENT, HINT.MESSAGE, HINT.SELECTMSG, HINT.EFFECT]);
const OTHERS_HINTS = new Set([HINT.OPSELECTED, HINT.RACE, HINT.ATTRIB, HINT.CODE, HINT.NUMBER, HINT.ZONE]);

const RULES = {
	[MSG.HINT]: (message, seats) => {
		if (PRIVATE_HINTS.has(message.type)) return holds(seats, message.player) ? message : null;
		if (OTHERS_HINTS.has(message.type)) return notOnly(seats, message.player) ? message : null;
		return message;
	},

	[MSG.CARD_HINT]: (message, seats) => (message.type === CHINT.DESC_ADD && hiddenAt(message.card) && !holds(seats, message.card.controller) ? null : message),

	[MSG.DRAW]: (message, seats) => ownersView(message, 'cards', seats),
	[MSG.SHUFFLE_HAND]: (message, seats) => (holds(seats, message.player) ? message : { ...message, codes: message.codes.map(() => 0) }),
	[MSG.SHUFFLE_EXTRA]: (message, seats) => (holds(seats, message.player) ? message : { ...message, codes: message.codes.map(() => 0) }),
	[MSG.TAG_SWAP]: (message, seats) => ownersView(ownersView(message, 'hand', seats), 'extra', seats),

	[MSG.MOVE]: (message, seats) => {
		const { to } = message;
		if (message.code === 0 || holds(seats, to.controller)) return message;
		if (to.location & (LOCATION.GRAVE | LOCATION.OVERLAY)) return message;
		if (to.location & (LOCATION.DECK | LOCATION.HAND) || to.position & POS.FACEDOWN) return { ...message, code: 0 };
		return message;
	},
	[MSG.SET]: (message) => (message.code === 0 ? message : { ...message, code: 0 }),
	[MSG.SPSUMMONING]: (message, seats) =>
		message.code === 0 || holds(seats, message.controller) || !(message.position & POS.FACEDOWN) ? message : { ...message, code: 0 },

	[MSG.CONFIRM_CARDS]: (message, seats) => {
		const first = message.cards[0];
		if (first && first.location & (LOCATION.DECK | LOCATION.EXTRA)) return holds(seats, message.player) ? message : null;
		return message;
	},
	[MSG.MISSED_EFFECT]: (message, seats) => (holds(seats, message.card.controller) ? message : null),

	[MSG.SELECT_CARD]: (message) => unnamed(message, 'cards'),
	[MSG.SELECT_TRIBUTE]: (message) => unnamed(message, 'cards'),
	[MSG.SELECT_UNSELECT_CARD]: (message) => unnamed(unnamed(message, 'selectable'), 'unselectable'),
};

export function redact(message, seats) {
	if (isPrompt(message.kind) && !holds(seats, message.player)) return null;
	const rule = RULES[message.kind];
	return rule ? rule(message, seats) : message;
}

const PRIVATE_QUERY_KEYS = ['code', 'alias', 'type', 'level', 'rank', 'attribute', 'race', 'attack', 'defense', 'baseAttack', 'baseDefense', 'status', 'lscale', 'rscale', 'link'];

export function redactQuery(card, controller, seats) {
	if (card === null) return null;
	const revealed = card.isPublic === true || ((card.position ?? 0) & POS.FACEUP) !== 0;
	const masked = card.isHidden === true || (!holds(seats, controller) && !revealed);
	if (!masked) return card;
	const out = { ...card };
	for (const key of PRIVATE_QUERY_KEYS) delete out[key];
	return out;
}
