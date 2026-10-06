import { readFile } from 'node:fs/promises';

import { ATTRIBUTE, DUEL, LOCATION, MSG, POS, RACE, TYPE, clockFromSeed, createEngine, createTranslator, loadDecks, play, pollField, redact, replyFor } from '../driver/index.mjs';

export const DIST = new URL('../dist/', import.meta.url);

export const CARDS = new Map();
for (let code = 1; code <= 80; code++) {
	CARDS.set(code, { code, alias: 0, setcodes: [code % 3], type: TYPE.MONSTER | TYPE.NORMAL, level: 4, attribute: ATTRIBUTE.EARTH, race: RACE.WARRIOR, attack: 1000 + (code % 10) * 100, defense: 1000 });
}
export const cardReader = (code) => CARDS.get(code) ?? null;
export const DECKS = [
	{ main: Array.from({ length: 40 }, (_, index) => index + 1), extra: [] },
	{ main: Array.from({ length: 40 }, (_, index) => index + 41), extra: [] },
];
export const TEAM = { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 };
export const SEED = [1n, 2n, 3n, 4n];

export function bot(prompt) {
	switch (prompt.kind) {
		case MSG.SELECT_IDLECMD:
			return prompt.summonable.length ? { action: 0, index: 0 } : prompt.toBp ? { action: 6 } : { action: 7 };
		case MSG.SELECT_BATTLECMD:
			return prompt.attackable.length ? { action: 1, index: 0 } : prompt.toEp ? { action: 3 } : { action: 2 };
		case MSG.SELECT_POSITION:
			return prompt.positions & POS.FACEUP_ATTACK ? POS.FACEUP_ATTACK : POS.FACEUP_DEFENSE;
		case MSG.SELECT_CARD:
			return Array.from({ length: prompt.min }, (_, index) => index);
		case MSG.SELECT_PLACE:
			for (let bit = 0; bit < 5; bit++) if (!((prompt.mask >>> bit) & 1)) return [{ player: prompt.player, location: LOCATION.MZONE, sequence: bit }];
			return undefined;
		case MSG.SELECT_EFFECTYN:
		case MSG.SELECT_YESNO:
			return false;
		case MSG.SELECT_CHAIN:
			return null;
		default:
			return undefined;
	}
}

export const stringify = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));

export async function browserEntry() {
	const factory = (await import(new URL('browser/ocgcore.mjs', DIST))).default;
	const wasmBinary = await readFile(new URL('browser/ocgcore.wasm', DIST));
	return (options) => factory({ ...options, wasmBinary });
}

export async function directDuel(instantiate) {
	const engine = await createEngine(instantiate, { log: () => {} });
	const duel = engine.createDuel({ seed: SEED, flags: DUEL.MODE_MR5, team1: TEAM, team2: TEAM, cardReader, scriptReader: () => null, clock: clockFromSeed(SEED) });
	const orders = loadDecks(duel, DECKS, { seed: SEED });
	duel.start();
	const translator = createTranslator({ seats: [0, 1], startingLP: [TEAM.startingLP, TEAM.startingLP] });
	translator.open(orders);
	const filtered = (messages) => messages.map((message) => redact(message, [0, 1])).filter((message) => message !== null);
	const batches = [];
	const replies = [];
	const fields = [];
	const result = play(
		duel,
		(prompt) => {
			fields.push(pollField(duel));
			const answer = bot(prompt);
			replies.push(replyFor(translator.prompt(redact(prompt, [0, 1])), answer));
			return answer;
		},
		{
			onBatch: (batch) => {
				translator.translate(filtered(batch.messages));
				batches.push(batch);
			},
		},
	);
	if (result.reason !== 'win') throw new Error(`the vanilla duel ended in ${result.reason}`);
	fields.push(pollField(duel));
	duel.destroy();
	return { orders, batches, replies, fields, decisions: result.decisions };
}
