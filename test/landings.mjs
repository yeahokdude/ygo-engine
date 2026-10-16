import assert from 'node:assert/strict';

import { ATTRIBUTE, DUEL, LOCATION, MSG, POS, RACE, TYPE, advance, clockFromSeed, createEngine, loadDecks, readLandings, vocabulary, zoneOf } from '../driver/index.mjs';
import { translatePrompt } from '../driver/prompts.mjs';
import { CARDS, DECKS, SEED, TEAM, browserEntry } from './vanilla.mjs';

const { REGION, VERB } = vocabulary;
const browser = await browserEntry();

const FODDER = 41;
const OTHER = 42;
const KAIJU = 90;
const FORCED = 91;
const ZONED = 92;
const ASKED = 93;
const PAID = 94;
const TWIN = 95;
const TALL = 96;
const EXTRA = 97;

const monster = (code, level = 4) => [code, { code, alias: 0, setcodes: [], type: TYPE.MONSTER | TYPE.EFFECT, level, attribute: ATTRIBUTE.EARTH, race: RACE.WARRIOR, attack: 1000, defense: 1000 }];
const rows = new Map([...CARDS, ...[KAIJU, FORCED, ZONED, ASKED, PAID, TWIN, EXTRA].map((code) => monster(code)), monster(TALL, 5)]);
const procedure = (body) => `local e=Effect.CreateEffect(c)
	e:SetType(0x2)
	e:SetCode(34)
	e:SetRange(2)
	${body}
	c:RegisterEffect(e)`;
const scripts = new Map(
	[
		[KAIJU, [
			procedure(`e:SetProperty(0x100000)
	e:SetTargetRange(1,0)
	e:SetCondition(function(e,c) if c==nil then return true end return Duel.IsExistingMatchingCard(function(tc) return tc:GetCode()==${KAIJU} end,c:GetControler(),0,4,1,nil) end)`),
			procedure(`e:SetProperty(0x100000)
	e:SetTargetRange(1,1)
	e:SetTarget(function(e,tp,eg,ep,ev,re,r,rp,chk,c)
		local tc=Duel.GetMatchingGroup(function(tc) return tc:GetCode()==${FODDER} end,tp,0,4,nil):SelectUnselect(Group.CreateGroup(),tp,false,false,1,1)
		e:SetLabelObject(tc)
		return tc~=nil
	end)
	e:SetOperation(function(e,tp,eg,ep,ev,re,r,rp,c) Duel.SendtoGrave(e:GetLabelObject(),0x80) end)`),
		]],
		[FORCED, [
			procedure(''),
			`local f=Effect.CreateEffect(c)
	f:SetType(0x2)
	f:SetProperty(0x800)
	f:SetCode(427)
	f:SetTargetRange(1,0)
	f:SetTarget(function(e,c) return c:GetCode()==${FORCED} end)
	f:SetValue(${POS.FACEUP_DEFENSE})
	Duel.RegisterEffect(f,0)`,
		]],
		[ZONED, [procedure('e:SetValue(function(e,c) return 0,0x4 end)')]],
		[ASKED, [procedure('e:SetTarget(function(e,tp,eg,ep,ev,re,r,rp,chk,c) e:SetLabel(Duel.SelectOption(tp,1,2)) return true end)')]],
		[PAID, [procedure('e:SetOperation(function(e,tp,eg,ep,ev,re,r,rp,c) Duel.PayLPCost(tp,500) end)')]],
		[TWIN, [
			procedure('e:SetCondition(function(e,c) return c==nil end)'),
			procedure(`e:SetProperty(0x100000)
	e:SetTargetRange(${POS.FACEUP_DEFENSE},1)`),
		]],
		[EXTRA, [`local x=Effect.CreateEffect(c)
	x:SetType(0x2)
	x:SetCode(29)
	x:SetTargetRange(2,0)
	x:SetTarget(function(e,c) return c:GetCode()==${EXTRA} end)
	Duel.RegisterEffect(x,0)`]],
	].map(([code, parts]) => [`c${code}.lua`, `function c${code}.initial_effect(c)\n\t${parts.join('\n\t')}\nend`]),
);

async function dealt(hand, field) {
	const logs = [];
	const engine = await createEngine(browser, { log: (entry) => logs.push(entry) });
	const duel = engine.createDuel({ seed: SEED, flags: DUEL.MODE_MR5, team1: TEAM, team2: TEAM, cardReader: (code) => rows.get(code) ?? null, scriptReader: (name) => scripts.get(name) ?? null, clock: clockFromSeed(SEED) });
	loadDecks(duel, [{ main: [...hand, ...DECKS[0].main.slice(hand.length)], extra: [] }, DECKS[1]], { seed: SEED, shuffle: false });
	for (const [controller, codes] of field.entries()) {
		codes.forEach((code, sequence) => duel.newCard({ team: controller, code, controller, location: LOCATION.MZONE, sequence, position: POS.FACEUP_ATTACK }));
	}
	duel.start();
	const idle = asked(duel);
	assert.equal(idle.kind, MSG.SELECT_IDLECMD, 'the duel opens on the turn player\'s idle command');
	return { duel, idle, logs };
}

