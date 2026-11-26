'use strict';
// Run the isolated designer server on :4176, then npm run test:vector.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { buildScreenFont } = require('../src/engine');
const { topology } = require('../src/topology');
const url = process.env.APP_URL || 'http://127.0.0.1:4176/';

async function ready(page) {
  // The optional comparison no longer starts a memory-heavy worker on page load.
  await page.locator('#thickness-details').evaluate((element) => { if (!element.open) element.open = true; });
  await page.waitForFunction(() => !document.querySelector('#thickness-result').hidden || document.querySelector('#thickness-status').classList.contains('error'), null, {timeout:90000});
  const error = await page.locator('#thickness-status').getAttribute('class');
  assert(!error.includes('error'), await page.locator('#thickness-status').innerText());
}
async function setSlider(page, id, value) {
  await page.locator(id).evaluate((el, value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));},value);
}
async function alphaSums(page, chars) {
  return page.evaluate((characters) => {
    const before=document.querySelector('#thickness-before').style.fontFamily, after=document.querySelector('#thickness-after').style.fontFamily;
    const c=document.createElement('canvas');c.width=c.height=280;const ctx=c.getContext('2d',{willReadFrequently:true});
    function draw(ch,fam) {ctx.clearRect(0,0,280,280);ctx.font=`200px ${fam}`;ctx.textBaseline='alphabetic';ctx.fillStyle='#000';ctx.fillText(ch,20,225);const d=ctx.getImageData(0,0,280,280).data;const a=new Uint8Array(280*280);let sum=0;for(let i=0;i<a.length;i++){a[i]=d[4*i+3];sum+=a[i]}return {a,sum}}
    return characters.map(ch=>{const a=draw(ch,before),b=draw(ch,after);let different=0;for(let i=0;i<a.a.length;i++) if(a.a[i]!==b.a[i])different++;return {char:ch,before:a.sum,after:b.sum,different}});
  },chars);
}
async function assertCounters(page) {
  const chars=['성','공','강','궁'];
  const masks=await page.evaluate(chars=>{
    const fs=[document.querySelector('#thickness-before').style.fontFamily,document.querySelector('#thickness-after').style.fontFamily];
    const c=document.createElement('canvas');c.width=c.height=280;const x=c.getContext('2d',{willReadFrequently:true});
    return chars.map(ch=>fs.map(f=>{x.clearRect(0,0,280,280);x.font=`200px ${f}`;x.textBaseline='alphabetic';x.fillText(ch,20,225);const d=x.getImageData(0,0,280,280).data;let a=[];for(let i=0;i<280*280;i++)a.push(d[4*i+3]>=128?1:0);return a}));
  },chars);
  for(let i=0;i<chars.length;i++){
    const a=topology(Uint8Array.from(masks[i][0]),280,280),b=topology(Uint8Array.from(masks[i][1]),280,280);
    assert(a.holes>=1,`${chars[i]} has an ㅇ counter`);assert.deepEqual(a,b,`${chars[i]} retains its counter and disconnected parts in this example`);
  }
}
function stateFixture() {
  function make(char, roles) {
    const strokes=Object.entries(roles).flatMap(([role,ps])=>ps.map(points=>({role,points})));
    return [char,{version:2,actions:[...strokes.map(({points})=>({kind:'ink',points})),...strokes.map(({role,points})=>({kind:'paint',role,points,width:.12}))]}];
  }
  const samples=Object.fromEntries([
    make('가',{L:[[[.14,.24],[.44,.24],[.44,.68]]],V:[[[.69,.15],[.69,.78]],[[.69,.46],[.82,.46]]]}),
    make('각',{L:[[[.23,.19],[.48,.19],[.48,.49]]],V:[[[.69,.14],[.69,.52]],[[.69,.37],[.78,.37]]],T:[[[.23,.72],[.73,.72],[.73,.84]]]})
  ]);
  samples['국']={version:2,actions:[{kind:'ink',points:[[.3,.2],[.6,.2],[.6,.4]]}]};
  return {samples,custom:['국'],current:'가',fontName:'Mine',preview:'가 각'};
}
async function stroke(page, points) {
  const pad=page.locator('#pad');await pad.scrollIntoViewIfNeeded();const b=await pad.boundingBox();
  const pos=([x,y])=>[b.x+b.width*x,b.y+b.height*y];await page.mouse.move(...pos(points[0]));await page.mouse.down();
  for(const p of points.slice(1)) await page.mouse.move(...pos(p),{steps:10});await page.mouse.up();
}

