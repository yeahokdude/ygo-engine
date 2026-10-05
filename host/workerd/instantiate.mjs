import factory from './ocgcore.mjs';

export function instantiate(module, options = {}) {
	return factory({
		...options,
		instantiateWasm(imports, done) {
			done(new WebAssembly.Instance(module, imports));
			return {};
		},
	});
}
