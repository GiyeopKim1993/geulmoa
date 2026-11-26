// Fallback for browsers/embedded previews that refuse to start a Worker.
// This is loaded only if both ordinary and blob-based workers cannot start.
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = { from: (u8) => new Uint8Array(u8) };
}
const { buildScreenFont } = require('../src/engine');
globalThis.GeulmoaMainEngine = { buildScreenFont };
