'use strict';
// User-facing vector settings and before/after use the actual TTF pipeline.
// Synthetic data tests behavior, not visual quality on real devices.
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
const out = process.env.STROKE_TEST_DIR || path.join(os.tmpdir(), `geulmoa-stroke-settings-${browserName}`);
fs.mkdirSync(out, { recursive: true });
const workerSource = fs.readFileSync(path.join(__dirname, '../site/worker.js'), 'utf8');
function lines(ch, left, right, y1, y2) {
  const ink = [], paint = [];
  for (const [role, y] of [['L', y1], ['V', y2]]) {
    const points = [[left, y], [right, y]];
    ink.push({ kind: 'ink', points }); paint.push({ kind: 'paint', role, width: .12, points });
  }
  return [ch, { version: 2, actions: [...ink, ...paint] }];
}
const basic = Object.fromEntries([lines('가', .35, .65, .38, .62), lines('고', .15, .85, .28, .72)]);
basic['0'] = { version: 2, actions: [{ kind: 'ink', points: [[.4,.2],[.2,.4],[.4,.8],[.7,.4],[.4,.2]] }] };
const risk = Object.fromEntries([lines('가', .2, .8, .48, .53), lines('고', .42, .58, .46, .54)]);
function saved(samples) { return { samples, custom: [], current: '가', fontName: 'Stroke UI QA', preview: '가 고 갸 0' }; }
async function seed(page, state, mode = 'normal') {
  await page.addInitScript(({ state, mode }) => {
    localStorage.setItem('geulmoa-drawing-v1', JSON.stringify(state));
    window.__strokeJobs = []; window.__strokeOutputs = []; window.__slowPreview = false;
    const NativeWorker = window.Worker;
    if (mode === 'no-path2d') { window.Worker = undefined; window.Path2D = undefined; return; }
    window.Worker = function(source, options) {
      const w = new NativeWorker(source, options), send = w.postMessage.bind(w);
      w.postMessage = (message, transfer) => {
        const design = { ...message.design };
        window.__strokeJobs.push({ design, samples: message.samples.map(s => ({ char: s.char, strokes: s.strokes })) });
        w.addEventListener('message', ({ data }) => {
          if (data.type === 'done') window.__strokeOutputs.push({ design, ttf: Array.from(new Uint8Array(data.ttf)), report: data.strokeCorrection });
        });
        if (window.__slowPreview && design.previewChars) { setTimeout(() => send(message, transfer), 350); return; }
        return send(message, transfer);
      };
      return w;
    };
  }, { state, mode });
}
async function slider(page, id, value) {
  await page.locator(id).evaluate((e, value) => { e.value = String(value); e.dispatchEvent(new Event('input', { bubbles: true })); }, value);
}
async function compare(page, prefix, expectWorker = true) {
  const start = await page.evaluate(() => window.__strokeOutputs.length);
  await page.locator('#stroke-compare').click();
  await page.waitForFunction(() => !document.querySelector('#stroke-compare').disabled, null, { timeout: 120000 });
  const status = await page.locator('#stroke-status').innerText();
  assert(!await page.locator('#stroke-status').evaluate(e => e.classList.contains('error')), status);
  assert(await page.locator('#stroke-result').isVisible(), status);
  if (!expectWorker) return null;
  const outputs = (await page.evaluate(() => window.__strokeOutputs)).slice(start);
  assert.equal(outputs.length, 2, `two actual-engine preview jobs: ${JSON.stringify(outputs.map(x => x.design))}`);
  assert.equal(outputs[0].design.vectorCorrection, false);
  assert.equal(typeof outputs[0].design.previewChars, 'string');
  const files = outputs.map((x, i) => { const file = path.join(out, `${prefix}-${i ? 'after' : 'before'}.ttf`); fs.writeFileSync(file, Buffer.from(x.ttf)); return file; });
  return { before: files[0], after: files[1], outputs };
}
async function build(page, name) {
  await page.locator('#build-font').click();
  await page.waitForFunction(() => !document.querySelector('#build-font').disabled &&
    (!document.querySelector('#download-font').hidden || document.querySelector('#build-status').classList.contains('error')), null, { timeout: 120000 });
  const status = await page.locator('#build-status').innerText();
  assert(!await page.locator('#build-status').evaluate(e => e.classList.contains('error')), status);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#download-font').click()]);
  const file = path.join(out, name); await dl.saveAs(file);
  assert.deepEqual([...fs.readFileSync(file).subarray(0, 4)], [0, 1, 0, 0]); return file;
}
function verify(files, body) {
  const script = `from fontTools.ttLib import TTFont\nimport sys\nfonts=[TTFont(p) for p in sys.argv[1:]]\ndef shape(f,c):\n g=f.getBestCmap()[ord(c)]; v=f['glyf'][g]; coords,ends,flags=v.getCoordinates(f['glyf'])\n return (tuple(coords),tuple(ends),tuple(flags),f['hmtx'][g])\n${body}\nprint('fontTools: actual preview and downloaded TTF outlines verified')`;
  return execFileSync('python', ['-c', script, ...files], { encoding: 'utf8' }).trim();
}
async function widths(page, files) {
  const encoded = files.map(f => fs.readFileSync(f).toString('base64'));
  return page.evaluate(async (encoded) => {
    const faces = await Promise.all(encoded.map((raw, i) => new FontFace(`StrokeWidthQA${i}`,
      Uint8Array.from(atob(raw), c => c.charCodeAt(0))).load()));
    faces.forEach(f => document.fonts.add(f));
    const c = document.createElement('canvas'); c.width = c.height = 720;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    return faces.map((_, i) => {
      ctx.clearRect(0, 0, 720, 720); ctx.fillStyle = '#000'; ctx.font = `640px StrokeWidthQA${i}`;
      ctx.textBaseline = 'alphabetic'; ctx.fillText('가', 20, 640);
      const pixels = ctx.getImageData(340, 0, 1, 720).data; let run = 0, runs = [];
      for (let y = 0; y < 720; y++) { if (pixels[y * 4 + 3] >= 128) run++; else if (run) { runs.push(run); run = 0; } }
      if (run) runs.push(run); return runs;
    });
  }, encoded);
}
async function normalFlow(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, acceptDownloads: true });
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await seed(page, saved(basic)); await page.goto(url, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#thickness-details').count(), 0, 'old independent experiment is removed');
  assert(await page.locator('#auto-stroke').isChecked(), 'old saved data defaults to on');
  assert.equal(await page.locator('#thickness-strength').inputValue(), '100');
  assert.equal(await page.locator('#thickness-target').inputValue(), '100');
  assert(await page.locator('#stroke-result').isHidden(), 'no demo poses as the user drawing');
  const rawSamples = await page.evaluate(() => JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples);
  await page.locator('#stroke-requested').fill('가 고 갸 힣');
  const defaultPreview = await compare(page, 'default');
  assert.equal(await page.locator('#stroke-before').innerText(), '가 고 갸');
  assert.equal(await page.locator('#stroke-after').innerText(), '가 고 갸');
  assert.match(await page.locator('#stroke-status').innerText(), /표시하지 않은 글자: 힣/);
  assert.match(await page.locator('#stroke-result-summary').innerText(), /맞춤 적용 2자.*일부 적용 1자/);
  await page.locator('.stroke-result-details summary').click();
  assert.match(await page.locator('#stroke-glyph-status').innerText(), /가: 맞춤 적용/);
  assert.match(await page.locator('#stroke-glyph-status').innerText(), /갸: 일부 자모만 맞춤/);
  assert.equal(defaultPreview.outputs[1].design.vectorStrength, 100);
  assert.equal(defaultPreview.outputs[1].design.vectorTarget, 100);
  const defaultFont = await build(page, 'default.ttf');
  console.log(verify([defaultPreview.after, defaultFont], `a,b=fonts\nfor c in '가고갸0': assert shape(a,c)==shape(b,c),(c,'preview differs from actual TTF')`));

  await slider(page, '#thickness-target', 70);
  assert.match(await page.locator('#font-state').innerText(), /다시 생성 필요/);
  assert.match(await page.locator('#download-font').innerText(), /이전 상태 TTF/);
  assert(await page.locator('#stroke-result').isHidden());
  assert.match(await page.locator('#stroke-status').innerText(), /다시 눌러/);
  const thinPreview = await compare(page, 'thin');
  assert.equal(thinPreview.outputs[1].design.vectorTarget, 70);
  const thinFont = await build(page, 'thin.ttf');
  assert.match(await page.locator('#correction-report-text').innerText(), /기준 굵기 70%/);
  console.log(verify([thinPreview.after, thinFont], `a,b=fonts\nfor c in '가고갸0': assert shape(a,c)==shape(b,c),(c,'thin preview differs')`));

  await slider(page, '#thickness-target', 130); const thickPreview = await compare(page, 'thick');
  const thickFont = await build(page, 'thick.ttf');
  console.log(verify([thickPreview.after, thickFont], `a,b=fonts\nfor c in '가고갸0': assert shape(a,c)==shape(b,c),(c,'thick preview differs')`));
  await slider(page, '#thickness-target', 100); await slider(page, '#thickness-strength', 50);
  const halfPreview = await compare(page, 'half'); const halfFont = await build(page, 'half.ttf');
  assert.match(await page.locator('#correction-report-text').innerText(), /맞추는 정도 50%/);
  console.log(verify([halfPreview.after, halfFont], `a,b=fonts\nfor c in '가고갸0': assert shape(a,c)==shape(b,c),(c,'50 percent preview differs')`));

  await slider(page, '#thickness-strength', 0);
  assert(await page.locator('#thickness-target').isDisabled(), 'target has no effect at zero strength');
  const zeroPreview = await compare(page, 'zero');
  assert.match(await page.locator('#stroke-result-summary').innerText(), /꺼져 있어 두 모습이 같아요/);
  const zeroFont = await build(page, 'zero.ttf');
  assert.equal(await page.locator('#correction-report-title').innerText(), '획 굵기 맞춤 꺼짐');
  assert.match(await page.locator('#correction-report-text').innerText(), /0%/);
  console.log(verify([zeroPreview.before, zeroPreview.after, zeroFont, defaultPreview.before], `a,b,c,d=fonts\nfor x in '가고갸ㄱ0': assert shape(a,x)==shape(b,x)==shape(c,x)==shape(d,x),(x,'0% must equal baseline')`));
  const measured = await widths(page, [thinFont, defaultFont, thickFont, halfFont, zeroFont]);
  assert(measured.every(r => r.length === 2), JSON.stringify(measured));
  const [thin, normal, thick, half, original] = measured.map(r => r[0]);
  assert(thin < normal && normal < thick, `target controls actual TTF width: ${JSON.stringify(measured)}`);
  assert(normal < half && half < original, `strength interpolates toward the original: ${JSON.stringify(measured)}`);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples), rawSamples, 'writing and manual paint stay unchanged');
  console.log(`${browserName}: target/strength in actual downloaded outlines; widths ${JSON.stringify(measured)}`);

  const fresh = await context.newPage(); await fresh.goto(url);
  assert.equal(await fresh.locator('#thickness-strength').inputValue(), '0');
  assert.equal(await fresh.locator('#thickness-target').inputValue(), '100');
  assert(await fresh.locator('#thickness-target').isDisabled()); await fresh.close();
  await page.locator('#auto-stroke').uncheck();
  assert(await page.locator('#thickness-strength').isDisabled());
  const another = await context.newPage(); await another.goto(url);
  assert(!await another.locator('#auto-stroke').isChecked(), 'toggle persists'); await another.close();
  await page.locator('#auto-stroke').check(); await slider(page, '#thickness-strength', 50); await slider(page, '#thickness-target', 130);
  assert.match(await page.locator('#stroke-export-summary').innerText(), /50%.*130%/);
  await page.locator('#stroke-requested').fill('가A'); await page.locator('#stroke-compare').click();
  assert.match(await page.locator('#stroke-status').innerText(), /한글 음절만/);
  await page.locator('#stroke-requested').fill('가각갂갃간갅갆갇갈갉갊갋갌갍갎갏감갑값갓갔강갖갗');
  await page.locator('#stroke-compare').click(); assert.match(await page.locator('#stroke-status').innerText(), /20자 이내/);

  // A changed setting while a slow job runs must never show a stale preview as current.
  await page.locator('#stroke-requested').fill('가 고 갸'); await page.evaluate(() => { window.__slowPreview = true; });
  await page.locator('#stroke-compare').click(); await slider(page, '#thickness-target', 70);
  await page.waitForFunction(() => !document.querySelector('#stroke-compare').disabled, null, { timeout: 120000 });
  assert(await page.locator('#stroke-result').isHidden()); assert.match(await page.locator('#stroke-status').innerText(), /바뀌었어요/);
  await page.evaluate(() => { window.__slowPreview = false; });
  const width = await page.evaluate(() => ({ inner: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert(width.scroll <= width.inner + 1, JSON.stringify(width)); assert.deepEqual(errors, []);
  await context.close(); return { defaultFont, zeroFont };
}
async function designerConsistency(browser) {
  const L = [], V = [];
  for (let i = 0; i <= 40; i++) L.push([.15 + .0075 * i, .24 + (i === 40 ? 0 : .003 * Math.sin(i * 1.8))]);
  for (let i = 1; i <= 44; i++) L.push([.45 + .003 * Math.sin(i * 1.8 + 1), .24 + .01 * i]);
  for (let i = 0; i <= 55; i++) V.push([.68 + .003 * Math.sin(i * 1.8), .15 + .011 * i]);
  const wavy = { version: 2, actions: [
    ...[L,V].map(points => ({ kind: 'ink', device: 'touch', points })),
    ...[L,V].map((points, i) => ({ kind: 'paint', role: i ? 'V' : 'L', width: .12, points }))
  ] };
  const page = await browser.newPage({ acceptDownloads: true }); await seed(page, saved({ 가: wavy })); await page.goto(url);
  await slider(page, '#design-cleanup', 100); await page.locator('#design-device').selectOption('touch');
  await slider(page, '#design-spacing', 130); await slider(page, '#design-word', 750); await slider(page, '#design-va', 80);
  await slider(page, '#thickness-strength', 70); await slider(page, '#thickness-target', 110);
  await page.locator('#stroke-requested').fill('가갸'); const preview = await compare(page, 'designer');
  assert.equal(preview.outputs[1].design.cleanupStrength, 100); assert.equal(preview.outputs[1].design.letterSpacing, 130);
  assert.equal(preview.outputs[1].design.wordSpace, 750); assert.equal(preview.outputs[1].design.verticalOffset, 80);
  const actual = await build(page, 'designer-settings.ttf'); assert.match(await page.locator('#result-warning').innerText(), /흔들림 정리 적용: 가/);
  console.log(verify([preview.after, actual], `a,b=fonts\nfor c in '가갸ㄱ': assert shape(a,c)==shape(b,c),(c,'cleanup/metrics preview differs')`));
  await page.close(); console.log(`${browserName}: preview honors actual cleanup, spacing, vertical and stroke settings`);
}
async function safety(browser) {
  const page = await browser.newPage({ acceptDownloads: true }); await seed(page, saved(risk)); await page.goto(url);
  await page.locator('#stroke-requested').fill('가고'); const preview = await compare(page, 'risk');
  assert.equal(preview.outputs[1].report.byChar['가'].status, 'kept');
  await page.locator('.stroke-result-details summary').click();
  assert.match(await page.locator('#stroke-glyph-status').innerText(), /가: 맞춤 전 윤곽 유지.*덩어리·구멍/);
  const on = await build(page, 'risk-on.ttf'); await page.locator('#auto-stroke').uncheck(); const off = await build(page, 'risk-off.ttf');
  console.log(verify([preview.before, preview.after, on, off], `a,b,c,d=fonts\nassert shape(a,'가')==shape(b,'가')==shape(c,'가')==shape(d,'가'), 'unsafe merge must preserve baseline'\nassert shape(b,'고')==shape(c,'고')!=shape(d,'고'), 'safe glyph must still be corrected'`));
  await page.close(); console.log(`${browserName}: unsafe shape and per-character reasons are consistent in preview and TTF`);
}
async function fallback(browser, reference) {
  const page = await browser.newPage({ acceptDownloads: true }); await seed(page, saved(basic));
  await page.route('**/worker.js*', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: `self.OffscreenCanvas = undefined;\n${workerSource}` }));
  await page.goto(url); await page.locator('#stroke-requested').fill('가 고 갸');
  await compare(page, 'canvas-fallback', false);
  assert.match(await page.locator('#stroke-status').innerText(), /브라우저 호환 모드/);
  const dom = await build(page, 'canvas-fallback.ttf'); assert.match(await page.locator('#build-status').innerText(), /브라우저 호환 모드/);
  console.log(verify([reference.defaultFont, dom], `a,b=fonts\nfor c in '가고갸ㄱ0': assert shape(a,c)==shape(b,c),(c,'worker and DOM canvas differ')`)); await page.close();
  const missing = await browser.newPage({ acceptDownloads: true }); await seed(missing, saved(basic), 'no-path2d'); await missing.goto(url);
  await missing.locator('#stroke-requested').fill('가 고 갸'); await compare(missing, 'unavailable', false);
  assert.match(await missing.locator('#stroke-result-summary').innerText(), /이 브라우저에서.*맞춤 전 윤곽/);
  const kept = await build(missing, 'unavailable.ttf'); assert.match(await missing.locator('#correction-report-title').innerText(), /사용할 수 없어요/);
  console.log(verify([reference.zeroFont, kept], `a,b=fonts\nfor c in '가고갸ㄱ0': assert shape(a,c)==shape(b,c),(c,'unavailable canvas must preserve baseline')`));
  await missing.close(); console.log(`${browserName}: comparison and export use DOM-canvas fallback; missing canvas preserves outlines`);
}
(async () => {
  const browser = await browserType.launch({ headless: true, ...(browserName === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
  try { const reference = await normalFlow(browser); await designerConsistency(browser); await safety(browser); await fallback(browser, reference); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
