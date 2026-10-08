import assert from 'node:assert/strict';

import { ATTRIBUTE, DUEL, LOCATION, MSG, OPCODE, RACE, TYPE, advance, clockFromSeed, createEngine, loadDecks, memberKey, replyFor, responseFor, vocabulary } from '../driver/index.mjs';
import { declarable, declarableCodes } from '../driver/declare.mjs';
import { translatePrompt } from '../driver/prompts.mjs';
import { PROTOCOL, createSession } from '../host/session.mjs';
import { CARDS, SEED, TEAM, browserEntry, stringify } from './vanilla.mjs';

const { SHAPE, VERB } = vocabulary;
const SPELL = 81;
const NOT_IN_TABLE = 999;
const ROWS = new Map(CARDS);
const row = (code, fields) => ROWS.set(code, { code, alias: 0, setcodes: [], type: TYPE.MONSTER | TYPE.NORMAL, level: 4, attribute: ATTRIBUTE.EARTH, race: RACE.WARRIOR, attack: 0, defense: 0, ...fields });
row(SPELL, { type: TYPE.SPELL, level: 0 });
row(82, { alias: 1 });
row(83, { type: TYPE.MONSTER | TYPE.TOKEN });
row(84, { setcodes: [0x10ab] });
row(85, { setcodes: [0xab, 0, 0x10ab] });
row(86, { attribute: ATTRIBUTE.LIGHT, race: RACE.DRAGON });
row(87, { type: TYPE.TRAP, level: 0 });
row(78734254, { alias: 2 });
row(13857930, { alias: 3, type: TYPE.MONSTER | TYPE.TOKEN });
const POOL = { codes: [...ROWS.keys()], read: (code) => ROWS.get(code) ?? null };

const SCRIPT = `function c${SPELL}.initial_effect(c)
	local e=Effect.CreateEffect(c)
	e:SetType(0x10)
	e:SetCode(1002)
	e:SetTarget(function(e,tp,eg,ep,ev,re,r,rp,chk)
		if chk==0 then return true end
		Duel.AnnounceCard(tp,DECLARE)
	end)
	c:RegisterEffect(e)
end`;

const declared = (opcodes) => declarableCodes(POOL, opcodes);
const O = OPCODE;
const toLua = (opcodes) => `{${opcodes.map((opcode) => String(BigInt.asIntN(64, BigInt(opcode)))).join(',')}}`;
const DECKS = [{ main: [SPELL, ...Array.from({ length: 39 }, (_, index) => index + 1)], extra: [] }, { main: Array.from({ length: 40 }, (_, index) => index + 41), extra: [] }];
const browser = await browserEntry();

{
	const any = [TYPE.MONSTER | TYPE.SPELL | TYPE.TRAP, O.ISTYPE];
	assert.deepEqual(declared(any).filter((code) => code > 80), [SPELL, 84, 85, 86, 87, 78734254, 13857930], 'an alias and a token are left out, the two named exceptions are not');
	assert.deepEqual(declared([...any, O.ALLOW_ALIASES, O.ALLOW_TOKENS]).filter((code) => code > 80), [SPELL, 82, 83, 84, 85, 86, 87, 78734254, 13857930]);
	assert.deepEqual(declared([5, O.ISCODE, 84, O.ISCODE, O.OR, SPELL, O.ISCODE, O.OR]), [5, SPELL, 84], 'a list of names is an OR of codes');
	assert.deepEqual(declared([0x10ab, O.ISSETCARD]), [84], 'a subtype asks the subtype, and a set code past a 0 is not read');
	assert.deepEqual(declared([0xab, O.ISSETCARD]), [84, 85]);
	assert.deepEqual(declared([O.GETCODE, 1, O.LSHIFT, 2, O.RSHIFT, O.NEG, O.BNOT, 9, O.SUB, O.NOT]), [20, 21]);
	assert.deepEqual(declared([O.GETATTRIBUTE, ATTRIBUTE.LIGHT, O.BAND, O.GETRACE, BigInt(RACE.DRAGON), O.BAND, O.AND]), [86]);
	assert.deepEqual(declared([O.GETTYPE, TYPE.TRAP, O.BAND]), [87]);
	assert.deepEqual(declared([O.ISCODE]), [], 'a test on an empty stack leaves it empty');
	assert.deepEqual(declared([1, 2]), [], 'two values left is no answer');
	assert.equal(declarable(ROWS.get(5), [5n, O.ISCODE]), true, 'opcodes read as BigInt as the decoder writes them');
	assert.equal(declarable(ROWS.get(5), [(1n << 32n) | 5n, O.ISCODE]), true, 'a code is compared as 32 bits');
	console.log('declare    ok');
}

