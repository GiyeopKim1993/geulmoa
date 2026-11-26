'use strict';
// The local Map index must preserve svg2ttf's historical first-match behavior.
const assert = require('node:assert/strict');
const _ = require('lodash');
const { load } = require('../vendor/svg2ttf/lib/svg');
const specs=[];let seed=90311;
function rand(n){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;}
for(let i=0;i<500;i++){
 const choice=rand(5), width=choice===0?undefined:choice===1?0:choice===2?800:choice===3?1000:NaN;
 specs.push({name:`g${i}`,code:0xac00+i,width,d:`M${rand(19)} ${rand(7)} L${rand(13)} ${rand(11)} Z`});
}
// Include deterministic duplicates and a ligature pointing at a canonical glyph.
specs[1]={...specs[0],name:'g1',code:0xac01};specs[0].width=1000;specs[1].width=1000;
const xml=`<svg><defs><font id="Test" horiz-adv-x="1000"><font-face font-family="Test" units-per-em="1000"/>${specs.map(s=>`<glyph glyph-name="${s.name}" unicode="&#x${s.code.toString(16)};"${s.width===undefined?'':` horiz-adv-x="${Number.isNaN(s.width)?'bad':s.width}"`} d="${s.d}"/>`).join('')}<glyph glyph-name="ligature" unicode="AB" horiz-adv-x="1000" d="${specs[0].d}"/></font></defs></svg>`;
const old=[];
for(const s of specs){
 const glyph={name:s.name,unicode:[s.code],d:s.d,...(s.width===undefined?{}:{width:s.width})};
 const found=_.find(old,{width:glyph.width,d:glyph.d});
 if(found)found.unicode=found.unicode.concat(glyph.unicode);else old.push(glyph);
}
const parsed=load(xml);
const simplified=parsed.glyphs.map(g=>({name:g.name,unicode:g.unicode,d:g.d,...(Object.prototype.hasOwnProperty.call(g,'width')?{width:g.width}:{})}));
assert.deepEqual(simplified,old,'indexed glyphs have identical canonical choices, width handling and Unicode order');
assert.equal(parsed.ligatures.length,1);assert.equal(parsed.ligatures[0].glyph.name,'g0','ligature resolves to first canonical glyph');
console.log('svg glyph deduplication preserves legacy first-match and ligature behavior');
