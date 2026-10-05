import createEngine from './index.mjs';

const EXPECTED_VERSION = [11, 0];
const EMPTY_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

export default {
	async test() {
		let refused = false;
		try {
			new WebAssembly.Module(EMPTY_MODULE);
		} catch {
			refused = true;
		}
		if (!refused) throw new Error('control failed: this runtime compiles wasm from bytes, so this run proves nothing');

		const engine = await createEngine();
		const out = engine._malloc(8);
		engine._ocgapiGetVersion(out, out + 4);
		const version = [engine.getValue(out, 'i32'), engine.getValue(out + 4, 'i32')];
		engine._free(out);
		if (version[0] !== EXPECTED_VERSION[0] || version[1] !== EXPECTED_VERSION[1]) {
			throw new Error(`getVersion → [${version}], expected [${EXPECTED_VERSION}]`);
		}
		if (!(engine.wasmMemory instanceof WebAssembly.Memory)) throw new Error('wasmMemory is not exported');
	},
};
