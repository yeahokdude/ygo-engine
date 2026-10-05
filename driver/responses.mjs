import { MSG, MSG_NAME } from './constants.mjs';
import { Writer } from './memory.mjs';

const integer = (value, what) => {
	if (!Number.isInteger(value)) throw new TypeError(`${what}: expected an integer, got ${typeof value}`);
	return value;
};

const indices = (list, what) => {
	if (!Array.isArray(list)) throw new TypeError(`${what}: expected an array of indices`);
	const writer = new Writer().i32(0).u32(list.length);
	for (const index of list) writer.u32(integer(index, what));
	return writer.bytes();
};

const cancelableIndices = (answer, what) => (answer === null ? new Writer().i32(-1).bytes() : indices(answer, what));

const ENCODERS = {
	[MSG.SELECT_BATTLECMD]: (answer) => new Writer().i32((integer(answer.index ?? 0, 'index') << 16) | integer(answer.action, 'action')).bytes(),
	[MSG.SELECT_IDLECMD]: (answer) => new Writer().i32((integer(answer.index ?? 0, 'index') << 16) | integer(answer.action, 'action')).bytes(),
	[MSG.SELECT_EFFECTYN]: (answer) => new Writer().i32(answer ? 1 : 0).bytes(),
	[MSG.SELECT_YESNO]: (answer) => new Writer().i32(answer ? 1 : 0).bytes(),
	[MSG.SELECT_OPTION]: (answer) => new Writer().i32(integer(answer, 'option')).bytes(),
	[MSG.SELECT_CARD]: (answer) => cancelableIndices(answer, 'cards'),
	[MSG.SELECT_TRIBUTE]: (answer) => cancelableIndices(answer, 'tributes'),
	[MSG.SELECT_SUM]: (answer) => indices(answer, 'sum'),
	[MSG.SELECT_UNSELECT_CARD]: (answer) => (answer === null ? new Writer().i32(-1).bytes() : new Writer().i32(1).i32(integer(answer, 'card')).bytes()),
	[MSG.SELECT_CHAIN]: (answer) => new Writer().i32(answer === null ? -1 : integer(answer, 'chain')).bytes(),
	[MSG.SELECT_PLACE]: places,
	[MSG.SELECT_DISFIELD]: places,
	[MSG.SELECT_POSITION]: (answer) => new Writer().i32(integer(answer, 'position')).bytes(),
	[MSG.SELECT_COUNTER]: (answer) => {
		const writer = new Writer();
		for (const count of answer) writer.i16(integer(count, 'counter'));
		return writer.bytes();
	},
	[MSG.SORT_CARD]: order,
	[MSG.SORT_CHAIN]: order,
	[MSG.ANNOUNCE_RACE]: (answer) => new Writer().u64(answer).bytes(),
	[MSG.ANNOUNCE_ATTRIB]: (answer) => new Writer().u32(integer(answer, 'attributes')).bytes(),
	[MSG.ANNOUNCE_CARD]: (answer) => new Writer().i32(integer(answer, 'code')).bytes(),
	[MSG.ANNOUNCE_NUMBER]: (answer) => new Writer().i32(integer(answer, 'number')).bytes(),
	[MSG.ROCK_PAPER_SCISSORS]: (answer) => new Writer().i32(integer(answer, 'hand')).bytes(),
};

function places(answer) {
	if (!Array.isArray(answer)) throw new TypeError('places: expected an array of { player, location, sequence }');
	const writer = new Writer();
	for (const { player, location, sequence } of answer) {
		writer.u8(integer(player, 'player')).u8(integer(location, 'location')).u8(integer(sequence, 'sequence'));
	}
	return writer.bytes();
}

function order(answer) {
	if (answer === null) return new Writer().i8(-1).bytes();
	if (!Array.isArray(answer)) throw new TypeError('order: expected an array of indices, or null');
	const writer = new Writer();
	for (const index of answer) writer.i8(integer(index, 'order'));
	return writer.bytes();
}

export function encodeResponse(kind, answer) {
	const encoder = ENCODERS[kind];
	if (!encoder) throw new Error(`${MSG_NAME[kind] ?? kind} is not a prompt`);
	return encoder(answer);
}
