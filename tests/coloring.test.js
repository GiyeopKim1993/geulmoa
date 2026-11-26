'use strict';
const assert = require('assert');
const { extractMasks } = require('../site/coloring');
const N = 3, ink = new Uint8ClampedArray(N * N * 4), colors = new Uint8ClampedArray(N * N * 4);
function set(a, p, [r, g, b, alpha]) { a.set([r, g, b, alpha], p * 4); }
for (let p = 0; p < 8; p++) set(ink, p, [0, 0, 0, 255]);
set(ink, 8, [0, 0, 0, 30]); // antialiased background is not ink
set(colors, 0, [255, 0, 0, 255]);
set(colors, 1, [0, 255, 0, 255]);
set(colors, 2, [0, 0, 255, 255]);
set(colors, 3, [0, 0, 0, 0]); // unpainted
set(colors, 4, [255, 0, 0, 99]); // not enough paint coverage
set(colors, 5, [20, 200, 0, 255]); // mixed edge still picks one role
set(colors, 6, [50, 0, 200, 255]);
set(colors, 7, [180, 40, 0, 255]);
const a = extractMasks(ink, colors, N, ['L', 'V', 'T']);
assert.equal(a.inkCount, 8);
assert.equal(a.unassigned, 2);
assert.deepEqual(a.counts, { L: 2, V: 2, T: 2, X: 0 });
for (let p = 0; p < N * N; p++) {
  assert((a.masks.L[p] + a.masks.V[p] + a.masks.T[p]) <= 1, 'pixel must never belong to multiple roles');
}
const noFinal = extractMasks(ink, colors, N, ['L', 'V']);
assert.equal(noFinal.unassigned, 4, 'a role that the syllable does not have cannot be silently accepted');
const literal = extractMasks(ink, null, N, ['X']);
assert.equal(literal.counts.X, 8, 'numbers and punctuation do not require color separation');
assert.equal(literal.unassigned, 0);
console.log('manual color-mask separation tests passed');
