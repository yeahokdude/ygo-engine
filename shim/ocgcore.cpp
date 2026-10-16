// Derived from n1xx1/ocgcore-wasm's cpp/wasm.cpp with its JSPI half removed:
//
//   MIT License
//
//   Copyright (c) 2025 Simone Miraglia
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.

#include "core/card.h"
#include "core/common.h"
#include "core/duel.h"
#include "core/effect.h"
#include "core/field.h"
#include "core/interpreter.h"
#include "core/ocgapi.h"
#include <emscripten.h>
#include <cstdlib>

EM_JS(void, ocgapiHandleDataReader, (void* payload, uint32_t code, OCG_CardData* data), {
	try {
		Module["handleDataReader"](payload, code, data);
	} catch (e) {
		console.warn(e);
	}
})

EM_JS(int, ocgapiHandleScriptReader, (void* payload, OCG_Duel duel, const char* name), {
	try {
		const contents = Module["handleScriptReader"](payload, duel, UTF8ToString(name));
		if (contents) {
			const contentLength = lengthBytesUTF8(contents);
			const contentPtr = _malloc(contentLength + 1);
			stringToUTF8(contents, contentPtr, contentLength + 1);
			try {
				return _ocgapiLoadScript(duel, contentPtr, contentLength, name);
			} finally {
				_free(contentPtr);
			}
		}
		return 0;
	} catch (e) {
		console.warn(e);
		return 0;
	}
})

EM_JS(void, ocgapiHandleLogHandler, (void* payload, const char* string, int type), {
	Module["handleLogHandler"](payload, UTF8ToString(string), type);
})