{
	const expressions = [
		[],
		[O.ALLOW_ALIASES],
		[5, O.ISCODE, 84, O.ISCODE, O.OR, SPELL, O.ISCODE, O.OR],
		[0x10ab, O.ISSETCARD],
		[0xab, O.ISSETCARD, O.ALLOW_TOKENS],
		[TYPE.MONSTER, O.ISTYPE, BigInt(RACE.DRAGON), O.ISRACE, O.NOT, O.AND, O.ALLOW_ALIASES],
		[ATTRIBUTE.LIGHT, O.ISATTRIBUTE, TYPE.TOKEN, O.ISTYPE, O.OR, O.ALLOW_TOKENS],
		[O.GETCODE, 1, O.LSHIFT, 2, O.RSHIFT, O.NEG, O.BNOT, 9, O.SUB, O.NOT],
		[O.GETCODE, 3, O.MUL, 7, O.ADD, 4, O.DIV, 0xf, O.BAND, 6, O.BXOR, O.NOT, O.GETTYPE, TYPE.SPELL, O.BOR, O.AND],
	];
	const engine = await createEngine(browser, { log: () => {} });
	const scripts = new Map([[`c${SPELL}.lua`, SCRIPT]]);
	const duel = engine.createDuel({ seed: SEED, flags: DUEL.MODE_MR5, team1: TEAM, team2: TEAM, cardReader: POOL.read, scriptReader: (name) => scripts.get(name) ?? null, clock: clockFromSeed(SEED) });
	loadDecks(duel, DECKS, { seed: SEED, shuffle: false });
	duel.start();
	const asked = () => {
		for (;;) {
			const step = advance(duel);
			assert.equal(step.win, null, 'nobody wins here');
			if (step.prompt !== null || step.retry) return step;
		}
	};
	let step = asked();
	assert.equal(step.prompt.kind, MSG.SELECT_IDLECMD, 'the duel opens on the first player\'s turn');
	const idle = engine.snapshot();
	const activation = step.prompt.activatable.findIndex((effect) => effect.code === SPELL);
	assert.notEqual(activation, -1, 'the spell in hand may be activated');
	let held = 0;
	for (const opcodes of expressions) {
		engine.restore(idle);
		assert.ok(duel.loadScript('declare.lua', `DECLARE=${toLua(opcodes)}`));
		duel.respond(MSG.SELECT_IDLECMD, { action: 5, index: activation });
		step = asked();
		while (step.prompt?.kind === MSG.SELECT_PLACE) {
			const open = Array.from({ length: 5 }, (_, sequence) => sequence).find((sequence) => !((step.prompt.mask >>> (8 + sequence)) & 1));
			duel.respond(MSG.SELECT_PLACE, [{ player: 0, location: LOCATION.SZONE, sequence: open }]);
			step = asked();
		}
		assert.equal(step.prompt?.kind, MSG.ANNOUNCE_CARD, `${stringify(opcodes)} asks a declaration`);
		const prompt = translatePrompt(step.prompt, null, null, POOL);
		assert.deepEqual([prompt.family, prompt.shape, prompt.player, prompt.cancelable], ['announce', SHAPE.ONE_OF, 0, false]);
		assert.equal(new Set(prompt.members.map(memberKey)).size, prompt.members.length, 'members key apart');
		assert.ok(prompt.members.every((member) => member.verb === VERB.declare && member.subject.kind === 'seat' && member.code === member.payload));
		const offered = prompt.members.map((member) => member.code);
		const announcing = engine.snapshot();
		const taken = [];
		for (const code of [...POOL.codes, NOT_IN_TABLE]) {
			engine.restore(announcing);
			duel.respond(MSG.ANNOUNCE_CARD, code);
			if (!asked().retry) taken.push(code);
		}
		assert.deepEqual(offered, taken, `${stringify(opcodes)}: the members are exactly the codes the core takes`);
		const member = prompt.members.length - 1;
		assert.equal(responseFor(prompt, { shape: SHAPE.ONE_OF, member }), taken[member]);
		assert.deepEqual(replyFor(prompt, taken[member]), { shape: SHAPE.ONE_OF, member });
		held += taken.length;
	}
	duel.destroy();
	console.log(`core       ok  ${expressions.length} expressions, ${held} codes taken of ${expressions.length * (POOL.codes.length + 1)} answered`);
}

