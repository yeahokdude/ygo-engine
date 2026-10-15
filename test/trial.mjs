import assert from 'node:assert/strict';

import { ATTRIBUTE, DUEL, LOCATION, MSG, POS, RACE, TRIAL_BUDGET, TYPE, advance, clockFromSeed, createEngine, loadDecks, trySummons, vocabulary, zoneOf } from '../driver/index.mjs';
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
const DECLARED = 94;
const BUILT = 95;

const monster = (code) => [code, { code, alias: 0, setcodes: [], type: TYPE.MONSTER | TYPE.EFFECT, level: 4, attribute: ATTRIBUTE.EARTH, race: RACE.WARRIOR, attack: 1000, defense: 1000 }];
const rows = new Map([...CARDS, ...[KAIJU, FORCED, ZONED, ASKED, DECLARED, BUILT].map(monster)]);
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
		[ASKED, [procedure(`e:SetTarget(function(e,tp,eg,ep,ev,re,r,rp,chk,c) Debug.Message('asked') e:SetLabel(Duel.SelectOption(tp,1,2)) return true end)
	e:SetValue(function(e,c) return 0,e:GetLabel()==0 and 0x1 or 0x10 end)`)]],
		[DECLARED, [procedure('e:SetTarget(function(e,tp,eg,ep,ev,re,r,rp,chk,c) Duel.AnnounceNumber(tp,1,2) return true end)')]],
		[BUILT, [procedure(`e:SetProperty(0x100000)
	e:SetTargetRange(1,0)
	e:SetTarget(function(e,tp,eg,ep,ev,re,r,rp,chk,c)
		local g=Duel.GetMatchingGroup(function(tc) return tc:GetCode()==${FODDER} end,tp,4,0,nil)
		local sg=Group.CreateGroup()
		while #sg<2 do
			local tc=g:Filter(function(tc) return not sg:IsContains(tc) end,nil):SelectUnselect(sg,tp,false,false,2,2)
			if not tc then return false end
			sg:AddCard(tc)
		end
		sg:KeepAlive()
		e:SetLabelObject(sg)
		return true
	end)
	e:SetOperation(function(e,tp,eg,ep,ev,re,r,rp,c) Duel.SendtoGrave(e:GetLabelObject(),0x80) end)`)]],
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
	return { engine, duel, idle, logs };
}

function asked(duel) {
	for (;;) {
		const step = advance(duel);
		if (step.prompt !== null) return step.prompt;
	}
}

const resolve = { handle: ({ controller, location, sequence }) => 1000 + controller * 100 + location * 10 + sequence, zone: zoneOf };
const summons = (prompt) =>
	translatePrompt(prompt, resolve)
		.members.filter((member) => member.verb === VERB.specialSummon)
		.map((member) => [member.code, member.zones ?? null, member.regions ?? null, member.across ?? null]);
const zones = (ids, regions) => ids.map((zone) => ({ zone, regions }));
const MZ = (seat, ...sequences) => sequences.map((sequence) => zoneOf(seat, LOCATION.MZONE, sequence));

{
	const { engine, duel, idle, logs } = await dealt([KAIJU, FORCED, ZONED, ASKED, DECLARED], [[], [FODDER, OTHER, FODDER, OTHER, OTHER]]);
	const before = engine.snapshot();
	const tried = trySummons(engine, duel, idle);
	const after = engine.snapshot();
	assert.ok(Buffer.from(after.subarray(0, before.length)).equals(Buffer.from(before)) && after.subarray(before.length).every((byte) => byte === 0), 'the engine is left as it was found, byte for byte');
	assert.deepEqual(logs, [], 'and nothing a trial ran was said on any log');
	assert.deepEqual(
		summons(tried).sort(([a], [b]) => a - b),
		[
			[KAIJU, zones(MZ(1, 0, 2), [REGION.ATK]), null, null],
			[FORCED, zones(MZ(0, 0, 1, 2, 3, 4), [REGION.DEF]), null, null],
			[ZONED, zones(MZ(0, 2), [REGION.ATK, REGION.DEF]), null, null],
			[ASKED, zones(MZ(0, 0, 4), [REGION.ATK, REGION.DEF]), null, null],
			[DECLARED, null, [REGION.ATK, REGION.DEF], null],
		],
		'each summon in the zones and positions the core takes it in: a condition, a tribute freeing a zone, a forced position, a zone the procedure names and each answer to a question before the zone tried — and one the trial cannot walk read off its procedures',
	);
	assert.deepEqual(summons(trySummons(engine, duel, idle, { ...TRIAL_BUDGET, prompt: 5 })).map(([code, tried]) => [code, tried !== null]), [[KAIJU, true], [FORCED, false], [ZONED, false], [ASKED, false], [DECLARED, false]], 'a prompt\'s budget spent, the cards after it are read off their procedures');
	assert.equal(trySummons(engine, duel, { kind: MSG.SELECT_CHAIN }).kind, MSG.SELECT_CHAIN, 'a prompt other than the idle command is left alone');

	duel.respond(MSG.SELECT_IDLECMD, { action: 1, index: idle.spSummonable.findIndex((card) => card.code === KAIJU) });
	assert.equal(asked(duel).kind, MSG.SELECT_UNSELECT_CARD, 'the summon tried is played as any');
	duel.respond(MSG.SELECT_UNSELECT_CARD, 1);
	const place = asked(duel);
	assert.equal(place.kind, MSG.SELECT_PLACE);
	assert.equal((place.mask >>> 16) & 0x1f, 0x1f & ~0b100, 'the zone the tribute freed is the one open');
	duel.destroy();
	console.log('trial      ok  conditions, tributes, forced positions, named zones and questions before the zone');
}

{
	const tried = async (budget) => {
		const { engine, duel, idle } = await dealt([BUILT], [[FODDER, FODDER, FODDER, OTHER, OTHER], []]);
		const [[, landed]] = summons(trySummons(engine, duel, idle, budget));
		duel.destroy();
		return landed;
	};
	assert.deepEqual(await tried(TRIAL_BUDGET), zones(MZ(0, 0, 1, 2), [REGION.ATK]), 'the union of the zones each selection frees');
	assert.deepEqual(await tried({ card: 10, prompt: 10 }), zones(MZ(0, 0, 1, 2), [REGION.ATK]), 'a build walked by selection, not by order: two of three in ten answers');
	assert.equal(await tried({ card: 9, prompt: 9 }), null, 'one fewer leaves it read off its procedures');
	console.log('builds     ok  each selection tried once');
}
