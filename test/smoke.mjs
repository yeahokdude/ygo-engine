import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const DIST = new URL('../dist/', import.meta.url);
const EXPECTED_VERSION = [11, 0];
const FORBIDDEN = [/\beval\s*\(/, /new\s+Function\b/, /importScripts/, /\bBlob\b/, /new\s+Worker\b/, /SharedArrayBuffer/];

function version(engine) {
	const out = engine._malloc(8);
	engine._ocgapiGetVersion(out, out + 4);
	const v = [engine.getValue(out, 'i32'), engine.getValue(out + 4, 'i32')];
	engine._free(out);
	return v;
}

{
	const factory = (await import(new URL('browser/ocgcore.mjs', DIST))).default;
	const wasmBinary = await readFile(new URL('browser/ocgcore.wasm', DIST));
	const engine = await factory({ wasmBinary });
	assert.deepEqual(version(engine), EXPECTED_VERSION, 'browser: getVersion');
	assert.ok(engine.wasmMemory instanceof WebAssembly.Memory, 'browser: wasmMemory exported');
	console.log('browser  ok  version', version(engine).join('.'));
}

{
	globalThis.fetch = () => {
		throw new Error('the workerd glue must never fetch');
	};
	const module = await WebAssembly.compile(await readFile(new URL('workerd/ocgcore.wasm', DIST)));
	const { instantiate } = await import(new URL('workerd/instantiate.mjs', DIST));
	const engine = await instantiate(module);
	assert.deepEqual(version(engine), EXPECTED_VERSION, 'workerd: getVersion');
	assert.ok(engine.wasmMemory instanceof WebAssembly.Memory, 'workerd: wasmMemory exported');
	console.log('workerd  ok  version', version(engine).join('.'));
}

{
	const manifest = JSON.parse(await readFile(new URL('manifest.json', DIST), 'utf8'));
	let modules = 0;
	for (const [target, files] of Object.entries(manifest.targets)) {
		for (const [name, { sha256, bytes }] of Object.entries(files)) {
			const data = await readFile(new URL(`${target}/${name}`, DIST));
			assert.equal(data.length, bytes, `${target}/${name}: bytes`);
			assert.equal(createHash('sha256').update(data).digest('hex'), sha256, `${target}/${name}: sha256`);
			if (!name.endsWith('.mjs')) continue;
			for (const pattern of FORBIDDEN) assert.doesNotMatch(data.toString('utf8'), pattern, `${target}/${name} contains ${pattern}`);
			modules++;
		}
	}
	for (const name of ['worker.mjs', 'ocgcore.mjs', 'ocgcore.wasm', 'host/session.mjs', 'host/artifact.mjs', 'driver/index.mjs']) {
		assert.ok(name in manifest.targets.browser, `the browser target carries ${name}`);
	}
	console.log('manifest ok  emscripten', manifest.emscripten, 'core', manifest.core.slice(0, 12), 'lua', manifest.lua.slice(0, 12), `· ${modules} modules scanned`);
}
