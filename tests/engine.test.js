'use strict';
const assert = require('assert');
const { buildScreenFont } = require('../src/engine');
const S = 128;
function mask(segments) {
  const a = new Uint8Array(S * S);
  for (const [x0,y0,x1,y1] of segments) {
    const n=Math.max(Math.abs(x1-x0),Math.abs(y1-y0),1);
    for(let k=0;k<=n;k++) for(let dx=-2;dx<=2;dx++) for(let dy=-2;dy<=2;dy++) {
      const x=Math.round(x0+(x1-x0)*k/n)+dx, y=Math.round(y0+(y1-y0)*k/n)+dy;
      if(x>=0&&y>=0&&x<S&&y<S) a[y*S+x]=1;
    }
  }
  return a;
}
const L=mask([[18,28,59,28],[59,28,59,95]]);
const V=mask([[92,19,92,108],[92,61,111,61]]);
function table(b, tag) {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i=0;i<d.getUint16(4);i++) {
    const p=12+i*16, name=String.fromCharCode(...b.slice(p,p+4));
    if (name===tag) return { d, offset:d.getUint32(p+8), length:d.getUint32(p+12) };
  }
  throw new Error('Missing table '+tag);
}
function names(b) {
  const {d,offset:o}=table(b,'name'), data=o+d.getUint16(o+4), out=[];
  for(let i=0;i<d.getUint16(o+2);i++) {
    const p=o+6+i*12, platform=d.getUint16(p), id=d.getUint16(p+6), len=d.getUint16(p+8), start=data+d.getUint16(p+10);
    let value='';
    for(let k=0;k<len;k+=platform===3?2:1) value+=String.fromCharCode(platform===3?d.getUint16(start+k):d.getUint8(start+k));
    out.push({platform,id,value});
  }
  return out;
}
(async () => {
  const out=await buildScreenFont([{char:'가',size:S,roles:{L,V}}], 'Guided Test');
  assert.equal(out.originalCount,1);
  assert(out.chars.includes('가'));
  assert.equal(out.sources['가'], undefined, 'direct original is not presented as a composed shape');
  assert.equal(out.sources['갸'][0], '가', 'composed lead provenance matches the captured sample');
  assert.equal(out.sources['갸'][1], null, 'unwritten derived vowel is labeled as an estimate');
  assert(out.hangulCount>0 && out.hangulCount<11172, 'partial data must not claim full coverage');
  assert.deepEqual(out.incomplete,[]);
  assert.deepEqual([...out.ttf.slice(0,4)],[0,1,0,0], 'actual TrueType binary');
  const korean=await buildScreenFont([{char:'가',size:S,roles:{L,V}}], '나만의 글씨');
  const records=names(korean.ttf), win=(id)=>records.find(r=>r.platform===3&&r.id===id).value;
  assert.equal(win(1),'나만의 글씨');
  assert.equal(win(4),'나만의 글씨');
  assert(/^Geulmoa-[a-f0-9]+$/.test(win(6)), 'PostScript name must be unique ASCII');
  assert(!records.some(r=>r.platform===1&&(r.id===1||r.id===4)), 'no garbled MacRoman Korean names');
  const post=table(korean.ttf,'post'), d=post.d, o=post.offset, count=d.getUint16(o+32);
  let max=0; for(let i=0;i<count;i++) max=Math.max(max,d.getUint16(o+34+i*2));
  let pos=o+34+count*2; for(let i=258;i<=max;i++) pos+=1+d.getUint8(pos);
  assert.equal(pos,o+post.length,'post table should not include spurious bytes');
  const hhea=table(korean.ttf,'hhea'), head=table(korean.ttf,'head');
  assert(hhea.d.getInt16(hhea.offset+4)>=head.d.getInt16(head.offset+42), 'ascent must cover font ink');
  const incomplete=await buildScreenFont([{char:'가',size:S,roles:{L}}], 'Incomplete');
  assert.equal(incomplete.originalCount,0, 'partial drawing must not replace the full syllable');
  assert(incomplete.incomplete.includes('가'));
  assert(!incomplete.chars.includes('가'));
  console.log('guided partial and TTF tests passed');
})().catch((err)=>{ console.error(err); process.exitCode=1; });
