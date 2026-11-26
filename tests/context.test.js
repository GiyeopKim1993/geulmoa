'use strict';
const assert = require('assert');
const { vowelLayout, vowelFamily, finalShape, selectVariation } = require('../src/jamo-context');
const { decomposeSyllable, composeSyllable } = require('../src/hangul');
const p = (c) => ({ ...decomposeSyllable(c.codePointAt(0)), d: `outline-${c}`, source: c });
assert.equal(vowelLayout('ㅏ'), 'vertical');
assert.equal(vowelLayout('ㅗ'), 'horizontal');
assert.equal(vowelLayout('ㅘ'), 'mixed');
assert.notEqual(vowelFamily('ㅗ'), vowelFamily('ㅜ'));
assert.notEqual(vowelFamily('ㅏ'), vowelFamily('ㅓ'));
assert.equal(finalShape('ㅄ'), 'cluster');
const map = { 'L:ㄱ': ['가', '거', '고', '구', '각', '간', '값', '과', '관'].map(p) };
for (const c of ['가','거','고','구','각','간','값','과','관']) {
  assert.equal(selectVariation(map, 'L:ㄱ', 'L', p(c)).source, c, `exact context ${c}`);
}
assert.equal(selectVariation(map, 'L:ㄴ', 'L', p('나')), null, 'never select a different jamo');
assert.equal(selectVariation(map, 'L:ㄱ', 'L', p('국')).source, '각', 'final presence wins over an open syllable when a matching final context exists');
// Prove the chosen outline affects the composed glyph, not merely its label.
const rectangle = (x) => `M${x} 100 L${x + 220} 100 L${x + 220} 350 L${x} 350 Z`;
const parts = { 'L:ㄱ': rectangle(70), 'V:ㅏ': rectangle(500) };
const variations = { 'L:ㄱ': [{ ...p('가'), d: 'M120 100 L340 100 L230 350 Z' }] };
assert.notEqual(composeSyllable(parts, 'ㄱ', 'ㅏ', '', { variations }),
  composeSyllable(parts, 'ㄱ', 'ㅏ', '', {}));
console.log('context tests passed');
