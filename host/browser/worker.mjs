import factory from './ocgcore.mjs';
import { readCardTable, readScriptPack } from './host/artifact.mjs';
import { createSession } from './host/session.mjs';

const PRELUDE = ['constant.lua', 'utility.lua'];

const send = (frame) => self.postMessage(frame);
let outlet = null;

function load(frame) {
	const cards = readCardTable(frame.cards);
	const scripts = readScriptPack(frame.scripts);
	const session = createSession({ instantiate: factory, cardReader: cards.read, cardCodes: cards.codes, scriptReader: scripts.read, prelude: PRELUDE });
	return session.attach({ seats: [0, 1], send });
}

self.addEventListener('message', ({ data: frame }) => {
	if (outlet !== null) return outlet.receive(frame);
	if (frame?.type !== 'load') return send({ type: 'error', message: 'nothing is loaded: the first frame is load', refused: frame?.type ?? null });
	try {
		outlet = load(frame);
	} catch (error) {
		send({ type: 'error', message: String(error?.message ?? error), refused: 'load' });
	}
});
