'use strict';
// Regression test for environments that cannot start a Web Worker. Run with
// the isolated local server on :4176; output is synthetic test handwriting.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium, firefox, webkit } = require('playwright');
const browserName = process.env.TEST_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unknown TEST_BROWSER: ${browserName}`);
const url = process.env.APP_URL || 'http://127.0.0.1:4176/';
const output = process.env.COMPAT_TEST_DIR || path.join(os.tmpdir(), `geulmoa-compatibility-tests-${browserName}`);
fs.mkdirSync(output, { recursive: true });
const lead = [[.18,.2],[.49,.2],[.49,.65]];
const vowel = [[.7,.16],[.7,.76]];
const final = [[.22,.82],[.76,.82]];
const fixture = {
  samples: {
    가: { version: 2, actions: [
      { kind:'ink', device:'mouse', points:lead }, { kind:'ink', device:'pen', points:vowel },
      { kind:'paint', role:'L', width:.12, points:lead }, { kind:'paint', role:'V', width:.12, points:vowel }
    ] },
    각: { version: 2, actions: [
      { kind:'ink', device:'touch', points:lead }, { kind:'ink', device:'touch', points:vowel }, { kind:'ink', device:'touch', points:final },
      { kind:'paint', role:'L', width:.12, points:lead }, { kind:'paint', role:'V', width:.12, points:vowel }, { kind:'paint', role:'T', width:.12, points:final }
    ] },
    '0': { version: 2, actions: [{kind:'ink', device:'mouse', points:[[.5,.2],[.28,.3],[.22,.65],[.5,.8],[.78,.65],[.72,.3],[.5,.2]]}] },
    는: { version: 2, actions: [{kind:'ink', device:'pen', points:[[.2,.2],[.4,.2],[.4,.4]]}] }
  }, custom:[], current:'가', fontName:'Compatibility QA', preview:'가 각 0'
};
const profile = { version:1, profiles:{ 'Compatibility QA':{cleanupStrength:0,device:'auto',letterSpacing:130,wordSpace:750,verticalOffset:80} } };

async function setup(page, mode, options={}) {
  await page.addInitScript(({data, profile, mode, denyStorage}) => {
    if (denyStorage) {
      Object.defineProperty(window, 'localStorage', { configurable:true, get() { throw new DOMException('Storage denied','SecurityError'); } });
    } else {
      localStorage.setItem('geulmoa-drawing-v1', JSON.stringify(data));
      localStorage.setItem('geulmoa-font-design-profiles-v1', JSON.stringify(profile));
    }
    const NativeWorker = window.Worker;
    if (mode === 'silent-start') {
      const realTimer = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => realTimer(callback, delay === 15000 ? 30 : delay, ...args);
    }
    window.__workerAttempts = []; window.__workerPosts = [];
    window.__tick = 0; window.__maxGap = 0;
    let previous = performance.now();
    setInterval(() => { const now = performance.now(); window.__maxGap = Math.max(window.__maxGap, now-previous); previous=now; window.__tick++; }, 20);
    if (mode === 'missing') { window.Worker = undefined; return; }
    function record(message, kind) {
      const samples = message.samples.map(s => ({char:s.char, roles:Object.fromEntries(Object.entries(s.roles).map(([key, value]) => {
        const a = new Uint8Array(value); let sum=0, hash=2166136261;
        for (const x of a) { sum += x; hash = Math.imul(hash ^ x, 16777619); }
        return [key, [a.byteLength, sum, hash >>> 0]];
      }))}));
      window.__workerPosts.push({kind, samples, design:message.design});
    }
    class FailedWorker {
      constructor(kind) { this.kind=kind; this.killed=false; }
      postMessage(message) {
        record(message, this.kind);
        if (mode === 'post-throws') throw new DOMException('Post denied','DataCloneError');
        if (mode === 'silent-start') return;
        if (mode === 'runtime-event' || mode === 'runtime-messageerror') {
          setTimeout(() => { if (!this.killed && this.onmessage) this.onmessage({data:{type:'progress',message:'글자 분석 중'}}); }, 0);
          setTimeout(() => {
            if (this.killed) return;
            if (mode === 'runtime-messageerror') this.onmessageerror && this.onmessageerror({});
            else this.onerror && this.onerror({message:'',preventDefault(){}});
          }, 10);
        } else setTimeout(() => { if (!this.killed && this.onerror) this.onerror({message:'',preventDefault(){}}); }, 0);
      }
      terminate() { this.killed=true; }
    }
    window.Worker = function(source, options) {
      const kind = String(source).startsWith('blob:') ? 'blob' : 'regular';
      window.__workerAttempts.push(kind);
      if (mode === 'all-throws' || (mode === 'direct-throws' && kind === 'regular')) throw new DOMException('Worker denied','SecurityError');
      if (mode === 'both-events' || mode === 'runtime-event' || mode === 'runtime-messageerror' || mode === 'post-throws' || mode === 'silent-start' || (mode === 'direct-event' && kind === 'regular')) return new FailedWorker(kind);
      const worker = new NativeWorker(source, options), post = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer) => { record(message, kind); return post(message, transfer); };
      return worker;
    };
  }, {data:fixture, profile, mode, denyStorage:Boolean(options.denyStorage)});
}
async function waitForBuild(page) {
  await page.waitForFunction(() => !document.querySelector('#build-font').disabled &&
    (document.querySelector('#build-status').classList.contains('error') || !document.querySelector('#download-font').hidden), null, { timeout:180000 });
}
async function createAndDownload(browser, mode) {
  const page = await browser.newPage({viewport:{width:1280,height:900},acceptDownloads:true});
  const pageErrors=[]; page.on('pageerror', e=>pageErrors.push(e.message));
  const engineRequests=[]; page.on('request', req=>{if (req.url().includes('/engine-main.js')) engineRequests.push(req.url());});
  await setup(page, mode); await page.goto(url, {waitUntil:'domcontentloaded'});
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples);
  await page.locator('#build-font').click(); await waitForBuild(page);
  const status=await page.locator('#build-status').innerText();
  assert(!await page.locator('#build-status').evaluate(e=>e.classList.contains('error')), `${mode}: ${status}`);
  assert.equal(await page.locator('#font-state').innerText(),'내 손글씨 폰트 적용 중');
  assert.match(await page.locator('#result-warning').innerText(),/제외한 글자: 는/);
  if (mode==='direct-event' || mode==='direct-throws') assert.match(status,/대체 작업자 방식/);
  else if (mode==='both-events' || mode==='all-throws' || mode==='post-throws' || mode==='silent-start' || mode==='missing') assert.match(status,/브라우저 호환 모드/);
  else assert(!/대체 작업자|호환 모드/.test(status), status);
  const attempts=await page.evaluate(()=>window.__workerAttempts), posts=await page.evaluate(()=>window.__workerPosts);
  if (mode==='normal') assert.deepEqual(attempts,['regular']);
  if (['direct-event','direct-throws'].includes(mode)) assert.deepEqual(attempts,['regular','blob']);
  if (['both-events','all-throws','post-throws','silent-start'].includes(mode)) assert.deepEqual(attempts,['regular','blob']);
  if (mode==='missing') assert.deepEqual(attempts,[]);
  if (mode==='direct-event' || mode==='both-events' || mode==='post-throws' || mode==='silent-start') {
    assert.equal(posts.length,2);
    assert.deepEqual(posts[0].samples,posts[1].samples, 'retry retains the exact mask buffers');
    for (const sample of posts[1].samples) for (const value of Object.values(sample.roles)) assert.equal(value[0],256*256);
  }
  assert.equal(engineRequests.length, ['both-events','all-throws','post-throws','silent-start','missing'].includes(mode)?1:0, `${mode} engine loads only as needed`);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples),before,'generation preserves saved samples');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#download-font').click()]);
  const file=path.join(output,`${mode}.ttf`); await dl.saveAs(file);
  assert.deepEqual([...fs.readFileSync(file).subarray(0,4)],[0,1,0,0]);
  const ticks=await page.evaluate(()=>({ticks:window.__tick,maxGap:window.__maxGap}));
  if (['both-events','all-throws','post-throws','silent-start','missing'].includes(mode)) assert(ticks.ticks>5,`fallback allows event-loop tasks between generation steps: ${JSON.stringify(ticks)}`);
  assert.deepEqual(pageErrors,[]);
  console.log(`${mode}: actual TTF downloaded; ${status} ticks=${ticks.ticks}, max gap=${Math.round(ticks.maxGap)}ms`);
  await page.close(); return file;
}
async function runtimeFailures(browser, mode) {
  const page=await browser.newPage(); await setup(page,mode); const requests=[];
  page.on('request',req=>{ if (req.url().includes('/engine-main.js')) requests.push(req.url()); });
  await page.goto(url); const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples);
  await page.locator('#build-font').click(); await waitForBuild(page);
  const status=await page.locator('#build-status').innerText();
  assert.match(status,/생성하지 못했어요.*글꼴 생성 중/);
  assert.match(status,/필기를 백업/);
  assert(await page.locator('#download-font').isHidden());
  assert.deepEqual(await page.evaluate(()=>window.__workerAttempts),['regular']);
  assert.deepEqual(requests,[]);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples),before);
  assert(await page.locator('#build-font').isEnabled());
  console.log(`${mode}: after-progress error is reported instead of retrying a running job; handwriting unchanged`);
  await page.close();
}
async function blockedEngine(browser) {
  const page=await browser.newPage(); await setup(page,'all-throws');
  await page.route('**/engine-main.js*', route=>route.abort());
  await page.goto(url); const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples);
  await page.locator('#build-font').click(); await waitForBuild(page);
  assert.match(await page.locator('#build-status').innerText(),/호환 생성기 파일을 불러오지 못했어요/);
  assert(await page.locator('#build-font').isEnabled());
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples),before);
  await page.close(); console.log('blocked fallback script: actionable failure without changing handwriting');
}
async function realWorkerBootFailure(browser) {
  const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();await setup(page,'normal');
  let requests=0;
  await context.route('**/worker.js*',async route=>{
    if (++requests===1) await route.fulfill({status:200,contentType:'text/javascript',body:'throw new Error("synthetic worker startup failure");'});
    else await route.continue();
  });
  await page.goto(url);await page.locator('#build-font').click();await waitForBuild(page);
  assert.match(await page.locator('#build-status').innerText(),/대체 작업자 방식/);
  assert.deepEqual(await page.evaluate(()=>window.__workerAttempts),['regular','blob']);
  const posts=await page.evaluate(()=>window.__workerPosts);assert.deepEqual(posts[0].samples,posts[1].samples);
  const [dl]=await Promise.all([page.waitForEvent('download'),page.locator('#download-font').click()]);
  const file=path.join(output,'real-worker-failure.ttf');await dl.saveAs(file);
  assert.deepEqual([...fs.readFileSync(file).subarray(0,4)],[0,1,0,0]);
  await context.close();console.log('real Worker startup exception: alternate Worker retried successfully and produced a TTF');
}
async function blockedBlobSource(browser) {
  const page=await browser.newPage({acceptDownloads:true}); await setup(page,'direct-event');
  await page.route('**/worker.js*',route=>route.abort()); await page.goto(url);
  const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples);
  await page.locator('#build-font').click(); await waitForBuild(page);
  assert.match(await page.locator('#build-status').innerText(),/브라우저 호환 모드/);
  assert.deepEqual(await page.evaluate(()=>window.__workerAttempts),['regular']);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples),before);
  const [dl]=await Promise.all([page.waitForEvent('download'),page.locator('#download-font').click()]);
  const file=path.join(output,'blocked-worker-file.ttf');await dl.saveAs(file);
  assert.deepEqual([...fs.readFileSync(file).subarray(0,4)],[0,1,0,0]);
  await page.close();console.log('blocked Worker file: fallback to main thread and TTF download passed');
}
async function backupRoundTrip(browser) {
  const source=await browser.newPage({acceptDownloads:true}); await setup(source,'normal'); await source.goto(url);
  const [dl]=await Promise.all([source.waitForEvent('download'),source.locator('#backup-save').click()]);
  const file=path.join(output,'handwriting-backup.json'); await dl.saveAs(file);
  const payload=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.deepEqual(payload.samples,fixture.samples); assert(!('fontName' in payload) && !('preview' in payload));
  const destContext=await browser.newContext(); const dest=await destContext.newPage();
  const existing={version:2,actions:[{kind:'ink',device:'mouse',points:[[.1,.1],[.3,.3]]}]};
  await dest.addInitScript(value=>localStorage.setItem('geulmoa-drawing-v1',JSON.stringify({samples:{가:value},custom:[],current:'가',fontName:'Keep me',preview:''})),existing);
  await dest.goto(url); await dest.locator('#backup-file').setInputFiles(file);
  await dest.waitForFunction(()=>document.querySelector('#backup-status').textContent.includes('불러왔어요'));
  assert.match(await dest.locator('#backup-status').innerText(),/3자 불러왔어요/);
  assert.match(await dest.locator('#backup-status').innerText(),/기존 글씨 유지: 가/);
  const after=await dest.evaluate(()=>JSON.parse(localStorage.getItem('geulmoa-drawing-v1')));
  assert.deepEqual(after.samples.가,existing); assert.deepEqual(after.samples.각,fixture.samples.각);
  assert.deepEqual(after.samples.는,fixture.samples.는); assert.deepEqual(after.samples['0'],fixture.samples['0']);
  assert.equal(after.fontName,'Keep me');
  // Remove the init-script seed before reloading by using a fresh page in the
  // same context, then verify the actual persisted merged state.
  const merged=await dest.context().newPage(); await merged.goto(url);
  const restored=await merged.evaluate(()=>JSON.parse(localStorage.getItem('geulmoa-drawing-v1')));
  assert.deepEqual(restored.samples,after.samples);
  await merged.close(); await destContext.close(); await source.close();
  console.log('file backup: unfinished + completed strokes round-trip; existing glyphs are never overwritten');
}
async function quotaFailure(browser) {
  const page=await browser.newPage({acceptDownloads:true});
  await page.addInitScript(({data,profile})=>{
    const setter=Storage.prototype.setItem;
    setter.call(localStorage,'geulmoa-drawing-v1',JSON.stringify(data));
    setter.call(localStorage,'geulmoa-font-design-profiles-v1',JSON.stringify(profile));
    Storage.prototype.setItem=function(key,value){
      if (key==='geulmoa-drawing-v1') throw new DOMException('Quota reached','QuotaExceededError');
      return setter.call(this,key,value);
    };
  },{data:fixture,profile});
  await page.goto(url);assert(await page.locator('#storage-warning').isHidden());
  await page.locator('.sample-chip').filter({hasText:/^1$/}).click();
  await page.locator('#start-writing').click();
  await page.locator('#pad').evaluate(c=>{
    const r=c.getBoundingClientRect();const points=[[.35,.25],[.55,.15],[.55,.8]];
    points.forEach(([x,y],i)=>c.dispatchEvent(new PointerEvent(i===0?'pointerdown':i===points.length-1?'pointerup':'pointermove',{bubbles:true,cancelable:true,pointerId:5,pointerType:'mouse',button:0,clientX:r.x+x*r.width,clientY:r.y+y*r.height})));
  });
  assert(await page.locator('#modal-storage-warning').isVisible());
  await page.locator('#capture-close').click();
  assert(await page.locator('#storage-warning').isVisible());
  assert.deepEqual((await page.evaluate(()=>JSON.parse(localStorage.getItem('geulmoa-drawing-v1')))).samples,fixture.samples,'failed write did not overwrite saved samples');
  await page.locator('.backup-manual summary').click();await page.locator('#backup-make-text').click();
  let copied=JSON.parse(await page.locator('#backup-text').inputValue());
  assert(copied.samples['1'].actions.some(a=>a.kind==='ink'),'new unsaved input remains recoverable in memory');
  assert.deepEqual(copied.samples.가,fixture.samples.가,'older input also included');
  await page.locator('#start-writing').click();
  await page.locator('#pad').evaluate(c=>{const r=c.getBoundingClientRect();for(const [i,p] of [[0,[.3,.8]],[1,[.7,.8]]]) c.dispatchEvent(new PointerEvent(i?'pointerup':'pointerdown',{bubbles:true,cancelable:true,pointerId:6,pointerType:'mouse',button:0,clientX:r.x+p[0]*r.width,clientY:r.y+p[1]*r.height}));});
  await page.locator('#capture-close').click();
  assert.equal(await page.locator('#backup-text').inputValue(),'','old snapshot is cleared after more writing');
  assert.match(await page.locator('#backup-status').innerText(),/다시 눌러/);
  await page.locator('#backup-make-text').click();copied=JSON.parse(await page.locator('#backup-text').inputValue());
  assert.equal(copied.samples['1'].actions.length,2,'refreshed snapshot includes the new stroke');
  const recovery=await browser.newPage();await recovery.goto(url);
  await recovery.locator('.designer-import summary').click();await recovery.locator('#designer-import-data').fill(JSON.stringify(copied));await recovery.locator('#designer-import-button').click();
  assert.match(await recovery.locator('#designer-import-status').innerText(),/5자 복사/);
  const restored=await recovery.evaluate(()=>JSON.parse(localStorage.getItem('geulmoa-drawing-v1')));
  assert.deepEqual(restored.samples['1'],copied.samples['1']);assert.deepEqual(restored.samples.가,fixture.samples.가);
  await recovery.close();await page.close();console.log('quota failure: warning appears, old save survives, current in-memory strokes recover by manual backup');
}
async function opaqueSandbox(browser, downloadsAllowed) {
  const page=await browser.newPage({viewport:{width:1280,height:1000},acceptDownloads:true});
  const pageErrors=[], downloads=[], workerRequests=[];
  page.on('pageerror',e=>pageErrors.push(e.message)); page.on('download',d=>downloads.push(d));
  page.on('request',r=>{if (/\/(?:vector-)?worker\.js(?:\?|$)/.test(r.url())) workerRequests.push(r.url());});
  await page.setContent(`<iframe title="opaque test" sandbox="allow-scripts${downloadsAllowed?' allow-downloads':''}" src="${url}" style="width:1200px;height:950px;border:0"></iframe>`);
  const iframe=page.locator('iframe'); await iframe.waitFor();
  const frame=await iframe.elementHandle().then(e=>e.contentFrame()); await frame.waitForSelector('#build-font');
  await frame.waitForFunction(()=>document.querySelector('#storage-warning') && !document.querySelector('#storage-warning').hidden);
  assert.match(await frame.locator('#storage-warning').innerText(),/자동 저장이 차단/);
  await frame.locator('.sample-chip').filter({hasText:/^가$/}).first().click();
  await frame.locator('#start-writing').click();
  assert(await frame.locator('#modal-storage-warning').isVisible());
  async function stroke(points){
    await frame.locator('#pad').evaluate((c,points)=>{const r=c.getBoundingClientRect();points.forEach(([x,y],i)=>c.dispatchEvent(new PointerEvent(i===0?'pointerdown':i===points.length-1?'pointerup':'pointermove',{bubbles:true,cancelable:true,pointerId:22,pointerType:'mouse',button:0,clientX:r.x+x*r.width,clientY:r.y+y*r.height})));},points);
  }
  await stroke(lead); await stroke(vowel); await frame.locator('#next-step').click();
  await stroke(lead); await frame.locator('#next-step').click(); await stroke(vowel);
  assert.match(await frame.locator('#paint-status').innerText(),/모든 획을 자모별로 나눴어요/);
  // A sandbox without allow-modals blocks window.confirm; the editor's own
  // confirmation must still be cancellable and able to clear just the paint.
  await frame.locator('#clear-colors').click();assert(await frame.locator('#capture-confirm').isVisible());
  await frame.locator('#capture-confirm-cancel').click();
  assert.match(await frame.locator('#paint-status').innerText(),/모든 획을 자모별로 나눴어요/);
  await frame.locator('#clear-colors').click();await frame.locator('#capture-confirm-accept').click();
  assert(await frame.locator('#modal-lead').evaluate(e=>e.open));
  assert.match(await frame.locator('#paint-status').innerText(),/칠하지 않은 획 100%/);
  await stroke(lead);await frame.locator('#next-step').click();await stroke(vowel);
  assert.match(await frame.locator('#paint-status').innerText(),/모든 획을 자모별로 나눴어요/);
  await frame.locator('#capture-close').click();
  await frame.locator('#build-font').click();
  await frame.waitForFunction(()=>!document.querySelector('#build-font').disabled && (document.querySelector('#build-status').classList.contains('error') || !document.querySelector('#download-font').hidden),null,{timeout:180000});
  const status=await frame.locator('#build-status').innerText();
  assert.match(status,/브라우저 호환 모드로 만들었어요/);
  if (downloadsAllowed) {
    const [dl]=await Promise.all([page.waitForEvent('download'),frame.locator('#download-font').click()]);
    const file=path.join(output,'opaque-iframe.ttf'); await dl.saveAs(file);
    assert.deepEqual([...fs.readFileSync(file).subarray(0,4)],[0,1,0,0]);
  } else {
    // Sandboxing can silently prevent both TTF and JSON downloads. The manual
    // copy path is essential here; the site cannot override the browser flag.
    await frame.locator('#download-font').click(); await frame.locator('#backup-save').click();
    await page.waitForTimeout(400); assert.equal(downloads.length,0,'the strict sandbox blocks downloads');
    assert.match(await frame.locator('#download-help').innerText(),/백업 내용을 복사/);
  }
  await frame.locator('#thickness-details > summary').click();
  await frame.waitForFunction(()=>document.querySelector('#thickness-status').classList.contains('error'));
  assert.match(await frame.locator('#thickness-status').innerText(),/내장 화면.*새 탭/);
  await frame.locator('.backup-manual summary').click(); await frame.locator('#backup-make-text').click();
  const copied=JSON.parse(await frame.locator('#backup-text').inputValue());
  assert.equal(copied.samples.가.actions.filter(a=>a.kind==='ink').length,2);
  assert.equal(copied.samples.가.actions.filter(a=>a.kind==='paint').length,2);
  assert.match(await frame.locator('#backup-status').innerText(),/복사해 보관/);
  assert.deepEqual(workerRequests,[],'known opaque-origin frames bypass worker and blocked fetch');
  assert.deepEqual(pageErrors,[]);
  if (!downloadsAllowed) {
    // User can paste the in-memory backup into a normal tab, build again and
    // obtain a TTF even when the original embedded frame forbids downloads.
    const recovery=await browser.newPage({acceptDownloads:true}); await recovery.goto(url);
    await recovery.locator('.designer-import summary').click();
    await recovery.locator('#designer-import-data').fill(JSON.stringify(copied));
    await recovery.locator('#designer-import-button').click();
    assert.match(await recovery.locator('#designer-import-status').innerText(),/1자 복사/);
    const restored=await recovery.evaluate(()=>JSON.parse(localStorage.getItem('geulmoa-drawing-v1')));
    assert.deepEqual(restored.samples.가,copied.samples.가);
    await recovery.locator('#build-font').click(); await waitForBuild(recovery);
    const [dl]=await Promise.all([recovery.waitForEvent('download'),recovery.locator('#download-font').click()]);
    const file=path.join(output,'opaque-recovered.ttf'); await dl.saveAs(file);
    assert.deepEqual([...fs.readFileSync(file).subarray(0,4)],[0,1,0,0]); await recovery.close();
  }
  console.log(`opaque sandbox (${downloadsAllowed?'downloads allowed':'downloads blocked'}): storage warning, real Hangul compatibility TTF, manual backup${downloadsAllowed?'':' and new-tab recovery'} passed`);
  await page.close();
}
(async()=>{
  const browser=await browserType.launch({headless:true,...(browserName==='chromium'?{args:['--no-sandbox']}:{})});
  try {
    const files=[];
    for(const mode of ['normal','direct-event','direct-throws','both-events','all-throws','post-throws','silent-start','missing']) files.push(await createAndDownload(browser,mode));
    const py=`from fontTools.ttLib import TTFont\nimport sys\nfonts=[TTFont(p) for p in sys.argv[1:]]\na=fonts[0]\ndef coords(f,c):\n g=f.getBestCmap()[ord(c)]; return tuple(f['glyf'][g].getCoordinates(f['glyf'])[0])\nfor f in fonts:\n assert f.getBestCmap()==a.getBestCmap()\n for c in '가각0 ':\n  name=f.getBestCmap()[ord(c)]; ref=a.getBestCmap()[ord(c)]\n  assert f['hmtx'][name]==a['hmtx'][ref],(c,f['hmtx'][name],a['hmtx'][ref])\n  if c!=' ': assert coords(f,c)==coords(a,c),(c,'outlines differ')\n assert f['hmtx'][f.getBestCmap()[ord('가')]][0]==1130\n assert f['hmtx'][f.getBestCmap()[ord(' ')]][0]==750\n assert (f['OS/2'].sxHeight,f['OS/2'].sCapHeight)==(560,780)\nprint('fontTools: cmap, outlines, advances, space and vertical metrics match across all eight modes')`;
    console.log(execFileSync('python',['-c',py,...files],{encoding:'utf8'}).trim());
    await runtimeFailures(browser,'runtime-event'); await runtimeFailures(browser,'runtime-messageerror');
    await blockedEngine(browser); await realWorkerBootFailure(browser); await blockedBlobSource(browser); await backupRoundTrip(browser); await quotaFailure(browser);
    await opaqueSandbox(browser,true); await opaqueSandbox(browser,false);
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
