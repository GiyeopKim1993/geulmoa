'use strict';
// Cross-browser, no-scroll modal regression. Inputs are simulated; physical
// phones, pens and assistive technologies still require hands-on testing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { chromium, firefox, webkit } = require('playwright');
const name = process.env.TEST_BROWSER || 'chromium';
const engine = { chromium, firefox, webkit }[name];
if (!engine) throw new Error(`Unknown TEST_BROWSER: ${name}`);
const url = process.env.APP_URL || 'http://127.0.0.1:4176/';
const out = process.env.MODAL_TEST_DIR || path.join(os.tmpdir(), `geulmoa-modal-tests-${name}`);
fs.mkdirSync(out, { recursive:true });
const KEY = 'geulmoa-drawing-v1';
const paths = {
  lead:[[.20,.15],[.20,.34],[.67,.34]],
  vowel:[[.16,.50],[.82,.50]],
  final:[[.24,.65],[.24,.83],[.72,.83]],
};
const ga = { lead:[[.18,.2],[.49,.2],[.49,.65]], vowel:[[.7,.16],[.7,.76]] };
const roles = { draw:'modal-write', L:'modal-lead', V:'modal-vowel', T:'modal-final' };

async function frames(page) { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }
async function saved(page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY); }
async function synthetic(page, points, type='touch') {
  await page.locator('#pad').evaluate((canvas, {points,type}) => {
    const r=canvas.getBoundingClientRect();
    points.forEach(([x,y],i)=>canvas.dispatchEvent(new PointerEvent(i===0?'pointerdown':i===points.length-1?'pointerup':'pointermove',{
      bubbles:true,cancelable:true,pointerId:27,pointerType:type,isPrimary:true,button:0,clientX:r.x+x*r.width,clientY:r.y+y*r.height
    })));
  }, {points,type});
}
async function mouseStroke(page, points) {
  const r=await page.locator('#pad').boundingBox();
  const xy=([x,y])=>[r.x+x*r.width,r.y+y*r.height];
  await page.mouse.move(...xy(points[0])); await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...xy(p),{steps:12});
  await page.mouse.up();
}
async function touchCDP(page, points) {
  const session=await page.context().newCDPSession(page),r=await page.locator('#pad').boundingBox();
  const xy=([x,y])=>({x:r.x+x*r.width,y:r.y+y*r.height});
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[xy(points[0])]});
  for (let k=1;k<points.length;k++) for(let i=1;i<=8;i++) {
    const t=i/8, p=[points[k-1][0]*(1-t)+points[k][0]*t,points[k-1][1]*(1-t)+points[k][1]*t];
    await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[xy(p)]});
  }
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await session.detach();
}
async function pick(page,ch) {
  await page.locator('.sample-chip').filter({hasText:ch}).first().click();
}
async function checkStage(page,stage,where) {
  await frames(page);
  const data=await page.evaluate(() => {
    const dialogs=[...document.querySelectorAll('.capture-dialog[open]')],d=dialogs[0],e=d?.querySelector('.capture-editor');
    if(!d||!e)return {dialogs:dialogs.map(x=>x.id)};
    const main=d.querySelector('.capture-main'),side=d.querySelector('.capture-side'),footer=d.querySelector('.capture-footer');
    const dr=d.getBoundingClientRect(),mr=main.getBoundingClientRect(),fr=footer.getBoundingClientRect();
    const fit=(x)=>({sw:x.scrollWidth,cw:x.clientWidth,sh:x.scrollHeight,ch:x.clientHeight,top:x.scrollTop,left:x.scrollLeft});
    const selectors=['#capture-modal-title','#capture-modal-description','#capture-close','#capture-phase-nav','#board','#pad','#paint-controls','#brush-size','#paint-erase','#paint-status','#clear-colors','#undo','#clear-char','#draw-message','#capture-confirm','#capture-confirm-message','#capture-confirm-cancel','#capture-confirm-accept','#prev-char','#skip-char','#modal-back','#next-step','#modal-storage-warning','.phase-step'];
    const out=[];for(const selector of selectors)for(const el of d.querySelectorAll(selector)){
      if(el.hidden||el.closest('[hidden]')||!el.getClientRects().length)continue;
      const r=el.getBoundingClientRect();
      if(r.top<dr.top-1||r.bottom>dr.bottom+1||r.left<dr.left-1||r.right>dr.right+1)out.push({selector,box:[r.left,r.top,r.right,r.bottom],dialog:[dr.left,dr.top,dr.right,dr.bottom]});
      if((el.matches('button')||el.matches('input')||el.id==='capture-modal-title') && el.scrollWidth>el.clientWidth+1)out.push({selector,horizontalTextOverflow:[el.scrollWidth,el.clientWidth]});
    }
    return {dialogs:dialogs.map(x=>x.id),stage:e.dataset.stage,label:d.getAttribute('aria-labelledby'),
      described:d.getAttribute('aria-describedby'),hasLabel:!!d.querySelector('#'+d.getAttribute('aria-labelledby')),
      bounds:[dr.left,dr.top,dr.right,dr.bottom],viewport:[innerWidth,innerHeight],
      dialog:fit(d),editor:fit(e),main:fit(main),side:fit(side),board:fit(d.querySelector('#board')),
      mainBottom:mr.bottom,footerTop:fr.top,out,htmlOverflow:document.documentElement.style.overflow,
      bodyPosition:document.body.style.position,focusedInside:d.contains(document.activeElement),
      phaseCurrent:d.querySelector('.phase-step[aria-current="step"]')?.dataset.stage};
  });
  assert.deepEqual(data.dialogs,[roles[stage]],`${where}: exactly the expected separate dialog opens: ${JSON.stringify(data)}`);
  assert.equal(data.stage,stage,where);assert.equal(data.phaseCurrent,stage,where);
  assert(data.hasLabel && data.label==='capture-modal-title' && data.described==='capture-modal-description',`${where}: accessible label`);
  assert(data.focusedInside,`${where}: focus remains in modal`);
  assert.equal(data.htmlOverflow,'hidden',`${where}: background scroll locked`);assert.equal(data.bodyPosition,'fixed',where);
  assert(data.bounds[0]>=-1&&data.bounds[1]>=-1&&data.bounds[2]<=data.viewport[0]+1&&data.bounds[3]<=data.viewport[1]+1,`${where}: popup fits the viewport ${JSON.stringify(data)}`);
  for(const key of ['dialog','editor','main','side']){
    const box=data[key];assert(box.sw<=box.cw+1&&box.sh<=box.ch+1,`${where}: ${key} is not clipped or scrollable: ${JSON.stringify(data)}`);
    assert.equal(box.top,0,`${where}: ${key} scrollTop`);assert.equal(box.left,0,`${where}: ${key} scrollLeft`);
  }
  assert(data.mainBottom<=data.footerTop+1,`${where}: main controls do not overlap footer`);
  assert(data.board.cw>=100&&Math.abs(data.board.cw-data.board.ch)<=1,`${where}: board remains usable and square ${JSON.stringify(data.board)}`);
  assert.deepEqual(data.out,[],`${where}: all controls fit ${JSON.stringify(data.out)}`);
}
async function stableInputAfterMessage(page) {
  // A validation message should not disappear on pointerdown: that would
  // reflow the board while a finger is still drawing and skew its points.
  const canvas=page.locator('#pad'),before=await canvas.boundingBox();
  await canvas.evaluate(c=>{const r=c.getBoundingClientRect();c.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:55,pointerType:'touch',isPrimary:true,clientX:r.x+.20*r.width,clientY:r.y+.15*r.height}));});
  await frames(page);const during=await canvas.boundingBox();
  for(const prop of ['x','y','width','height'])assert(Math.abs(before[prop]-during[prop])<1,`canvas moved while drawing: ${prop} ${JSON.stringify({before,during})}`);
  assert((await page.locator('#draw-message').innerText()).length>0,'message remains while pointer is down');
  await canvas.evaluate(c=>{const r=c.getBoundingClientRect();for(const [type,x,y] of [['pointermove',.20,.34],['pointerup',.67,.34]])c.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:55,pointerType:'touch',isPrimary:true,clientX:r.x+x*r.width,clientY:r.y+y*r.height}));});
}
async function layoutMatrix(browser) {
  const viewports=[{width:320,height:480},{width:320,height:568},{width:360,height:640},{width:390,height:844},
    {width:768,height:1024},{width:1440,height:900},{width:844,height:390},{width:568,height:320}];
  for (const v of viewports) {
    const ctx=await browser.newContext({viewport:v,hasTouch:true,...(name!=='firefox'&&v.width<600?{isMobile:true}:{} )});
    const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    // Check even the less spacious error state with storage blocked.
    await page.addInitScript(()=>Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('denied','SecurityError')}}));
    await page.goto(url);await page.locator('#start-writing').scrollIntoViewIfNeeded();
    await page.evaluate(()=>{document.documentElement.style.scrollBehavior='auto'});
    const y=await page.evaluate(()=>window.scrollY);assert(y>0,'start from a scrolled position');
    await page.locator('#start-writing').click();
    await checkStage(page,'draw',`${name} ${v.width}x${v.height} writing`);
    assert(await page.locator('#modal-storage-warning').isVisible());
    assert(await page.locator('.phase-step[data-stage="L"]').isDisabled());
    await page.locator('#next-step').click();assert.match(await page.locator('#draw-message').innerText(),/먼저 글자/);
    await checkStage(page,'draw',`${name} ${v.width}x${v.height} empty error`);
    await stableInputAfterMessage(page);await synthetic(page,paths.vowel);await synthetic(page,paths.final);
    await page.locator('#next-step').click();await checkStage(page,'L',`${name} ${v.width}x${v.height} lead`);
    await page.locator('#next-step').click();assert.match(await page.locator('#draw-message').innerText(),/초성.*먼저/);
    await checkStage(page,'L',`${name} ${v.width}x${v.height} lead error`);
    await synthetic(page,paths.lead);await page.locator('#next-step').click();await checkStage(page,'V',`${name} ${v.width}x${v.height} vowel`);
    await synthetic(page,paths.vowel);await page.locator('#next-step').click();await checkStage(page,'T',`${name} ${v.width}x${v.height} final`);
    await page.locator('#next-step').click();assert.match(await page.locator('#draw-message').innerText(),/종성.*먼저/);
    await checkStage(page,'T',`${name} ${v.width}x${v.height} final error`);
    await synthetic(page,paths.final);assert.match(await page.locator('#paint-status').innerText(),/모든 획을 자모별로 나눴어요/);
    await page.locator('#paint-erase').click();await synthetic(page,[[.28,.34],[.34,.34]]);
    await page.locator('#next-step').click();assert.match(await page.locator('#draw-message').innerText(),/남은 획/);
    await checkStage(page,'T',`${name} ${v.width}x${v.height} unpainted error`);
    await page.locator('#undo').click();assert.match(await page.locator('#paint-status').innerText(),/모든 획을 자모별로 나눴어요/);
    await page.locator('#clear-colors').click();assert(await page.locator('#capture-confirm').isVisible());
    await checkStage(page,'T',`${name} ${v.width}x${v.height} clear confirmation`);
    await page.locator('#capture-confirm-cancel').click();assert.match(await page.locator('#paint-status').innerText(),/모든 획을 자모별로 나눴어요/);
    const locked=await page.evaluate(()=>({y:scrollY,top:document.body.style.top}));
    // Playwright's mobile WebKit does not implement mouse.wheel; a real tap
    // on the backdrop plus the locked overflow/fixed-position checks above
    // cover that mode. Desktop engines also get an actual wheel gesture.
    if(name==='webkit' && v.width<600) await page.touchscreen.tap(2,2);
    else { await page.mouse.move(v.width/2,v.height/2);await page.mouse.wheel(0,1000); }
    await page.waitForTimeout(50);
    assert.deepEqual(await page.evaluate(()=>({y:scrollY,top:document.body.style.top})),locked,`${name}: background remains locked`);
    await checkStage(page,'T',`${name} ${v.width}x${v.height} after wheel`);
    await page.locator('#capture-close').click();assert.equal(await page.locator('.capture-dialog[open]').count(),0);
    assert(Math.abs((await page.evaluate(()=>scrollY))-y)<=2,`${name}: close restores page position`);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'start-writing','focus returns to opener');
    assert.deepEqual(errors,[]);await ctx.close();console.log(`${name} ${v.width}x${v.height}: all four separate, viewport-fitting modals; warning, validation and scroll lock passed`);
  }
}
async function workflow(browser) {
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,acceptDownloads:true,...(name!=='firefox'?{isMobile:true}:{})});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);
  await page.locator('#hero-start').click();assert.equal(await page.locator('.capture-dialog[open]').getAttribute('id'),'modal-write');
  if(name==='chromium') {
    const cd=await context.newCDPSession(page), locked=await page.evaluate(()=>({y:scrollY,top:document.body.style.top}));
    await cd.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:2,y:550}]});
    for(const y of [500,440,380,320,260]) await cd.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:2,y}]});
    await cd.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cd.detach();
    assert.deepEqual(await page.evaluate(()=>({y:scrollY,top:document.body.style.top})),locked,'simulated touch swipe cannot scroll the backdrop');
  }
  await page.evaluate(()=>window.__originalCanvas=document.querySelector('#pad'));
  assert.equal(await page.evaluate(()=>document.activeElement.id),'capture-modal-title');
  for(let i=0;i<10;i++){await page.keyboard.press(i===7?'Shift+Tab':'Tab');assert(await page.evaluate(()=>document.querySelector('.capture-dialog[open]').contains(document.activeElement)),'Tab focus stays in modal');}
  await page.evaluate(()=>document.querySelector('#font-name').focus());assert(await page.evaluate(()=>document.querySelector('.capture-dialog[open]').contains(document.activeElement)),'background cannot receive focus');
  if(name==='chromium')await touchCDP(page,paths.lead);else await synthetic(page,paths.lead);
  await synthetic(page,paths.vowel);await synthetic(page,paths.final);
  let before=await saved(page);assert.equal(before.samples.는.actions.length,3);
  assert.equal(before.samples.는.actions[0].device,'touch');
  await page.locator('#next-step').click();
  if(name==='chromium')await touchCDP(page,paths.lead);else await synthetic(page,paths.lead);
  before=await saved(page);assert.deepEqual(before.samples.는.actions.map(a=>a.kind),['ink','ink','ink','paint']);
  await page.locator('#pad').evaluate(c=>{window.__leadPixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data});
  await page.locator('#next-step').click();assert.equal(await page.locator('.capture-dialog[open]').getAttribute('id'),'modal-vowel');
  assert(await page.evaluate(()=>window.__originalCanvas===document.querySelector('#pad')),'one real canvas is retained');
  const changed=await page.locator('#pad').evaluate(c=>{const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data,b=window.__leadPixels;let n=0;for(let i=0;i<p.length;i+=4)if(p[i]!==b[i]||p[i+1]!==b[i+1]||p[i+2]!==b[i+2]||p[i+3]!==b[i+3])n++;return n});
  // WebKit can introduce a few noisy pixels when reading a canvas; thousands
  // of changed pixels would mean the real painting was lost on reparenting.
  assert(changed<40,`paint survives stage switch: ${changed} changed pixels`);
  const beforeResize=(await saved(page)).samples.는;
  await page.setViewportSize({width:844,height:390});await checkStage(page,'V',`${name} rotated landscape`);
  await page.setViewportSize({width:390,height:844});await checkStage(page,'V',`${name} rotated portrait`);
  assert.deepEqual((await saved(page)).samples.는,beforeResize,'rotation preserves ink and colors');
  await page.locator('#modal-back').click();assert.equal(await page.locator('.capture-dialog[open]').getAttribute('id'),'modal-lead');
  await page.keyboard.press('Escape');assert.equal(await page.locator('.capture-dialog[open]').count(),0);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'hero-start');
  assert.deepEqual((await saved(page)).samples.는,before.samples.는,'close retains incomplete work');
  await page.reload();assert.match(await page.locator('#landing-state').innerText(),/작성 중/);
  await page.locator('#start-writing').click();assert.equal(await page.locator('.capture-dialog[open]').getAttribute('id'),'modal-write');
  await page.locator('.phase-step[data-stage="L"]').click();assert.match(await page.locator('#paint-status').innerText(),/중성·종성 필요/);
  await page.locator('#next-step').click();await synthetic(page,paths.vowel);await page.locator('#next-step').click();await synthetic(page,paths.final);
  assert.match(await page.locator('#paint-status').innerText(),/모든 획을 자모별로 나눴어요/);
  await page.locator('#next-step').click();assert.equal(await page.locator('.capture-dialog[open]').getAttribute('id'),'modal-write');
  assert.equal(await page.locator('#modal-target-char').innerText(),'성');
  await page.locator('#prev-char').click();assert.equal(await page.locator('#modal-target-char').innerText(),'는');
  await page.locator('#capture-close').click();assert.match(await page.locator('#landing-state').innerText(),/작성한 글자/);
  // Reopening an already complete drawing opens writing, with all paint intact.
  const complete=(await saved(page)).samples.는;await page.locator('#start-writing').click();
  assert.equal(await page.locator('.capture-dialog[open]').getAttribute('id'),'modal-write');
  await page.locator('.phase-step[data-stage="T"]').click();assert.match(await page.locator('#paint-status').innerText(),/모든 획을 자모별로 나눴어요/);
  assert.deepEqual((await saved(page)).samples.는,complete);await page.locator('#capture-close').click();

  await pick(page,'가');await page.locator('#start-writing').click();
  await mouseStroke(page,ga.lead);await mouseStroke(page,ga.vowel);await page.locator('#next-step').click();await mouseStroke(page,ga.lead);
  await page.locator('#next-step').click();await mouseStroke(page,ga.vowel);
  assert.equal(await page.locator('.phase-step').count(),3,'no 종성 for a syllable without 받침');
  assert.equal(await page.locator('.phase-step[data-stage="T"]').count(),0);
  assert.match(await page.locator('#paint-status').innerText(),/모든 획을 자모별로 나눴어요/);
  await page.locator('#next-step').click();assert.equal(await page.locator('.capture-dialog[open]').getAttribute('id'),'modal-write');
  assert.equal(await page.locator('#modal-target-char').innerText(),'거');await page.locator('#capture-close').click();

  await pick(page,'0');await page.locator('#start-writing').click();assert.equal(await page.locator('.phase-step').count(),1);
  await synthetic(page,[[.5,.2],[.25,.3],[.22,.65],[.5,.8],[.78,.65],[.75,.3],[.5,.2]]);
  await page.locator('#next-step').click();assert.equal(await page.locator('#modal-target-char').innerText(),'1');
  assert.equal(await page.locator('.capture-dialog[open]').getAttribute('id'),'modal-write');
  assert((await saved(page)).samples['0'].actions.every(a=>a.kind==='ink'),'literal needs no paint');
  // Escape in the middle of a gesture saves even the not-yet-finished point.
  await page.locator('#pad').evaluate(c=>{const r=c.getBoundingClientRect();c.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:42,pointerType:'pen',isPrimary:true,clientX:r.x+.5*r.width,clientY:r.y+.4*r.height}));});
  await page.keyboard.press('Escape');assert.equal((await saved(page)).samples['1'].actions.length,1);
  await page.locator('#start-writing').click();await page.locator('#clear-char').click();
  assert.match(await page.locator('#capture-confirm-message').innerText(),/획과 색칠을 모두/);
  await page.keyboard.press('Escape');assert(await page.locator('#capture-confirm').isHidden());
  assert(await page.locator('#modal-write').evaluate(e=>e.open),'Escape cancels confirmation before closing the editor');
  assert.equal((await saved(page)).samples['1'].actions.length,1);
  await page.locator('#clear-char').click();await page.locator('#capture-confirm-accept').click();
  assert.equal((await saved(page)).samples['1'].actions.length,0);assert(await page.locator('#modal-write').evaluate(e=>e.open));
  await page.locator('#capture-close').click();

  await pick(page,')');await page.locator('#start-writing').click();await mouseStroke(page,[[.45,.2],[.65,.5],[.45,.8]]);
  assert.match(await page.locator('#next-step').innerText(),/미리보기/);await page.locator('#next-step').click();
  assert.equal(await page.locator('.capture-dialog[open]').count(),0,'last character closes modal and moves to preview');
  await page.locator('#build-font').click();
  await page.waitForFunction(()=>!document.querySelector('#build-font').disabled&&(!document.querySelector('#download-font').hidden||document.querySelector('#build-status').classList.contains('error')),null,{timeout:120000});
  assert(!await page.locator('#build-status').evaluate(e=>e.classList.contains('error')),await page.locator('#build-status').innerText());
  const [dl]=await Promise.all([page.waitForEvent('download'),page.locator('#download-font').click()]);
  const file=path.join(out,`${name}-modal.ttf`);await dl.saveAs(file);assert.deepEqual([...fs.readFileSync(file).subarray(0,4)],[0,1,0,0]);
  const py="from fontTools.ttLib import TTFont\nimport sys\nf=TTFont(sys.argv[1]); c=f.getBestCmap()\nfor ch in '는가0)':\n assert ord(ch) in c, ch\n assert f['glyf'][c[ord(ch)]].numberOfContours != 0, ch\nprint('verified modal-entered Hangul and literal outlines in downloaded TTF')";
  console.log(execFileSync('python',['-c',py,file],{encoding:'utf8'}).trim());
  assert.deepEqual(errors,[]);await context.close();console.log(`${name}: focus, gesture, close/reload/resume, back, no-final, literal, last sample and TTF passed`);
}
async function fallback(browser) {
  const context=await browser.newContext({viewport:{width:1100,height:800}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{HTMLDialogElement.prototype.showModal=function(){throw new DOMException('blocked','NotAllowedError')}});
  await page.goto(url);await page.locator('#hero-start').click();
  assert(await page.locator('#capture-fallback-backdrop').isVisible());
  assert.equal(await page.locator('#modal-write').getAttribute('role'),'dialog');
  assert(await page.evaluate(()=>document.querySelector('main').inert),'fallback makes background inert');
  await checkStage(page,'draw',`${name} fallback`);
  await page.evaluate(()=>document.querySelector('#font-name').focus());
  assert(await page.evaluate(()=>document.querySelector('.capture-dialog[open]').contains(document.activeElement)));
  await mouseStroke(page,paths.lead);await page.locator('#next-step').click();
  await checkStage(page,'L',`${name} fallback second dialog`);
  await page.keyboard.press('Escape');assert(await page.locator('#capture-fallback-backdrop').isHidden());
  assert(!(await page.evaluate(()=>document.querySelector('main').inert)),'fallback restores background');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'hero-start');assert.deepEqual(errors,[]);
  await context.close();console.log(`${name}: non-native modal fallback, focus, scroll lock and restoration passed`);
}
(async()=>{
  const browser=await engine.launch({headless:true,...(name==='chromium'?{args:['--no-sandbox']}:{})});
  try { await layoutMatrix(browser);await workflow(browser);await fallback(browser); }
  finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
