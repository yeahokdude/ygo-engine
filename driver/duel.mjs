import { DUEL_STATUS, MSG } from './constants.mjs';
import { isPrompt } from './messages.mjs';

export function advance(duel) {
	const status = duel.process();
	const messages = duel.messages();
	let win = null;
	let retry = false;
	for (const message of messages) {
		if (message.kind === MSG.WIN) win = message;
		else if (message.kind === MSG.RETRY) retry = true;
	}
	let prompt = null;
	if (status === DUEL_STATUS.AWAITING) {
		for (let index = messages.length - 1; index >= 0 && !prompt; index--) {
			if (isPrompt(messages[index].kind)) prompt = messages[index];
		}
	}
	return { status, messages, prompt, win, retry };
}

export function play(duel, answer, { decisionCap = 20_000, onBatch } = {}) {
	let decisions = 0;
	for (;;) {
		const batch = advance(duel);
		onBatch?.(batch);
		if (batch.win) return { reason: 'win', decisions, win: batch.win };
		if (batch.retry) return { reason: 'retry', decisions };
		if (batch.status === DUEL_STATUS.END) return { reason: 'end', decisions };
		if (batch.status === DUEL_STATUS.CONTINUE) continue;
		if (!batch.prompt) return { reason: 'waiting-without-prompt', decisions };
		const response = answer(batch.prompt, batch);
		if (response === undefined) return { reason: 'unanswerable', decisions, prompt: batch.prompt.kind };
		duel.respond(batch.prompt.kind, response);
		if (++decisions >= decisionCap) return { reason: 'decision-cap', decisions };
	}
}

export function replay(log) {
	let at = 0;
	return (prompt) => {
		if (at >= log.length) return undefined;
		const entry = log[at++];
		if (entry.kind !== undefined && entry.kind !== prompt.kind) {
			throw new Error(`response ${at - 1} answers kind ${entry.kind}, the core asked ${prompt.kind}`);
		}
		return entry.answer;
	};
}
