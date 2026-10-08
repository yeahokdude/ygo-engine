import { OPCODE, TYPE } from './constants.mjs';

const ALWAYS = new Set([78734254, 13857930]);
const TOKEN_MONSTER = BigInt(TYPE.MONSTER | TYPE.TOKEN);

const int64 = (value) => BigInt.asIntN(64, value);
const truth = (value) => (value ? 1n : 0n);

const BINARY = new Map([
	[OPCODE.ADD, (a, b) => a + b],
	[OPCODE.SUB, (a, b) => a - b],
	[OPCODE.MUL, (a, b) => a * b],
	[OPCODE.DIV, (a, b) => a / b],
	[OPCODE.AND, (a, b) => truth(a !== 0n && b !== 0n)],
	[OPCODE.OR, (a, b) => truth(a !== 0n || b !== 0n)],
	[OPCODE.BAND, (a, b) => a & b],
	[OPCODE.BOR, (a, b) => a | b],
	[OPCODE.BXOR, (a, b) => a ^ b],
	[OPCODE.LSHIFT, (a, b) => a << (b & 63n)],
	[OPCODE.RSHIFT, (a, b) => a >> (b & 63n)],
]);

const UNARY = new Map([
	[OPCODE.NEG, (a) => -a],
	[OPCODE.NOT, (a) => truth(a === 0n)],
	[OPCODE.BNOT, (a) => ~a],
]);

function inSet(card, value) {
	const set = Number(BigInt.asIntN(32, value));
	const type = set & 0xfff;
	const subtype = set & 0xf000;
	for (const setcode of card.setcodes ?? []) {
		if (setcode === 0) break;
		if ((setcode & 0xfff) === type && (setcode & 0xf000 & subtype) === subtype) return true;
	}
	return false;
}

const TESTS = new Map([
	[OPCODE.ISCODE, (card, a) => truth(BigInt(card.code) === BigInt.asUintN(32, a))],
	[OPCODE.ISTYPE, (card, a) => BigInt(card.type ?? 0) & a],
	[OPCODE.ISRACE, (card, a) => BigInt(card.race ?? 0) & a],
	[OPCODE.ISATTRIBUTE, (card, a) => BigInt(card.attribute ?? 0) & a],
	[OPCODE.ISSETCARD, (card, a) => truth(inSet(card, a))],
]);

const GETS = new Map([
	[OPCODE.GETCODE, (card) => card.code],
	[OPCODE.GETTYPE, (card) => card.type ?? 0],
	[OPCODE.GETRACE, (card) => card.race ?? 0],
	[OPCODE.GETATTRIBUTE, (card) => card.attribute ?? 0],
]);

function step(opcode) {
	const binary = BINARY.get(opcode);
	if (binary !== undefined) {
		return (stack) => {
			if (stack.length < 2) return;
			const right = stack.pop();
			stack.push(int64(binary(stack.pop(), right)));
		};
	}
	const unary = UNARY.get(opcode);
	if (unary !== undefined) {
		return (stack) => {
			if (stack.length >= 1) stack.push(int64(unary(stack.pop())));
		};
	}
	const test = TESTS.get(opcode);
	if (test !== undefined) {
		return (stack, card) => {
			if (stack.length >= 1) stack.push(int64(test(card, stack.pop())));
		};
	}
	const get = GETS.get(opcode);
	if (get !== undefined) return (stack, card) => stack.push(int64(BigInt(get(card))));
	const value = int64(opcode);
	return (stack) => stack.push(value);
}

function compile(opcodes) {
	const steps = [];
	let aliases = false;
	let tokens = false;
	for (const raw of opcodes) {
		const opcode = BigInt.asUintN(64, BigInt(raw));
		if (opcode === OPCODE.ALLOW_ALIASES) aliases = true;
		else if (opcode === OPCODE.ALLOW_TOKENS) tokens = true;
		else steps.push(step(opcode));
	}
	return (card) => {
		const stack = [];
		for (const run of steps) run(stack, card);
		if (stack.length !== 1 || stack[0] === 0n) return false;
		if (ALWAYS.has(card.code)) return true;
		return (aliases || !card.alias) && (tokens || (BigInt(card.type ?? 0) & TOKEN_MONSTER) !== TOKEN_MONSTER);
	};
}

export function declarable(card, opcodes) {
	return compile(opcodes)(card);
}

export function declarableCodes(pool, opcodes) {
	const holds = compile(opcodes);
	const codes = [];
	for (const code of pool.codes) {
		const card = pool.read(code);
		if (card !== null && holds(card)) codes.push(code);
	}
	return codes;
}