{
	const named = [5, O.ISCODE, 84, O.ISCODE, O.OR, SPELL, O.ISCODE, O.OR];
	const scripts = new Map([[`c${SPELL}.lua`, SCRIPT], ['declare.lua', `DECLARE=${toLua(named)}`]]);
	const frames = [];
	const session = createSession({ instantiate: browser, cardReader: POOL.read, cardCodes: POOL.codes, scriptReader: (name) => scripts.get(name) ?? null, prelude: ['declare.lua'] });
	const outlet = session.attach({ seats: [0, 1], send: (frame) => frames.push(frame) });
	await outlet.receive({ type: 'open', protocol: PROTOCOL, seed: SEED.map(String), decks: DECKS, shuffle: false });
	const pending = () => frames.findLast((frame) => frame.type === 'step').prompt;
	const answer = (reply) => outlet.receive({ type: 'answer', kind: pending().kind, reply });
	answer({ shape: SHAPE.ONE_OF, member: pending().members.findIndex((member) => member.verb === VERB.activate && member.code === SPELL) });
	while (pending().family === 'zone') answer({ shape: SHAPE.SUBSET, members: [0] });
	const prompt = pending();
	assert.deepEqual([prompt.family, prompt.kind, prompt.members.map((member) => member.code)], ['announce', MSG.ANNOUNCE_CARD, [5, SPELL, 84]], 'the session declares from the codes it was given');
	answer({ shape: SHAPE.ONE_OF, member: 2 });
	assert.deepEqual([frames.at(-1).type, frames.at(-1).retry], ['step', false], 'the core took the code');
	session.close();
	const bare = createSession({ instantiate: browser, cardReader: POOL.read, scriptReader: (name) => scripts.get(name) ?? null, prelude: ['declare.lua'] });
	const ended = [];
	const lone = bare.attach({ seats: [0, 1], send: (frame) => ended.push(frame) });
	await lone.receive({ type: 'open', protocol: PROTOCOL, seed: SEED.map(String), decks: DECKS, shuffle: false });
	const idle = ended.findLast((frame) => frame.type === 'step').prompt;
	lone.receive({ type: 'answer', kind: idle.kind, reply: { shape: SHAPE.ONE_OF, member: idle.members.findIndex((member) => member.verb === VERB.activate && member.code === SPELL) } });
	while (ended.at(-1).type === 'step' && ended.at(-1).prompt?.family === 'zone') lone.receive({ type: 'answer', kind: ended.at(-1).prompt.kind, reply: { shape: SHAPE.SUBSET, members: [0] } });
	assert.deepEqual([ended.at(-1).type, ended.at(-1).reason], ['end', 'error']);
	assert.match(ended.at(-1).message, /holds none/, 'a host given no codes ends the duel saying why');
	console.log('session    ok');
}
