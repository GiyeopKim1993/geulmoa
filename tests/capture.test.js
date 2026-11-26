'use strict';
const assert = require('assert');
const { splitCell, renderPixels, pixelsOf } = require('../src/screen-capture');
const { traceGray } = require('../src/engine');
const { buildHangulGlyphs, requiredComponents, HANGUL_COUNT } = require('../src/hangul');
const size = 256, ink = new Uint8Array(size * size);
function line(x0,y0,x1,y1,w=6) {
  const n = Math.max(Math.abs(x1-x0),Math.abs(y1-y0));
  for(let i=0;i<=n;i++) for(let a=-w;a<=w;a++) for(let b=-w;b<=w;b++) {
    const x=Math.round(x0+(x1-x0)*i/n)+a, y=Math.round(y0+(y1-y0)*i/n)+b;
    if (x>=0&&y>=0&&x<size&&y<size) ink[y*size+x]=1;
  }
}
// Widely spaced strokes of 가: the known syllable supplies the labels.
line(30,50,95,50); line(95,50,95,160); line(170,35,170,190); line(170,112,210,112);
const cap=splitCell(ink,size,'가');
assert(cap && !cap.incomplete);
assert.deepEqual(cap.groups.map(g=>g.key), ['L:ㄱ','V:ㅏ']);
const px=pixelsOf(ink,size,cap.boxes,cap.parts);
const crop=renderPixels(px,size,8);
assert(traceGray(crop.gray,crop.cropSize.width,crop.cropSize.height).length > 10);
// A filled set of valid component paths reaches every precomposed syllable.
const all={}; for(const {key} of requiredComponents()) all[key]='M100 100L700 100L700 700L100 700Z';
const glyphs=buildHangulGlyphs(all);
assert.equal(glyphs.length,HANGUL_COUNT);
assert.equal(glyphs[0].char,'가');
assert.equal(glyphs.at(-1).char,'힣');
console.log('capture, outline and 11,172-codepoint tests passed');
