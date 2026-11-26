'use strict';
// Start the isolated designer server on :4176; no published site is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const url = process.env.APP_URL || 'http://127.0.0.1:4176/';
const OUT = process.env.DESIGN_TEST_DIR || path.join(os.tmpdir(), 'geulmoa-designer-tests');
fs.mkdirSync(OUT, { recursive: true });

function fixture() {
  const L = [], V = [];
  for (let i = 0; i <= 40; i++) L.push([.15 + .0075 * i, .24 + (i === 40 ? 0 : .003 * Math.sin(i * 1.8))]);
  for (let i = 1; i <= 44; i++) L.push([.45 + .003 * Math.sin(i * 1.8 + 1), .24 + .01 * i]);
  for (let i = 0; i <= 55; i++) V.push([.68 + .003 * Math.sin(i * 1.8), .15 + .011 * i]);
  const strokes = [L, V], roles = ['L', 'V'];
  const ga = { version: 2, actions: [...strokes.map((points) => ({ kind: 'ink', device: 'touch', points })),
    ...strokes.map((points, i) => ({ kind: 'paint', role: roles[i], width: .12, points }))] };
  // Two almost-touching wavy strokes deliberately change tiny holes after
  // smoothing. The entire manually coloured original must be used instead.
  const p1 = [], p2 = [];
  for (let i = 0; i <= 55; i++) { const x = .18 + .011 * i; p1.push([x, .25 + .002 * Math.sin(i * 1.7)]); p2.push([x, .282 + .002 * Math.sin(i * 1.7 + 1.1)]); }
  const v = [[.2,.7],[.8,.7]];
  const go = { version: 2, actions: [
    { kind: 'ink', device: 'touch', points: p1 }, { kind: 'ink', device: 'touch', points: p2 }, { kind: 'ink', device: 'touch', points: v },
    { kind: 'paint', role: 'L', width: .15, points: p1 }, { kind: 'paint', role: 'V', width: .12, points: v },
  ] };
  const single = Array.from({length:71}, (_,i) => [.15 + i * .01, .5 + .003 * Math.sin(i * 1.8)]);
  const split = { version:2, actions:[{ kind:'ink', device:'touch', points:single },
    { kind:'paint', role:'L', width:.12, points:single.slice(0,36) }, { kind:'paint', role:'V', width:.12, points:single.slice(35) }] };
  const comma = { version:2, actions:[{ kind:'ink', device:'mouse', points:[[.50,.38],[.53,.45],[.50,.52],[.46,.59]] }] };
  return { samples: { 가: ga, 거: split, 고: go, ',': comma }, custom: [], current: '가', fontName: 'Design A', preview: '가 고' };
}
async function setSlider(page, id, value) {
  await page.locator(id).evaluate((el, value) => { el.value = String(value); el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
}
async function build(page, filename) {
  const n = await page.evaluate(() => window.__done || 0);
  await page.locator('#build-font').click();
  await page.waitForFunction(n => (window.__done || 0) > n && !document.querySelector('#build-font').disabled, n, { timeout: 120000 });
  assert(!await page.locator('#build-status').evaluate(e => e.classList.contains('error')), await page.locator('#build-status').innerText());
  assert.equal(await page.locator('#font-state').innerText(), '내 손글씨 폰트 적용 중');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-font').click()]);
  const file = path.join(OUT, filename); await download.saveAs(file);
  assert.deepEqual([...fs.readFileSync(file).subarray(0, 4)], [0, 1, 0, 0]);
  return file;
}
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, transfer) {
      if (message.design) {
        window.__jobs ||= [];
        function digest(buffer) { let h = 2166136261, count = 0; for (const x of new Uint8Array(buffer)) { count += x; h = Math.imul(h ^ x, 16777619); } return [count, h >>> 0]; }
        window.__jobs.push({ design: { ...message.design }, samples: message.samples.map(s => ({ char: s.char,
          masks: Object.fromEntries(Object.entries(s.roles).map(([role, buffer]) => [role, digest(buffer)])),
          strokes: s.strokes.map((stroke) => stroke.points.map((p) => [...p])) })) });
        this.addEventListener('message', ({ data }) => { if (data.type === 'done') { window.__done = (window.__done || 0) + 1; window.__lastMeta = { design: data.design, ascent: data.fontAscent, descent: data.fontDescent }; } });
      }
      return post.call(this, message, transfer);
    };
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const data = fixture();
  await page.evaluate(s => localStorage.setItem('geulmoa-drawing-v1', JSON.stringify(s)), data);
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.match(await page.locator('#design-drawing-source').innerText(), /선택한 ‘가’/);
  await page.locator('#start-writing').click();
  await page.locator('.phase-step[data-stage="V"]').click();
  assert.match(await page.locator('#paint-status').innerText(), /모든 획을 자모별로 나눴어요/);
  await page.locator('#capture-close').click();
  // Isolate the designer's cleanup and metrics from the new default-on
  // vector-width correction, which has its own end-to-end tests.
  await page.locator('#auto-stroke').uncheck();
  const rawBefore = await page.evaluate(() => localStorage.getItem('geulmoa-drawing-v1'));
  await setSlider(page, '#design-word', 225); assert.equal(await page.locator('#design-word-value').innerText(), '0.225em');
  await setSlider(page, '#design-word', 500);
  const baseline = await build(page, 'designer-test-baseline.ttf');
  const jobs0 = await page.evaluate(() => window.__jobs);
  assert.deepEqual(jobs0[0].design, { cleanupStrength: 0, device: 'auto', letterSpacing: 0, wordSpace: 500, verticalOffset: 0, vectorCorrection: false });
  assert.match(await page.locator('#design-sample-status').innerText(), /생성한 내 폰트/);

  await setSlider(page, '#design-spacing', 130); await setSlider(page, '#design-word', 750); await setSlider(page, '#design-va', 80);
  assert.match(await page.locator('#font-state').innerText(), /다시 생성 필요/);
  const adjusted = await build(page, 'designer-test-adjusted.ttf');
  const jobs1 = await page.evaluate(() => window.__jobs);
  assert.equal(jobs1[1].design.letterSpacing, 130); assert.equal(jobs1[1].design.wordSpace, 750); assert.equal(jobs1[1].design.verticalOffset, 80);
  assert.deepEqual(jobs1[0].samples, jobs1[1].samples, 'metrics changes do not change input masks');

  // Turn off metric changes to isolate cleanup, and use real saved paint paths.
  await setSlider(page, '#design-spacing', 0); await setSlider(page, '#design-word', 500); await setSlider(page, '#design-va', 0);
  await setSlider(page, '#design-cleanup', 100); await page.locator('#design-device').selectOption('touch');
  assert.match(await page.locator('#design-stroke-status').innerText(), /검사를 통과/);
  const cleaned = await build(page, 'designer-test-cleaned.ttf');
  const jobs = await page.evaluate(() => window.__jobs);
  const glyph = (job, ch) => job.samples.find(s => s.char === ch);
  assert.notDeepEqual(glyph(jobs[0], '가').masks, glyph(jobs[2], '가').masks, 'cleaned stroke masks actually reach the TTF worker');
  assert.notDeepEqual(glyph(jobs[0], '가').strokes, glyph(jobs[2], '가').strokes, 'post-cleanup vector paths accompany the cleaned masks');
  assert.notDeepEqual(glyph(jobs[0], '거').masks, glyph(jobs[2], '거').masks, 'one stroke manually split across roles is cleaned without discarding its paint');
  const splitCheck = await page.evaluate(() => {
    const a=JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples['거'].actions, C=window.GeulmoaColoring, K=window.GeulmoaStrokeCleanup;
    const before=C.analyzeActions(a,['L','V']), after=C.analyzeActions(K.cleanActions(a,100,'touch'),['L','V']);
    let swapped=0;for(let i=0;i<256*256;i++)if((before.masks.L[i]&&after.masks.V[i])||(before.masks.V[i]&&after.masks.L[i]))swapped++;
    return { valid:K.compatible(before,after,['L','V']).ok, swapped, inkActions:a.filter(x=>x.kind==='ink').length };
  });
  assert.deepEqual(splitCheck, {valid:true, swapped:0, inkActions:1});
  assert.deepEqual(glyph(jobs[0], '고').masks, glyph(jobs[2], '고').masks, 'topology-risk sample reaches worker unchanged');
  assert.deepEqual(glyph(jobs[0], '고').strokes, glyph(jobs[2], '고').strokes, 'cleanup fallback also preserves its vector paths');
  assert.match(await page.locator('#result-warning').innerText(), /흔들림 정리 적용: 가/);
  assert.match(await page.locator('#result-warning').innerText(), /원본 유지: 고/);
  await page.locator('#inspect-char').fill('가'); assert.match(await page.locator('#inspect-status').innerText(), /흔들림 정리를 적용/);
  await page.locator('#inspect-char').fill('고'); assert.match(await page.locator('#inspect-status').innerText(), /원본 음절을 유지/);
  assert.equal(await page.evaluate(() => localStorage.getItem('geulmoa-drawing-v1')), rawBefore, 'generated cleanup never overwrites saved drawing or manual paint');
  await page.locator('.sample-chip').filter({ hasText: /^고$/ }).first().click();
  assert.match(await page.locator('#design-stroke-status').innerText(), /원본을 유지/);
  await setSlider(page, '#design-cleanup', 0); await setSlider(page, '#design-va', -100);
  const lowered = await build(page, 'designer-test-lowered.ttf');
  await setSlider(page, '#design-cleanup', 100); await setSlider(page, '#design-va', 0);

  // Verify the actual font file, not just a CSS preview or worker payload.
  const py = `from fontTools.ttLib import TTFont\nimport sys\na,b,c,down=map(TTFont,sys.argv[1:])\ndef glyph(f,ch): return f.getBestCmap()[ord(ch)]\ndef bounds(f,ch):\n g=f['glyf'][glyph(f,ch)]; return (g.xMin,g.yMin,g.xMax,g.yMax)\ndef coords(f,ch): return tuple(f['glyf'][glyph(f,ch)].getCoordinates(f['glyf'])[0])\ng=glyph(a,'가'); gb=glyph(b,'가')\nassert a['head'].unitsPerEm==1000\nassert a['hmtx'][g][0]==1000 and b['hmtx'][gb][0]==1130\nassert a['hmtx'][glyph(a,' ')][0]==500 and b['hmtx'][glyph(b,' ')][0]==750\nassert (a['OS/2'].sxHeight,a['OS/2'].sCapHeight)==(480,700) and (b['OS/2'].sxHeight,b['OS/2'].sCapHeight)==(560,780)\nA=bounds(a,'가'); B=bounds(b,'가')\nassert all(abs((B[i]-A[i])-(65 if i%2==0 else 80))<=1 for i in range(4)),(A,B)\nassert b['hhea'].ascent>=b['head'].yMax and b['OS/2'].usWinAscent>=b['head'].yMax\nassert b['hhea'].descent<=b['head'].yMin and b['OS/2'].usWinDescent>=-b['head'].yMin\nD=bounds(down,','); C=bounds(a,',')\nassert abs(D[1]-C[1]+100)<=1 and abs(D[3]-C[3]+100)<=1, (C,D)\nassert down['hhea'].descent<=down['head'].yMin and down['OS/2'].usWinDescent>=-down['head'].yMin\nassert coords(a,'가')!=coords(c,'가'), 'cleanup must alter downloaded glyph'\nassert coords(a,'고')==coords(c,'고'), 'fallback must retain original glyph'\nprint('TTF checks: advance 1000→1130; space 500→750; outline +65 X/+80 Y; vertical bounds; cleanup/fallback outlines verified')`;
  console.log(execFileSync('python', ['-c', py, baseline, adjusted, cleaned, lowered], { encoding: 'utf8' }).trim());

  // Real rendering dimensions in the browser agree with the changed TTF.
  const measure = await page.evaluate(async ([a,b]) => {
    const faces = await Promise.all([new FontFace('TestMetricsA', Uint8Array.from(atob(a),c=>c.charCodeAt(0))).load(), new FontFace('TestMetricsB', Uint8Array.from(atob(b),c=>c.charCodeAt(0))).load()]);
    faces.forEach(f => document.fonts.add(f)); const c=document.createElement('canvas'), ctx=c.getContext('2d');
    const get=(fam,ch)=>{ctx.font=`1000px ${fam}`;const m=ctx.measureText(ch);return {width:m.width,ascent:m.actualBoundingBoxAscent}};
    return { gaA:get('TestMetricsA','가'),gaB:get('TestMetricsB','가'),spaceA:get('TestMetricsA',' '),spaceB:get('TestMetricsB',' ') };
  }, [fs.readFileSync(baseline).toString('base64'), fs.readFileSync(adjusted).toString('base64')]);
  assert(Math.abs(measure.gaB.width - measure.gaA.width - 130) < 1, JSON.stringify(measure));
  assert(Math.abs(measure.spaceB.width - measure.spaceA.width - 250) < 1, JSON.stringify(measure));
  assert(Math.abs(measure.gaB.ascent - measure.gaA.ascent - 80) <= 3, JSON.stringify(measure)); // raster/curve rounding may differ by a few units
  console.log('actual browser TTF spacing and baseline rendering passed');

  // Name-based design profiles restore independently; samples remain shared.
  await page.locator('#designer-font-name').fill('Design B'); await page.locator('#designer-font-name').press('Tab');
  assert.equal(await page.locator('#font-name').inputValue(), 'Design B');
  assert.equal(await page.locator('#design-cleanup').inputValue(), '100', 'new profile starts as a copy');
  await setSlider(page, '#design-spacing', 170); await setSlider(page, '#design-cleanup', 40);
  await page.locator('#font-name').fill('Design A'); await page.locator('#font-name').press('Tab');
  assert.equal(await page.locator('#designer-font-name').inputValue(), 'Design A');
  assert.equal(await page.locator('#design-cleanup').inputValue(), '100'); assert.equal(await page.locator('#design-spacing').inputValue(), '0');
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#design-cleanup').inputValue(), '100', 'per-name profile survives reload');
  await page.locator('#designer-font-name').fill('Design B'); await page.locator('#designer-font-name').press('Tab');
  assert.equal(await page.locator('#design-cleanup').inputValue(), '40'); assert.equal(await page.locator('#design-spacing').inputValue(), '170');
  await page.locator('#design-profile').selectOption('Design A');
  assert.equal(await page.locator('#design-cleanup').inputValue(), '100'); assert.equal(await page.locator('#font-name').inputValue(), 'Design A');
  await page.locator('#design-profile').selectOption('Design B');
  assert.equal(await page.locator('#design-spacing').inputValue(), '170');
  console.log('name-based profile persistence, selector and two synchronized name inputs passed');

  // Explicit add-only import: preserve existing local drawings and never
  // replace the stored font name or write to the source origin.
  const add = { version: 2, actions: [
    { kind:'ink', device:'pen', points:[[.2,.2],[.5,.2],[.5,.48]] }, { kind:'ink', device:'pen', points:[[.7,.15],[.7,.5]] }, { kind:'ink', device:'pen', points:[[.25,.75],[.7,.75]] },
    { kind:'paint', role:'L', width:.12, points:[[.2,.2],[.5,.2],[.5,.48]] }, { kind:'paint', role:'V', width:.12, points:[[.7,.15],[.7,.5]] }, { kind:'paint', role:'T', width:.12, points:[[.25,.75],[.7,.75]] },
  ] };
  const imported = { samples: { 가: { version:2, actions:[{ kind:'ink', points:[[.1,.1],[.2,.2]] }] }, 각:add,
    나:{ version:2, actions:[{ kind:'ink', points:[[999,.1],[.2,.2]] }] } }, fontName:'should not copy' };
  const gaBefore = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples['가']));
  await page.locator('.designer-import summary').click(); await page.locator('#designer-import-data').fill(JSON.stringify(imported)); await page.locator('#designer-import-button').click();
  assert.match(await page.locator('#designer-import-status').innerText(), /1자 복사/);
  assert.match(await page.locator('#designer-import-status').innerText(), /기존 글씨 유지: 가/);
  assert.match(await page.locator('#designer-import-status').innerText(), /읽을 수 없어 제외: 나/);
  const importedState = await page.evaluate(() => JSON.parse(localStorage.getItem('geulmoa-drawing-v1')));
  assert.equal(JSON.stringify(importedState.samples['가']), gaBefore); assert.equal(importedState.fontName,'Design B');
  assert.equal(importedState.samples['각'].actions[0].device,'pen'); assert.equal(await page.locator('#designer-import-data').inputValue(),'');
  await page.reload(); assert(await page.locator('.sample-chip.done').filter({hasText:/^각$/}).count(), 'imported complete drawing persists');
  console.log('add-only local import, validation and source preservation passed');

  // Pointer classification is captured for automatic device sensitivity.
  await page.locator('.sample-chip').filter({ hasText: /^는$/ }).first().click();
  await page.locator('#start-writing').click();
  await page.locator('#pad').evaluate(c => { const r=c.getBoundingClientRect();
    for (const [i, xy] of [[0,[.2,.2]],[1,[.3,.3]],[2,[.4,.4]]]) c.dispatchEvent(new PointerEvent(i===0?'pointerdown':i===2?'pointerup':'pointermove',{bubbles:true,cancelable:true,pointerId:7,pointerType:'pen',clientX:r.x+xy[0]*r.width,clientY:r.y+xy[1]*r.height})); });
  const pointerType = await page.evaluate(() => JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples['는'].actions[0].device);
  assert.equal(pointerType,'pen');
  await page.locator('#capture-close').click();
  assert.deepEqual(errors, []); await page.close();

  const mobile = await browser.newPage({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true, deviceScaleFactor:1 });
  const mobileErrors=[]; mobile.on('pageerror', e=>mobileErrors.push(e.message)); await mobile.goto(url);
  const initial = await mobile.locator('#design-specimen').evaluate(c=>c.toDataURL());
  await setSlider(mobile, '#design-spacing', 160); await mobile.waitForTimeout(100);
  const next = await mobile.locator('#design-specimen').evaluate(c=>c.toDataURL());
  assert.notEqual(initial,next,'mobile specimen responds to slider');
  for (const width of [320, 360, 390, 768]) {
    await mobile.setViewportSize({width,height:844});
    const widths = await mobile.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollWidth]);
    assert(widths[1] <= widths[0] + 1, `mobile overflow at ${width}: ${widths}`);
  }
  assert.deepEqual(mobileErrors, []); await mobile.close();
  console.log('simulated pointer type, mobile responsive live controls and no overflow passed');
  await browser.close();
})().catch(async e => { console.error(e); if (browser) await browser.close(); process.exitCode = 1; });
