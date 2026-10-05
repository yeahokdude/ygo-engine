# ygo-engine

This is a modified version of ygopro-core (https://github.com/edo9300/ygopro-core), changed on 2026-10-05: ygopro-core and Lua 5.3 are included unmodified as submodules (`core/`, `lua/`), compiled to WebAssembly through the shim in `shim/`, and driven by the JavaScript in `driver/` and `host/`.

Released under the GNU Affero General Public License, version 3 or later; see `LICENSE`. Lua is under the MIT License. `shim/ocgcore.cpp` derives from n1xx1/ocgcore-wasm (MIT License, its notice kept in the file).