function asked(duel) {
	for (;;) {
		const step = advance(duel);
		if (step.prompt !== null) return step.prompt;
	}
}

const resolve = { handle: ({ controller, location, sequence }) => 1000 + controller * 100 + location * 10 + sequence, zone: zoneOf };
const landed = (prompt, verb, codes = null) =>
	translatePrompt(prompt, resolve)
		.members.filter((member) => member.verb === verb && (codes === null || codes.includes(member.code)))
		.map((member) => [member.code, member.asksFirst ?? false, member.zones ?? null, member.regions ?? null]);
const MZ = (seat, ...sequences) => sequences.map((sequence) => zoneOf(seat, LOCATION.MZONE, sequence));

function offered(duel, idle, action, code) {
	const list = action === 1 ? idle.spSummonable : action === 3 ? idle.monsterSettable : idle.summonable;
	duel.respond(MSG.SELECT_IDLECMD, { action, index: list.findIndex((card) => card.code === code) });
	const place = asked(duel);
	assert.equal(place.kind, MSG.SELECT_PLACE, `card ${code} is asked its zone next`);
	const open = [];
	for (let bit = 0; bit < 32; bit++) if (!((place.mask >>> bit) & 1) && bit % 16 < 7) open.push(zoneOf((place.player + (bit >= 16 ? 1 : 0)) % 2, LOCATION.MZONE, bit % 16));
	return open.sort((a, b) => a - b);
}

{
	const { duel, idle, logs } = await dealt([KAIJU, FORCED, ZONED, ASKED, PAID], [[], [FODDER, OTHER, FODDER, OTHER, OTHER]]);
	const read = readLandings(duel, idle);
	assert.deepEqual(logs, [], 'a read says nothing on any log');
	assert.deepEqual(
		landed(read, VERB.specialSummon).sort(([a], [b]) => a - b),
		[
			[KAIJU, true, null, null],
			[FORCED, false, MZ(0, 0, 1, 2, 3, 4), [REGION.DEF]],
			[ZONED, false, MZ(0, 2), [REGION.ATK, REGION.DEF]],
			[ASKED, true, null, null],
			[PAID, true, null, null],
		],
		'each Special Summon read as the core reads it: a forced position, a zone the procedure names — and one that runs a script before its zone, or has two procedures to choose from, asked first',
	);
	assert.deepEqual(readLandings(duel, { kind: MSG.SELECT_CHAIN }), { kind: MSG.SELECT_CHAIN }, 'a prompt other than the idle command is left alone');
	assert.deepEqual(offered(duel, read, 1, ZONED), MZ(0, 2), 'the zones read are the ones the core then offers');
	duel.destroy();
	console.log('special    ok  conditions, forced positions, named zones, and a script before the zone asked first');
}

{
	const { duel, idle } = await dealt([TWIN], [[], [OTHER]]);
	assert.deepEqual(landed(readLandings(duel, idle), VERB.specialSummon), [[TWIN, false, MZ(1, 1, 2, 3, 4), [REGION.DEF]]], 'the one procedure whose condition passes, onto the other side, where a card already lies left out');
	assert.deepEqual(offered(duel, readLandings(duel, idle), 1, TWIN), MZ(1, 1, 2, 3, 4), 'as the core offers it');
	duel.destroy();
	console.log('across     ok  the side the one procedure puts it on');
}

{
	const { duel, idle } = await dealt([TALL, EXTRA, FODDER], [[OTHER], []]);
	const read = readLandings(duel, idle);
	const mine = [TALL, EXTRA, FODDER];
	assert.deepEqual(
		landed(read, VERB.normalSummon, mine),
		[[TALL, true, null, null], [EXTRA, true, null, null], [FODDER, false, MZ(0, 1, 2, 3, 4), [REGION.ATK]]],
		'a Normal Summon asking a tribute or which summon it spends is asked first; the rest land in attack in an empty Main Monster Zone',
	);
	assert.deepEqual(landed(read, VERB.setMonster, mine), [[TALL, true, null, null], [EXTRA, false, MZ(0, 1, 2, 3, 4), [REGION.SET_DEF]], [FODDER, false, MZ(0, 1, 2, 3, 4), [REGION.SET_DEF]]], 'its Set the same, face-down — an extra Normal Summon no Set\'s');
	assert.deepEqual(offered(duel, read, 0, FODDER), MZ(0, 1, 2, 3, 4), 'as the core offers them');
	duel.destroy();
	console.log('normal     ok  tributes and extra summons asked first');
}
