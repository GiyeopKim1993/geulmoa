'use strict';
// Settings interpolation must not depend on any browser canvas; the actual
// pixel/topology safeguards are exercised by the browser and TTF tests.
const assert = require('node:assert/strict');
const { VectorCorrection } = require('../src/vector-correction');
const { buildHangulGlyphs, buildHangulGlyphsCooperatively, requiredComponents } = require('../src/hangul');
const sources = [20, 40, 60].map((width) => ({ width, strokes: [{}], wholeUsable: true }));
function correction(strength, targetRatio) {
  const c = new VectorCorrection({ enabled: false, traceGray: () => '', strength, targetRatio });
  c.setTarget(sources); return c;
}
const defaults = correction(undefined, undefined);
assert.equal(defaults.baseTarget, 40); assert.equal(defaults.target, 40); assert.equal(defaults.outputWidth(20), 40);
const half = correction(50, 100);
assert.equal(half.outputWidth(20), 30); assert.equal(half.outputWidth(60), 50);
const thin = correction(100, 70), thick = correction(100, 130);
assert.equal(thin.target, 28); assert.equal(thick.target, 52);
assert.equal(correction(0, 130).outputWidth(20), 20);
assert.equal(correction(-10, 999).strength, 0); assert.equal(correction(999, -20).strength, 1);
assert.equal(correction(999, -20).targetRatio, .7); assert.equal(correction(NaN, Infinity).targetRatio, 1);
const zero = new VectorCorrection({ enabled: true, strength: 0, traceGray: () => '' });
assert.equal(zero.available, true, '0% does not need a canvas');
assert.equal(zero.original('M0 0Z', null).status, 'off');
const all = {}; for (const { key } of requiredComponents()) all[key] = 'M100 100L700 100L700 700L100 700Z';
const complete = buildHangulGlyphs(all), chosen = ['힣', '가', '가', 'a', '각'];
const subset = buildHangulGlyphs(all, { onlySyllables: chosen });
assert.deepEqual(subset.map((g) => g.char), ['가', '각', '힣']);
for (const glyph of subset) assert.deepEqual(glyph, complete.find((g) => g.char === glyph.char));
(async () => {
  const cooperative = await buildHangulGlyphsCooperatively(all, { onlySyllables: chosen }, () => Promise.resolve());
  assert.deepEqual(cooperative, subset);
  console.log('vector width settings, old defaults, 0%, bounds and filtered preview compositions passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
