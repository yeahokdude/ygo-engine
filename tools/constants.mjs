import { readFileSync, writeFileSync } from 'node:fs';

const HEADER = new URL('../core/ocgapi_constants.h', import.meta.url);
const TYPES = new URL('../core/ocgapi_types.h', import.meta.url);
const COMMON = new URL('../core/common.h', import.meta.url);
const FIELD = new URL('../core/field.h', import.meta.url);
const OUTPUT = new URL('../driver/constants.mjs', import.meta.url);

const ENUMS = [
	['OCG_LogTypes', 'OCG_LOG_TYPE_', 'LOG_TYPE'],
	['OCG_DuelCreationStatus', 'OCG_DUEL_CREATION_', 'CREATION'],
	['OCG_DuelStatus', 'OCG_DUEL_STATUS_', 'DUEL_STATUS'],
];

const GROUPS = [
	['LOCATION_', 'LOCATION'],
	['POS_', 'POS'],
	['TYPE_', 'TYPE'],
	['ATTRIBUTE_', 'ATTRIBUTE'],
	['RACE_', 'RACE'],
	['REASON_', 'REASON'],
	['STATUS_', 'STATUS'],
	['QUERY_', 'QUERY'],
	['LINK_MARKER_', 'LINK_MARKER'],
	['MSG_', 'MSG'],
	['HINT_', 'HINT'],
	['CHINT_', 'CHINT'],
	['PHINT_', 'PHINT'],
	['EFFECT_CLIENT_MODE_', 'CLIENT_MODE'],
	['OPCODE_', 'OPCODE'],
	['PLAYER_', 'PLAYER'],
	['PHASE_', 'PHASE'],
	['DUEL_', 'DUEL'],
	['TIMING_', 'TIMING'],
];

function define(text, values, keep) {
	for (const line of text.split('\n')) {
		const match = /^#define\s+([A-Z_0-9]+)\s+(.+?)\s*(?:\/\*.*|\/\/.*)?$/.exec(line);
		if (!match || !keep(match[1])) continue;
		values.set(match[1], evaluate(match[2], values));
	}
}

export function generate(headerText, typesText, commonText, fieldText) {
	const values = new Map();
	define(headerText, values, (name) => !name.startsWith('OCG_') && !name.startsWith('OCGAPI_'));
	define(commonText, values, (name) => name.startsWith('LOCATION_'));
	define(fieldText, values, (name) => name.startsWith('TIMING_'));

	const sections = GROUPS.map(([prefix, exported]) => {
		const members = [...values].filter(([name]) => name.startsWith(prefix));
		const wide = members.some(([, value]) => value > 0xffff_ffffn);
		const lines = members.map(([name, value]) => {
			const literal = wide ? `0x${value.toString(16)}n` : value > 0xffn ? `0x${value.toString(16)}` : String(value);
			return `\t${key(name.slice(prefix.length))}: ${literal},`;
		});
		return `export const ${exported} = Object.freeze({\n${lines.join('\n')}\n});`;
	});

	for (const [enumName, prefix, exported] of ENUMS) {
		const body = new RegExp(`typedef enum ${enumName} \\{([^}]*)\\}`).exec(typesText)?.[1];
		if (!body) throw new Error(`${enumName} not found in ocgapi_types.h`);
		const members = body.split(',').map((member) => member.trim()).filter(Boolean);
		const lines = members.map((member, index) => `\t${key(member.slice(prefix.length))}: ${index},`);
		sections.push(`export const ${exported} = Object.freeze({\n${lines.join('\n')}\n});`);
	}
	const major = /OCG_VERSION_MAJOR (\d+)/.exec(typesText)[1];
	const minor = /OCG_VERSION_MINOR (\d+)/.exec(typesText)[1];
	sections.push(`export const VERSION = Object.freeze([${major}, ${minor}]);`);

	const msgNames = [...values].filter(([name]) => name.startsWith('MSG_')).map(([name, value]) => `\t${value}: '${name.slice(4)}',`);
	sections.push(`export const MSG_NAME = Object.freeze({\n${msgNames.join('\n')}\n});`);

	return `${sections.join('\n\n')}\n`;
}

function key(name) {
	return /^[A-Z_][A-Z_0-9]*$/.test(name) ? name : `'${name}'`;
}

function evaluate(expression, values) {
	const tokens = expression.match(/\(uint64_t\)|0x[0-9a-fA-F]+|\d+|[A-Z_][A-Z_0-9]*|<<|>>|[()|&+\-~]/g) ?? [];
	let at = 0;
	const peek = () => tokens[at];
	const take = () => tokens[at++];
	const primary = () => {
		const token = take();
		if (token === undefined) throw new Error(`unexpected end in: ${expression}`);
		if (token === '(uint64_t)') return primary();
		if (token === '(') {
			const value = binary(0);
			if (take() !== ')') throw new Error(`expected ) in: ${expression}`);
			return value;
		}
		if (token === '~') return ~primary();
		if (token === '-') return -primary();
		if (/^0x/i.test(token)) return BigInt(token);
		if (/^0\d/.test(token)) return BigInt(`0o${token.slice(1)}`);
		if (/^\d/.test(token)) return BigInt(token);
		if (!values.has(token)) throw new Error(`${token} is not defined before use in: ${expression}`);
		return values.get(token);
	};
	const PRECEDENCE = { '|': 1, '&': 2, '<<': 3, '>>': 3, '+': 4, '-': 4 };
	const binary = (minimum) => {
		let left = primary();
		for (;;) {
			const operator = peek();
			const precedence = PRECEDENCE[operator];
			if (precedence === undefined || precedence < minimum) return left;
			take();
			const right = binary(precedence + 1);
			left =
				operator === '|' ? left | right
				: operator === '&' ? left & right
				: operator === '<<' ? left << right
				: operator === '>>' ? left >> right
				: operator === '+' ? left + right
				: left - right;
		}
	};
	const value = binary(0);
	if (at !== tokens.length) throw new Error(`trailing tokens in: ${expression}`);
	return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const generated = generate(readFileSync(HEADER, 'utf8'), readFileSync(TYPES, 'utf8'), readFileSync(COMMON, 'utf8'), readFileSync(FIELD, 'utf8'));
	if (process.argv.includes('--check')) {
		let current = '';
		try {
			current = readFileSync(OUTPUT, 'utf8');
		} catch {}
		if (current !== generated) {
			console.error('driver/constants.mjs is stale — run: node tools/constants.mjs');
			process.exit(1);
		}
		console.log('constants ok');
	} else {
		writeFileSync(OUTPUT, generated);
		console.log(`wrote ${OUTPUT.pathname}`);
	}
}
