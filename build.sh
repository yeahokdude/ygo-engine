#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

CORE_SOURCES=(
	core/card.cpp core/duel.cpp core/effect.cpp core/field.cpp core/interpreter.cpp
	core/libcard.cpp core/libdebug.cpp core/libduel.cpp core/libeffect.cpp core/libgroup.cpp
	core/ocgapi.cpp core/operations.cpp core/playerop.cpp core/processor_visit.cpp
	core/processor.cpp core/scriptlib.cpp
)
LUA_SOURCES=(
	lua/lapi.c lua/lauxlib.c lua/lbaselib.c lua/lcode.c lua/lcorolib.c lua/lctype.c
	lua/ldblib.c lua/ldebug.c lua/ldo.c lua/ldump.c lua/lfunc.c lua/lgc.c lua/linit.c
	lua/liolib.c lua/llex.c lua/lmathlib.c lua/lmem.c lua/loadlib.c lua/lobject.c
	lua/lopcodes.c lua/loslib.c lua/lparser.c lua/lstate.c lua/lstring.c lua/lstrlib.c
	lua/ltable.c lua/ltablib.c lua/ltm.c lua/lundump.c lua/lutf8lib.c lua/lvm.c lua/lzio.c
)

COMMON=(
	-Os -g0 --closure 1 -sASSERTIONS=0
	-sMODULARIZE=1 -sEXPORT_ES6=1
	-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=4MB -sMALLOC=emmalloc
	-fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=1 -sSUPPORT_LONGJMP=wasm -fno-rtti
	-sNO_EXIT_RUNTIME=1 -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0
	-sEXPORTED_FUNCTIONS=_malloc,_free
	-sINCOMING_MODULE_JS_API=instantiateWasm,locateFile,wasmBinary,print,printErr,onAbort
	-sEXPORTED_RUNTIME_METHODS=stackSave,stackRestore,stackAlloc,getValue,stringToUTF8,lengthBytesUTF8,UTF8ToString,HEAP8,HEAPU8,wasmMemory
	-I. -Ilua
)

build() {
	local target=$1 environment=$2
	mkdir -p "dist/$target"
	em++ "${COMMON[@]}" -sENVIRONMENT="$environment" \
		"${LUA_SOURCES[@]}" "${CORE_SOURCES[@]}" shim/ocgcore.cpp \
		-o "dist/$target/ocgcore.mjs"
}

rm -rf dist
build browser web,worker
build workerd web
mkdir -p dist/browser/driver dist/browser/host
cp driver/*.mjs dist/browser/driver/
cp host/session.mjs host/artifact.mjs dist/browser/host/
cp host/browser/*.mjs dist/browser/
cp host/workerd/*.mjs dist/workerd/

EMSCRIPTEN=$(emcc --version | head -n1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+) .*/\1/')
CORE=$(git -c safe.directory='*' -C core rev-parse HEAD)
LUA=$(git -c safe.directory='*' -C lua rev-parse HEAD)
node - "$EMSCRIPTEN" "$CORE" "$LUA" <<'JS'
const { createHash } = require('node:crypto');
const { readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const [emscripten, core, lua] = process.argv.slice(2);
const file = (path) => {
	const bytes = readFileSync(path);
	return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
};
const files = (dir) => readdirSync(dir, { recursive: true }).filter((f) => statSync(`${dir}/${f}`).isFile()).sort();
const target = (name) => Object.fromEntries(files(`dist/${name}`).map((f) => [f, file(`dist/${name}/${f}`)]));
const manifest = { emscripten, core, lua, targets: { browser: target('browser'), workerd: target('workerd') } };
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t') + '\n');
console.log(JSON.stringify(manifest, null, 2));
JS

if [ -n "${CHOWN_TO:-}" ]; then chown -R "$CHOWN_TO" dist manifest.json; fi