extern "C" {

void EMSCRIPTEN_KEEPALIVE ocgapiGetVersion(int* major, int* minor) {
	OCG_GetVersion(major, minor);
}

int EMSCRIPTEN_KEEPALIVE ocgapiCreateDuel(OCG_Duel* duel, OCG_DuelOptions options) {
	options.cardReader = ocgapiHandleDataReader;
	options.scriptReader = ocgapiHandleScriptReader;
	options.logHandler = ocgapiHandleLogHandler;
	options.cardReaderDone = [](void* payload, OCG_CardData* data) {
		if (data->setcodes != nullptr) {
			free(data->setcodes);
		}
	};
	return OCG_CreateDuel(duel, &options);
}

void EMSCRIPTEN_KEEPALIVE ocgapiDestroyDuel(OCG_Duel duel) {
	OCG_DestroyDuel(duel);
}

void EMSCRIPTEN_KEEPALIVE ocgapiDuelNewCard(OCG_Duel duel, OCG_NewCardInfo* info) {
	OCG_DuelNewCard(duel, info);
}

void EMSCRIPTEN_KEEPALIVE ocgapiStartDuel(OCG_Duel duel) {
	OCG_StartDuel(duel);
}

int EMSCRIPTEN_KEEPALIVE ocgapiDuelProcess(OCG_Duel duel) {
	return OCG_DuelProcess(duel);
}

void* EMSCRIPTEN_KEEPALIVE ocgapiDuelGetMessage(OCG_Duel duel, uint32_t* length) {
	return OCG_DuelGetMessage(duel, length);
}

void EMSCRIPTEN_KEEPALIVE ocgapiDuelSetResponse(OCG_Duel duel, const void* buffer, uint32_t length) {
	OCG_DuelSetResponse(duel, buffer, length);
}

int EMSCRIPTEN_KEEPALIVE ocgapiLoadScript(OCG_Duel duel, const char* buffer, uint32_t length, const char* name) {
	return OCG_LoadScript(duel, buffer, length, name);
}

uint32_t EMSCRIPTEN_KEEPALIVE ocgapiDuelQueryCount(OCG_Duel duel, uint8_t team, uint32_t loc) {
	return OCG_DuelQueryCount(duel, team, loc);
}

void* EMSCRIPTEN_KEEPALIVE ocgapiDuelQuery(OCG_Duel duel, uint32_t* length, OCG_QueryInfo* info) {
	return OCG_DuelQuery(duel, length, info);
}

void* EMSCRIPTEN_KEEPALIVE ocgapiDuelQueryLocation(OCG_Duel duel, uint32_t* length, OCG_QueryInfo* info) {
	return OCG_DuelQueryLocation(duel, length, info);
}

void* EMSCRIPTEN_KEEPALIVE ocgapiDuelQueryField(OCG_Duel duel, uint32_t* length) {
	return OCG_DuelQueryField(duel, length);
}

static constexpr uint32_t LANDING_ASKS = 1u << 31;

static uint32_t landingOf(field* pfield, card* pcard, uint8_t sumplayer, uint8_t targetplayer, uint8_t positions, uint8_t zone, bool rule) {
	uint32_t flag = 0;
	int32_t count = pfield->get_useable_count(pcard, targetplayer, LOCATION_MZONE, sumplayer, LOCATION_REASON_TOFIELD, zone, &flag);
	if((zone & 0x60) && zone != 0xff && !rule) {
		if((zone & 0x20) && pfield->is_location_useable(targetplayer, LOCATION_MZONE, 5)) {
			flag &= ~(1u << 5);
			++count;
		}
		if((zone & 0x40) && pfield->is_location_useable(targetplayer, LOCATION_MZONE, 6)) {
			flag &= ~(1u << 6);
			++count;
		}
	}
	uint32_t open = ~flag & 0x7f;
	if(count <= 0 || open == 0)
		return 0;
	if((pcard->data.type & TYPE_LINK) && (pcard->data.type & TYPE_MONSTER))
		positions = POS_FACEUP_ATTACK;
	return (targetplayer == sumplayer ? open : open << 16) | (static_cast<uint32_t>(positions & 0xf) << 8);
}

static bool costAsks(card* pcard, uint32_t code) {
	effect_set costs;
	pcard->filter_effect(code, &costs);
	for(auto& peffect : costs) {
		if(peffect->operation)
			return true;
	}
	return false;
}

static uint32_t summonLanding(field* pfield, card* pcard, uint8_t sumplayer, bool set) {
	if(pcard->current.location != LOCATION_HAND)
		return 0;
	effect_set procedures;
	int32_t ordinary = set ? pcard->filter_set_procedure(sumplayer, &procedures, FALSE, 0, 0x1f) : pcard->filter_summon_procedure(sumplayer, &procedures, FALSE, 0, 0x1f);
	if(!procedures.empty() || ordinary <= 0)
		return LANDING_ASKS;
	effect_set extra;
	pcard->filter_effect(set ? EFFECT_EXTRA_SET_COUNT : EFFECT_EXTRA_SUMMON_COUNT, &extra);
	if(!extra.empty() && !pfield->core.extra_summon[sumplayer])
		return LANDING_ASKS;
	int32_t tributes = set ? pcard->get_set_tribute_count() : pcard->get_summon_tribute_count();
	bool advance = set ? pfield->is_player_can_mset(SUMMON_TYPE_ADVANCE, sumplayer, pcard, sumplayer) : pfield->is_player_can_summon(SUMMON_TYPE_ADVANCE, sumplayer, pcard, sumplayer);
	if((tributes >> 16) != 0 && advance)
		return LANDING_ASKS;
	if(costAsks(pcard, set ? EFFECT_MSET_COST : EFFECT_SUMMON_COST))
		return LANDING_ASKS;
	uint8_t positions = POS_FACEDOWN_DEFENSE;
	if(!set) {
		positions = POS_FACEUP_ATTACK;
		if(pfield->is_flag(DUEL_NORMAL_SUMMON_FACEUP_DEF) || pfield->is_player_affected_by_effect(sumplayer, EFFECT_NORMAL_SUMMON_FACEUP_DEFENSE) || pfield->is_player_affected_by_effect(sumplayer, EFFECT_DEVINE_LIGHT))
			positions = POS_FACEUP;
		effect_set forced;
		pfield->filter_player_effect(sumplayer, EFFECT_FORCE_NORMAL_SUMMON_POSITION, &forced);
		for(auto& peffect : forced) {
			if(peffect->target) {
				pfield->pduel->lua->add_param<LuaParam::EFFECT>(peffect);
				pfield->pduel->lua->add_param<LuaParam::CARD>(pcard);
				pfield->pduel->lua->add_param<LuaParam::INT>(sumplayer);
				pfield->pduel->lua->add_param<LuaParam::INT>(SUMMON_TYPE_NORMAL);
				pfield->pduel->lua->add_param<LuaParam::INT>(positions);
				pfield->pduel->lua->add_param<LuaParam::INT>(sumplayer);
				if(!pfield->pduel->lua->check_condition(peffect->target, 6))
					continue;
			}
			positions &= peffect->get_value();
		}
	}
	return landingOf(pfield, pcard, sumplayer, sumplayer, positions, 0x1f, false);
}

static uint32_t spsummonLanding(field* pfield, card* pcard, uint8_t sumplayer) {
	effect_set procedures;
	auto must = pfield->core.must_use_mats;
	auto only = pfield->core.only_use_mats;
	auto minc = pfield->core.forced_summon_minc;
	auto maxc = pfield->core.forced_summon_maxc;
	pcard->filter_spsummon_procedure(sumplayer, &procedures, 0);
	pcard->filter_spsummon_procedure_g(sumplayer, &procedures);
	pfield->core.must_use_mats = must;
	pfield->core.only_use_mats = only;
	pfield->core.forced_summon_minc = minc;
	pfield->core.forced_summon_maxc = maxc;
	if(procedures.size() != 1)
		return procedures.empty() ? 0 : LANDING_ASKS;
	effect* procedure = procedures.front();
	if(procedure->code == EFFECT_SPSUMMON_PROC_G || procedure->target || procedure->operation || costAsks(pcard, EFFECT_SPSUMMON_COST))
		return LANDING_ASKS;
	uint8_t targetplayer = sumplayer;
	uint8_t positions = POS_FACEUP;
	if(procedure->is_flag(EFFECT_FLAG_SPSUM_PARAM)) {
		positions = static_cast<uint8_t>(procedure->s_range);
		if(procedure->o_range != 0)
			targetplayer = 1 - sumplayer;
	}
	if(positions == 0)
		positions = POS_FACEUP_ATTACK;
	std::vector<lua_Integer> value;
	procedure->get_value(pcard, 0, value);
	const auto sumtype = (value.size() > 0 ? (static_cast<uint32_t>(value[0]) & 0xf00ffff) : 0) | SUMMON_TYPE_SPECIAL;
	const uint32_t zone = value.size() > 1 ? static_cast<uint32_t>(value[1]) : 0xff;
	effect_set forced;
	pfield->filter_player_effect(sumplayer, EFFECT_FORCE_SPSUMMON_POSITION, &forced);
	for(auto& peffect : forced) {
		if(peffect->target) {
			pfield->pduel->lua->add_param<LuaParam::EFFECT>(peffect);
			pfield->pduel->lua->add_param<LuaParam::CARD>(pcard);
			pfield->pduel->lua->add_param<LuaParam::INT>(sumplayer);
			pfield->pduel->lua->add_param<LuaParam::INT>(sumtype);
			pfield->pduel->lua->add_param<LuaParam::INT>(positions);
			pfield->pduel->lua->add_param<LuaParam::INT>(targetplayer);
			pfield->pduel->lua->add_param<LuaParam::EFFECT>(procedure);
			if(!pfield->pduel->lua->check_condition(peffect->target, 7))
				continue;
		}
		positions &= peffect->get_value();
	}
	return landingOf(pfield, pcard, sumplayer, targetplayer, positions, static_cast<uint8_t>(zone), true);
}

uint32_t EMSCRIPTEN_KEEPALIVE ocgapiDuelSummonLanding(OCG_Duel handle, uint8_t controller, uint32_t location, uint32_t sequence, uint8_t kind) {
	field* pfield = static_cast<duel*>(handle)->game_field;
	card* pcard = pfield->get_field_card(controller, location, sequence);
	if(pcard == nullptr)
		return 0;
	const uint8_t sumplayer = pfield->infos.turn_player;
	switch(kind) {
	case 0:
		return summonLanding(pfield, pcard, sumplayer, false);
	case 1:
		return spsummonLanding(pfield, pcard, sumplayer);
	case 2:
		return summonLanding(pfield, pcard, sumplayer, true);
	default:
		return 0;
	}
}

}
