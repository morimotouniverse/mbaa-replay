// A wasm thread of the engine (harness-design/engine_core/DESIGN.md phase 3): emscripten's pthread worker, started by
// engine.js (engine_head.js's Worker shim) with name 'em-pthread' and mbaa.js's version as this script's query. The
// thread runs mbaa.js; it starts from this file because a worker of a cross-origin-isolated page must itself be served
// with COEP, which the Worker (tools/web/replay_worker.js) adds and mbaa.js (straight from the host) does not have.
importScripts(`mbaa.js${self.location.search}`);
