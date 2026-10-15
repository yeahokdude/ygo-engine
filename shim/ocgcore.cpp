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

uint32_t EMSCRIPTEN_KEEPALIVE ocgapiDuelSummonPositions(OCG_Duel handle, uint8_t controller, uint32_t location, uint32_t sequence) {
	card* pcard = static_cast<duel*>(handle)->game_field->get_field_card(controller, location, sequence);
	if(pcard == nullptr)
		return 0;
	uint32_t positions[2] = { 0, 0 };
	auto procedures = pcard->field_effect.equal_range(EFFECT_SPSUMMON_PROC);
	for(auto it = procedures.first; it != procedures.second; ++it) {
		effect* peffect = it->second;
		bool param = peffect->is_flag(EFFECT_FLAG_SPSUM_PARAM);
		uint8_t taken = param ? static_cast<uint8_t>(peffect->s_range) : POS_FACEUP;
		positions[param && peffect->o_range != 0 ? 1 : 0] |= taken != 0 ? taken : POS_FACEUP_ATTACK;
	}
	if((pcard->data.type & TYPE_LINK) && (pcard->data.type & TYPE_MONSTER)) {
		for(auto& side : positions) {
			if(side != 0)
				side = POS_FACEUP_ATTACK;
		}
	}
	return positions[0] | (positions[1] << 8);
}

}
