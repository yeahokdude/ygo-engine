import { DUEL_STATUS, HINT, LOCATION, MSG } from './constants.mjs';
import { advance } from './duel.mjs';

const SP_SUMMON = 1;
const ZONES_PER_SIDE = 16;
const MONSTER_SLOTS = 7;

export const TRIAL_BUDGET = Object.freeze({ card: 64, prompt: 256 });

const placeOf = ({ controller, location, sequence }) => `${controller}/${location}/${sequence}`;

export function trySummons(engine, duel, prompt, budget = TRIAL_BUDGET) {
	if (prompt?.kind !== MSG.SELECT_IDLECMD || prompt.spSummonable.length === 0) return prompt;
	const tried = new Map();
	const spSummonable = engine.rewinding((back) => {
		const read = prompt.spSummonable.map((card) => ({ ...card, positions: duel.summonPositions(card) }));
		let left = budget.prompt;
		prompt.spSummonable.forEach((card, index) => {
			const place = placeOf(card);
			if (tried.has(place)) return;
			if (tried.size > 0) back();
			const { spent, landings } = trial(engine, duel, card, index, Math.min(budget.card, left));
			left -= spent;
			tried.set(place, landings);
		});
		return read;
	});
	return {
		...prompt,
		spSummonable: spSummonable.map((card) => {
			const landings = tried.get(placeOf(card));
			return landings ? { ...card, landings } : card;
		}),
	};
}

function trial(engine, duel, card, index, limit) {
	const places = new Map();
	let spent = 0;
	let whole = true;

	const answer = (kind, response) => {
		if (spent >= limit) {
			whole = false;
			return null;
		}
		spent++;
		duel.respond(kind, response);
		return asked(duel);
	};

	const land = ({ prompt, messages }) => {
		if (prompt.count !== 1 || hintedCode(messages) !== card.code) {
			whole = false;
			return;
		}
		const open = monsterZones(prompt);
		if (open.length === 0) return;
		const placed = answer(MSG.SELECT_PLACE, [open[0]]);
		if (placed === null) return;
		const positions = positionsOf(placed, card);
		if (positions === 0) {
			whole = false;
			return;
		}
		for (const { player, sequence } of open) {
			const key = `${player}/${sequence}`;
			places.set(key, { controller: player, sequence, positions: (places.get(key)?.positions ?? 0) | positions });
		}
	};

	const walk = (step) => {
		if (step === null || step.prompt === null) return;
		const { prompt } = step;
		if (prompt.kind === MSG.SELECT_PLACE) return land(step);
		if (prompt.kind === MSG.SELECT_IDLECMD || prompt.kind === MSG.SELECT_BATTLECMD) return;
		const answers = branches(prompt, limit - spent + 1);
		if (answers === null) {
			whole = false;
			return;
		}
		if (answers.length === 1) return walk(answer(prompt.kind, answers[0]));
		engine.rewinding((back) => {
			answers.forEach((response, at) => {
				if (!whole) return;
				if (at > 0) back();
				walk(answer(prompt.kind, response));
			});
		});
	};

	walk(answer(MSG.SELECT_IDLECMD, { action: SP_SUMMON, index }));
	return { spent, landings: whole ? [...places.values()] : null };
}

function asked(duel) {
	const messages = [];
	for (;;) {
		const step = advance(duel);
		messages.push(...step.messages);
		if (step.retry || step.win) return { prompt: null, messages };
		if (step.status !== DUEL_STATUS.CONTINUE) return { prompt: step.prompt, messages };
	}
}

function hintedCode(messages) {
	for (let at = messages.length - 1; at >= 0; at--) {
		const message = messages[at];
		if (message.kind === MSG.HINT && message.type === HINT.SELECTMSG) return Number(message.description);
	}
	return null;
}

function monsterZones({ player, mask }) {
	const open = [];
	for (let bit = 0; bit < 2 * ZONES_PER_SIDE; bit++) {
		const sequence = bit % ZONES_PER_SIDE;
		if ((mask >>> bit) & 1 || sequence >= MONSTER_SLOTS) continue;
		open.push({ player: bit < ZONES_PER_SIDE ? player : 1 - player, location: LOCATION.MZONE, sequence });
	}
	return open;
}

function positionsOf({ prompt, messages }, card) {
	if (prompt?.kind === MSG.SELECT_POSITION && prompt.code === card.code) return prompt.positions;
	const moved = messages.find((message) => message.kind === MSG.MOVE && placeOf(message.from) === placeOf(card) && message.to.location === LOCATION.MZONE);
	return moved?.to.position ?? 0;
}

const earlier = (a, b) => a.controller - b.controller || a.location - b.location || a.sequence - b.sequence || a.position - b.position;

function branches(prompt, most) {
	switch (prompt.kind) {
		case MSG.SELECT_OPTION:
			return prompt.options.map((_, index) => index);
		case MSG.SELECT_YESNO:
		case MSG.SELECT_EFFECTYN:
			return [false, true];
		case MSG.SELECT_UNSELECT_CARD: {
			const picks = prompt.selectable.flatMap((card, index) => (prompt.unselectable.every((picked) => earlier(picked, card) < 0) ? [index] : []));
			return prompt.finishable ? [null, ...picks] : picks;
		}
		case MSG.SELECT_CARD:
			return combinations(prompt.cards.length, Math.max(prompt.min, 1), prompt.max, most);
		case MSG.SELECT_TRIBUTE:
			return combinations(prompt.cards.length, 1, prompt.max, most);
		case MSG.SELECT_SUM:
			return combinations(prompt.cards.length, Math.max(prompt.min, 1), prompt.max || prompt.cards.length, most);
		default:
			return null;
	}
}

function combinations(count, smallest, largest, most) {
	const out = [];
	const chosen = [];
	const pick = (from) => {
		if (out.length >= most) return;
		if (chosen.length >= smallest) out.push([...chosen]);
		if (chosen.length >= largest) return;
		for (let index = from; index < count && out.length < most; index++) {
			chosen.push(index);
			pick(index + 1);
			chosen.pop();
		}
	};
	pick(0);
	return out;
}
