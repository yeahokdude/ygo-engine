using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [ (name = "engine", worker = .engine) ],
);

const engine :Workerd.Worker = (
  compatibilityDate = "2025-03-07",
  modules = [
    (name = "worker.mjs", esModule = embed "worker.mjs"),
    (name = "index.mjs", esModule = embed "../../dist/workerd/index.mjs"),
    (name = "instantiate.mjs", esModule = embed "../../dist/workerd/instantiate.mjs"),
    (name = "ocgcore.mjs", esModule = embed "../../dist/workerd/ocgcore.mjs"),
    (name = "ocgcore.wasm", wasm = embed "../../dist/workerd/ocgcore.wasm"),
  ],
);
