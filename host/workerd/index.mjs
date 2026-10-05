import module from './ocgcore.wasm';
import { instantiate } from './instantiate.mjs';

export default (options) => instantiate(module, options);