// Deliberately divide one continuous line by color, both along its length and
// across its width. The latter cannot be faithfully recovered from the line's
// center and must be kept as the original outline instead of guessing a role.
async function runSplitProbe(page, acrossWidth) {
  return page.evaluate(async (acrossWidth)=>{
    const size=256,c=document.createElement('canvas');c.width=c.height=size;const ctx=c.getContext('2d',{willReadFrequently:true});
    const points=[[.20,.5],[.80,.5]];window.GeulmoaColoring.drawPath(ctx,points,size,.03,'#000');
    const rgba=ctx.getImageData(0,0,size,size).data,L=new Uint8Array(size*size),V=new Uint8Array(size*size);
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){const p=y*size+x;if(rgba[4*p+3]>=100){if(acrossWidth?y<128:x<128)L[p]=1;else V[p]=1}}
    const w=new Worker('vector-worker.js');return await new Promise((resolve,reject)=>{
      w.onmessage=({data})=>{if(data.type==='done'){w.terminate();resolve(data.stats)}if(data.type==='error'){w.terminate();reject(new Error(data.message))}};
      w.onerror=e=>{w.terminate();reject(new Error(e.message))};
      w.postMessage({samples:[{char:'가',size,roles:{L:L.buffer,V:V.buffer},strokes:[{points}]}],strength:1,targetRatio:1,requested:'갸'});
    });
  },acrossWidth);
}
async function runWidthProbe(page) {
  return page.evaluate(async () => {
    const size=256;
    function sample(char, left, right, y1, y2) {
      const c=document.createElement('canvas');c.width=c.height=size;const ctx=c.getContext('2d',{willReadFrequently:true}),roles={},strokes=[];
      for(const [role,y] of [['L',y1],['V',y2]]){
        const points=[[left,y],[right,y]];ctx.clearRect(0,0,size,size);window.GeulmoaColoring.drawPath(ctx,points,size,.03,'#000');
        const rgba=ctx.getImageData(0,0,size,size).data,mask=new Uint8Array(size*size);
        for(let i=0;i<mask.length;i++)if(rgba[4*i+3]>=100)mask[i]=1;
        roles[role]=mask.buffer;strokes.push({points});
      }
      return {char,size,roles,strokes};
    }
    const samples=[sample('가',.35,.65,.38,.62),sample('고',.15,.85,.28,.72)],w=new Worker('vector-worker.js');
    const data=await new Promise((resolve,reject)=>{w.onmessage=({data})=>{if(data.type==='done'){w.terminate();resolve(data)}if(data.type==='error'){w.terminate();reject(new Error(data.message))}};
      w.onerror=e=>{w.terminate();reject(new Error(e.message))};w.postMessage({samples,strength:1,targetRatio:1,requested:''});});
    const faces=await Promise.all([new FontFace('ProbeBefore',data.before).load(),new FontFace('ProbeAfter',data.after).load()]);faces.forEach(f=>document.fonts.add(f));
    const canvas=document.createElement('canvas');canvas.width=720;canvas.height=720;const ctx=canvas.getContext('2d',{willReadFrequently:true});
    function runs(char,family){ctx.clearRect(0,0,720,720);ctx.font=`640px ${family}`;ctx.textBaseline='alphabetic';ctx.fillText(char,20,640);
      const pix=ctx.getImageData(340,0,1,720).data, result=[];let n=0;for(let y=0;y<720;y++){if(pix[4*y+3]>=128)n++;else if(n){result.push(n);n=0}}if(n)result.push(n);return result;}
    const before=[runs('가','ProbeBefore'),runs('고','ProbeBefore')],after=[runs('가','ProbeAfter'),runs('고','ProbeAfter')];faces.forEach(f=>document.fonts.delete(f));
    return {target:data.target,before,after};
  });
}
async function runMergeWarningProbe(page) {
  return page.evaluate(async () => {
    const size=256;
    function sample(char, lines) {
      const c=document.createElement('canvas');c.width=c.height=size;const ctx=c.getContext('2d',{willReadFrequently:true}),roles={},strokes=[];
      for(const [role,points] of Object.entries(lines)){
        ctx.clearRect(0,0,size,size);window.GeulmoaColoring.drawPath(ctx,points,size,.03,'#000');
        const rgba=ctx.getImageData(0,0,size,size).data,mask=new Uint8Array(size*size);
        for(let i=0;i<mask.length;i++)if(rgba[i*4+3]>=100)mask[i]=1;
        roles[role]=mask.buffer;strokes.push({points});
      }
      return {char,size,roles,strokes};
    }
    const samples=[sample('가',{L:[[.2,.48],[.8,.48]],V:[[.2,.53],[.8,.53]]}),
      sample('고',{L:[[.46,.46],[.54,.46]],V:[[.46,.54],[.54,.54]]})];
    const w=new Worker('vector-worker.js');return await new Promise((resolve,reject)=>{
      w.onmessage=({data})=>{if(data.type==='done'){w.terminate();resolve(data.stats)}if(data.type==='error'){w.terminate();reject(new Error(data.message))}};
      w.onerror=e=>{w.terminate();reject(new Error(e.message))};w.postMessage({samples,strength:1,targetRatio:1.3,requested:''});
    });
  });
}
let browser;
(async()=>{
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  await page.addInitScript(()=>{
    const post=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(message,transfer){
      if(typeof message.targetRatio==='number'){
        window.__vectorJob=message;
        this.addEventListener('message',({data})=>{if(data.type==='done')window.__vectorResult={target:data.target,stats:data.stats}});
      }
      return post.call(this,message,transfer);
    };
  });
  const start=Date.now();await page.goto(url,{waitUntil:'domcontentloaded'});await ready(page);
  const demoMs=Date.now()-start;
  assert.equal(await page.locator('.lab-glyph[data-kind="original"]').count(),6);
  assert.equal(await page.locator('.lab-glyph[data-kind="composed"]').count(),10);
  assert.equal(await page.locator('.lab-glyph[data-kind="original"][data-adjusted="true"]').count(),6);
  assert.equal(await page.locator('.lab-glyph[data-char="구"]').getAttribute('data-fallback'),'false');
  assert.equal(await page.locator('.lab-glyph[data-char="갸"]').getAttribute('data-fallback'),'true');
  const info=await page.evaluate(()=>window.__vectorResult);
  for(const g of info.stats)for(const s of g.steps)if(s.method==='vector')assert(Math.abs(s.after-info.target)<1e-7,`fixed target for ${g.char} ${s.role}`);
  const measurements=await alphaSums(page,['가','각','곡']);
  assert(measurements[0].after<measurements[0].before,'small original becomes thinner');
  assert(measurements[1].after>measurements[1].before,'large original becomes thicker');
  assert(measurements[2].different>0,'composed glyph actually uses adjusted path');
  await assertCounters(page);
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#thickness-download-after').click()]);
  assert.equal(download.suggestedFilename(),'geulmoa-path-after.ttf');
  const fs=require('node:fs'),bytes=fs.readFileSync(await download.path());assert.deepEqual([...bytes.slice(0,4)],[0,1,0,0]);

  const wire=await page.evaluate(()=>window.__vectorJob.samples.map(s=>({char:s.char,size:s.size,roles:Object.fromEntries(Object.entries(s.roles).map(([k,v])=>[k,Array.from(new Uint8Array(v))]))})));
  const samples=wire.map(s=>({...s,roles:Object.fromEntries(Object.entries(s.roles).map(([k,v])=>[k,Uint8Array.from(v)]))}));
  const normal=await buildScreenFont(samples,'Normal Baseline');
  const chars=await page.locator('.lab-glyph').evaluateAll(xs=>xs.map(x=>x.dataset.char));
  const mismatch=await page.evaluate(async ({base64,chars})=>{
    const f=await new FontFace('NormalOriginal',Uint8Array.from(atob(base64),c=>c.charCodeAt(0))).load();document.fonts.add(f);
    const base=document.querySelector('#thickness-before').style.fontFamily,c=document.createElement('canvas');c.width=c.height=280;const ctx=c.getContext('2d',{willReadFrequently:true});
    function draw(ch,f){ctx.clearRect(0,0,280,280);ctx.font=`200px ${f}`;ctx.fillText(ch,20,225);return ctx.getImageData(0,0,280,280).data}
    return chars.filter(ch=>{let a=draw(ch,base),b=draw(ch,'NormalOriginal');for(let i=3;i<a.length;i+=4)if(a[i]!==b[i])return true;return false});
  },{base64:Buffer.from(normal.ttf).toString('base64'),chars});
  assert.deepEqual(mismatch,[],'before font matches the existing generator for originals and combinations');
  console.log(`demo ${chars.length} glyphs: centerline fixed widths, source fallback, original baseline parity and ㅇ counters passed (${demoMs}ms)`);

  await setSlider(page,'#thickness-target',70);assert.match(await page.locator('#thickness-status').innerText(),/설정이 바뀌었어요/);
  await page.locator('#thickness-run').click();await ready(page);const thin=(await alphaSums(page,['가']))[0].after;
  const thinTarget=await page.evaluate(()=>window.__vectorResult.target);
  await setSlider(page,'#thickness-target',130);await page.locator('#thickness-run').click();await ready(page);
  const thick=(await alphaSums(page,['가']))[0].after,thickTarget=await page.evaluate(()=>window.__vectorResult.target);
  assert(thickTarget>thinTarget && thick>thin,'target slider changes the actual rendered strokes');
  await setSlider(page,'#thickness-strength',0);await page.locator('#thickness-run').click();await ready(page);
  assert((await alphaSums(page,['가','각','곡','갸'])).every(v=>v.different===0),'0% is exactly the existing rendered font');
  assert.equal(await page.locator('.lab-glyph[data-adjusted="true"]').count(),0);
  await page.locator('#thickness-text').fill('가힣');assert.match(await page.locator('#thickness-fallback').innerText(),/힣/);
  console.log('target thickness, 0% off, missing-glyph indication passed');

  const along=await runSplitProbe(page,false),across=await runSplitProbe(page,true);
  assert.equal(along.find(g=>g.char==='갸').steps.find(s=>s.role==='L').method,'vector','same stroke split by manual color along its length');
  assert.equal(across.find(g=>g.char==='갸').steps.find(s=>s.role==='L').method,'fallback','unrepresentable painted region must be preserved as outline');
  console.log('manual split: connected path follows paint; ambiguous partial-width coloring falls back instead of guessing');
  const widthProbe=await runWidthProbe(page);
  assert(widthProbe.before.every(r=>r.length===2) && widthProbe.after.every(r=>r.length===2),`two separate test strokes: ${JSON.stringify(widthProbe)}`);
  assert(widthProbe.before[0][0]>widthProbe.before[1][0]+10,`different original scales: ${JSON.stringify(widthProbe)}`);
  assert(Math.abs(widthProbe.after[0][0]-widthProbe.after[1][0])<=2,`font-rendered stroke widths match: ${JSON.stringify(widthProbe)}`);
  assert(Math.abs(widthProbe.after[0][0]-widthProbe.target*.64)<=3,`font stroke width matches target: ${JSON.stringify(widthProbe)}`);
  console.log('fixed width verified in actual TTF rendering across different source scales');
  const merged=await runMergeWarningProbe(page);
  assert(merged.find(g=>g.char==='가').warning,'a widened stroke that merges two components must be flagged');
  console.log('visible warning when wider vector strokes merge passed');

  const saved=stateFixture(), prior=await page.evaluate(()=>localStorage.getItem('geulmoa-drawing-v1'));
  await page.locator('.lab-import summary').click();await page.locator('#thickness-import-data').fill(JSON.stringify(saved));await page.locator('#thickness-import').click();await ready(page);
  assert.equal(await page.locator('.lab-glyph[data-kind="original"]').count(),2);assert.match(await page.locator('#thickness-status').innerText(),/국/);
  assert(await page.evaluate(()=>window.__vectorJob.samples.every(s=>Array.isArray(s.strokes)&&s.strokes.length>0)));
  assert.equal(await page.evaluate(()=>localStorage.getItem('geulmoa-drawing-v1')),prior,'pasted data is not stored');
  await page.evaluate(s=>localStorage.setItem('geulmoa-drawing-v1',JSON.stringify(s)),saved);await page.reload({waitUntil:'domcontentloaded'});await ready(page);
  await page.locator('#thickness-mine').click();await ready(page);
  assert.equal(await page.locator('.lab-glyph[data-kind="original"]').count(),2);assert.match(await page.locator('#thickness-status').innerText(),/국/);
  console.log('import and local samples: original trajectories included; incomplete work excluded; no overwrite passed');
  assert.deepEqual(errors,[]);await page.close();

  const drawing=await browser.newPage({viewport:{width:1440,height:1000}});
  await drawing.addInitScript(()=>{const p=Worker.prototype.postMessage;Worker.prototype.postMessage=function(m,t){if(typeof m.targetRatio==='number')window.__vectorJob=m;return p.call(this,m,t)}});
  await drawing.goto(url,{waitUntil:'domcontentloaded'});await ready(drawing);
  await drawing.locator('.sample-chip',{hasText:'가'}).first().click();
  await drawing.locator('#start-writing').click();
  await stroke(drawing,[[.19,.26],[.49,.26],[.49,.70],[.49,.50],[.69,.50],[.69,.20],[.69,.78]]);
  await drawing.locator('#next-step').click();await stroke(drawing,[[.19,.26],[.49,.26],[.49,.70]]);
  await drawing.locator('#next-step').click();await stroke(drawing,[[.49,.50],[.69,.50],[.69,.20],[.69,.78]]);
  assert.match(await drawing.locator('#paint-status').innerText(),/모든 획을 자모별로 나눴어요/);
  await drawing.locator('#capture-close').click();
  await drawing.locator('#thickness-requested').fill('갸');await drawing.locator('#thickness-mine').click();await ready(drawing);
  assert.equal(await drawing.locator('.lab-glyph[data-char="가"]').getAttribute('data-adjusted'),'true');
  const capture=await drawing.evaluate(()=>window.__vectorJob.samples.find(s=>s.char==='가'));
  assert.equal(capture.strokes.length,1,'one continuous handwritten path is sent as one path, not forcibly split by role');
  assert(capture.strokes[0].points.length>5,'the actual pointer path is retained');
  console.log('actual browser draw → manual color → stored trajectory → vector comparison passed');
  await drawing.close();

  const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});
  const mobileErrors=[];mobile.on('pageerror',e=>mobileErrors.push(e.message));await mobile.goto(url,{waitUntil:'domcontentloaded'});await ready(mobile);
  const size=await mobile.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
  assert(size.scroll<=size.client+1,`mobile overflow ${JSON.stringify(size)}`);assert.deepEqual(mobileErrors,[]);await mobile.close();
  console.log('mobile preview passed');await browser.close();
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1});
