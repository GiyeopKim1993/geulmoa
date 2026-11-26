'use strict';
// End-to-end tests for the DEFAULT-ON vector correction in the real TTF job.
// Synthetic shapes only; they do not represent real handwriting.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { chromium, firefox, webkit } = require('playwright');
const browserName = process.env.TEST_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unknown TEST_BROWSER: ${browserName}`);
const url = process.env.APP_URL || 'http://127.0.0.1:4176/';
const OUT = process.env.VECTOR_TEST_DIR || path.join(os.tmpdir(), `geulmoa-auto-vector-${browserName}`);
fs.mkdirSync(OUT, { recursive: true });
const workerSource = fs.readFileSync(path.join(__dirname, '../site/worker.js'), 'utf8');

function parallelLines(ch, left, right, y1, y2) {
  const ink = [], paint = [];
  for (const [role, y] of [['L', y1], ['V', y2]]) {
    const points = [[left, y], [right, y]];
    ink.push({ kind: 'ink', points }); paint.push({ kind: 'paint', role, width: .12, points });
  }
  return [ch, { version: 2, actions: [...ink, ...paint] }];
}
function state(samples, fontName = 'Vector QA') {
  return { samples, custom: [], current: '가', fontName, preview: '가 고 갸 0' };
}
const basic = Object.fromEntries([
  parallelLines('가', .35, .65, .38, .62),
  parallelLines('고', .15, .85, .28, .72),
]);
basic['0'] = { version: 2, actions: [{ kind: 'ink', points: [[.4,.2],[.2,.4],[.4,.8],[.7,.4],[.4,.2]] }] };
const risk = Object.fromEntries([
  parallelLines('가', .2, .8, .48, .53),
  parallelLines('고', .42, .58, .46, .54),
]);
async function seed(page, saved, mode = 'normal') {
  await page.addInitScript(({ saved, mode }) => {
    localStorage.setItem('geulmoa-drawing-v1', JSON.stringify(saved));
    window.__vectorJobs = []; window.__vectorResults = []; window.__workerAttempts = [];
    const NativeWorker = window.Worker;
    if (mode === 'no-path2d') { window.Worker = undefined; window.Path2D = undefined; return; }
    if (mode === 'bad-offscreen') { window.Worker = undefined; window.OffscreenCanvas = class { getContext() { return null; } }; return; }
    window.Worker = function(source, options) {
      window.__workerAttempts.push(String(source));
      const w = new NativeWorker(source, options), send = w.postMessage.bind(w);
      w.postMessage = (message, transfer) => {
        if (message.design) {
          window.__vectorJobs.push({ enabled: message.design.vectorCorrection,
            samples: message.samples.map((s) => ({ char: s.char, strokes: s.strokes })) });
          w.addEventListener('message', ({ data }) => {
            if (data.type === 'done') window.__vectorResults.push(data.strokeCorrection);
          });
        }
        return send(message, transfer);
      };
      return w;
    };
  }, { saved, mode });
}
async function build(page, filename, { workerResult = true } = {}) {
  const count = await page.evaluate(() => window.__vectorResults.length);
  await page.locator('#build-font').click();
  await page.waitForFunction(({ count, workerResult }) => !document.querySelector('#build-font').disabled &&
    (document.querySelector('#build-status').classList.contains('error') ||
      (!document.querySelector('#download-font').hidden && (!workerResult || window.__vectorResults.length > count))),
    { count, workerResult }, { timeout: 120000 });
  const status = await page.locator('#build-status').innerText();
  assert(!await page.locator('#build-status').evaluate((el) => el.classList.contains('error')), status);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-font').click()]);
  const file = path.join(OUT, filename); await download.saveAs(file);
  assert.deepEqual([...fs.readFileSync(file).subarray(0, 4)], [0, 1, 0, 0]);
  return file;
}
function compareFonts(files, expression) {
  const py = `from fontTools.ttLib import TTFont\nimport sys\nfonts=[TTFont(p) for p in sys.argv[1:]]\ndef shape(f,c):\n name=f.getBestCmap()[ord(c)]\n g=f['glyf'][name]\n coords, ends, flags=g.getCoordinates(f['glyf'])\n return (tuple(coords),tuple(ends),tuple(flags))\n${expression}\nprint('fontTools outlines verified')`;
  return execFileSync('python', ['-c', py, ...files], { encoding: 'utf8' }).trim();
}
async function compareRenderedWidths(page, onFile, offFile, target) {
  const data = [onFile, offFile].map((file) => fs.readFileSync(file).toString('base64'));
  const result = await page.evaluate(async ([on, off]) => {
    const faces = await Promise.all([
      new FontFace('VectorAutoWidth', Uint8Array.from(atob(on), (c) => c.charCodeAt(0))).load(),
      new FontFace('VectorBaselineWidth', Uint8Array.from(atob(off), (c) => c.charCodeAt(0))).load(),
    ]);
    faces.forEach((face) => document.fonts.add(face));
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 720;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    function runs(ch, family) {
      ctx.clearRect(0, 0, 720, 720); ctx.fillStyle = '#000'; ctx.font = `640px ${family}`;
      ctx.textBaseline = 'alphabetic'; ctx.fillText(ch, 20, 640);
      const pixels = ctx.getImageData(340, 0, 1, 720).data, out = []; let n = 0;
      for (let y = 0; y < 720; y++) {
        if (pixels[y * 4 + 3] >= 128) n++;
        else if (n) { out.push(n); n = 0; }
      }
      if (n) out.push(n); return out;
    }
    return { on: [runs('가', 'VectorAutoWidth'), runs('고', 'VectorAutoWidth')],
      off: [runs('가', 'VectorBaselineWidth'), runs('고', 'VectorBaselineWidth')] };
  }, data);
  assert(result.on.every((r) => r.length === 2) && result.off.every((r) => r.length === 2), JSON.stringify(result));
  assert(result.off[0][0] > result.off[1][0] + 10, `different source scales: ${JSON.stringify(result)}`);
  assert(Math.abs(result.on[0][0] - result.on[1][0]) <= 3, `corrected actual TTF widths match: ${JSON.stringify(result)}`);
  assert(Math.abs(result.on[0][0] - target * .64) <= 4, `corrected actual TTF matches target: ${JSON.stringify(result)} target=${target}`);
  return result;
}
async function basicFlow(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await seed(page, state(basic)); await page.goto(url, { waitUntil: 'domcontentloaded' });
  assert(await page.locator('#auto-stroke').isChecked(), 'old stored data defaults to correction on');
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples);
  const onFile = await build(page, `${browserName}-auto.ttf`);
  const job = await page.evaluate(() => window.__vectorJobs[0]);
  const correction = await page.evaluate(() => window.__vectorResults[0]);
  assert.equal(job.enabled, true); assert(job.samples.every((s) => s.strokes.length));
  assert.equal(correction.original.adjusted, 2); assert.equal(correction.byChar['가'].status, 'adjusted');
  assert.equal(correction.byChar['고'].status, 'adjusted'); assert.equal(correction.byChar['갸'].status, 'partial');
  assert.equal(correction.extrasKept, 1); assert(correction.jamo.adjusted > 0);
  assert.match(await page.locator('#correction-report-text').innerText(), /직접 쓴 음절 2자/);
  assert.match(await page.locator('#correction-report-kept').innerText(), /보정 전 음절 윤곽 유지/);
  await page.locator('#correction-report-more summary').click();
  assert.match(await page.locator('#correction-report-detail').innerText(), /숫자·기호 1자는 원래 윤곽/);
  await page.locator('#inspect-char').fill('가'); assert.match(await page.locator('#inspect-status').innerText(), /벡터 획 굵기를 보정/);
  await page.locator('#inspect-char').fill('갸'); assert.match(await page.locator('#inspect-status').innerText(), /일부 자모만/);
  await page.locator('#auto-stroke').uncheck();
  assert.match(await page.locator('#font-state').innerText(), /다시 생성 필요/);
  const offFile = await build(page, `${browserName}-off.ttf`);
  assert.equal(await page.locator('#correction-report-title').innerText(), '벡터 획 보정 꺼짐');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples), before, 'neither paths nor manual paint are changed');
  console.log(compareFonts([onFile, offFile], `a,b=fonts\nfor c in '가고갸ㄱ': assert shape(a,c)!=shape(b,c),(c,'must change in the real TTF')\nassert shape(a,'0')==shape(b,'0'), 'digits retain their old outline'`));
  const widths = await compareRenderedWidths(page, onFile, offFile, correction.target);
  const overflow = await page.evaluate(() => ({ inner: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert(overflow.scroll <= overflow.inner + 1, JSON.stringify(overflow));
  const fresh = await page.context().newPage(); await fresh.goto(url);
  assert(!await fresh.locator('#auto-stroke').isChecked(), 'off preference persists in the same origin'); await fresh.close();
  assert.deepEqual(errors, []); await context.close();
  console.log(`${browserName}: default on/off, real downloaded outlines, constant width, standalone jamo, digit fallback and mobile UI passed ${JSON.stringify(widths)}`);
  return { onFile, offFile };
}
async function topologyGuard(browser) {
  const page = await browser.newPage({ acceptDownloads: true }); await seed(page, state(risk, 'Merge QA'));
  await page.goto(url); const on = await build(page, `${browserName}-topology-on.ttf`);
  const result = await page.evaluate(() => window.__vectorResults[0]);
  assert.equal(result.byChar['가'].status, 'kept'); assert.match(result.byChar['가'].reasons.join(' '), /덩어리·구멍/);
  assert.equal(result.byChar['고'].status, 'adjusted');
  await page.locator('#inspect-char').fill('가'); assert.match(await page.locator('#inspect-status').innerText(), /윤곽을 유지/);
  await page.locator('#auto-stroke').uncheck(); const off = await build(page, `${browserName}-topology-off.ttf`);
  console.log(compareFonts([on, off], `a,b=fonts\nassert shape(a,'가')==shape(b,'가'), 'merging strokes must fall back in the actual TTF'\nassert shape(a,'고')!=shape(b,'고'), 'other safe sample remains corrected'`));
  await page.close(); console.log(`${browserName}: a stroke merge restores the pre-correction whole glyph`);
}
async function splitProbe(page, across, withStrokes = true, enabled = true) {
  return page.evaluate(async ({ across, withStrokes, enabled }) => {
    const size = 256, c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: true }), points = [[.2,.5],[.8,.5]];
    window.GeulmoaColoring.drawPath(ctx, points, size, .03, '#000');
    const rgba = ctx.getImageData(0, 0, size, size).data, L = new Uint8Array(size * size), V = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const p = y * size + x;
      if (rgba[p * 4 + 3] >= 100) { if (across ? y < 128 : x < 128) L[p] = 1; else V[p] = 1; }
    }
    const sample = { char: '가', size, roles: { L: L.buffer, V: V.buffer }, ...(withStrokes ? { strokes: [{ points }] } : {}) };
    const w = new Worker('worker.js');
    return await new Promise((resolve, reject) => {
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message)); };
      w.onmessage = ({ data }) => {
        if (data.type === 'error') { w.terminate(); reject(new Error(data.message)); }
        if (data.type === 'done') { w.terminate(); resolve({ meta: data.strokeCorrection, ttf: Array.from(new Uint8Array(data.ttf)) }); }
      };
      w.postMessage({ samples: [sample], name: 'Manual boundary QA', design: { vectorCorrection: enabled } });
    });
  }, { across, withStrokes, enabled });
}
async function manualBoundary(browser) {
  const page = await browser.newPage(); await page.goto(url);
  const along = await splitProbe(page, false), across = await splitProbe(page, true), off = await splitProbe(page, true, true, false);
  const legacy = await splitProbe(page, false, false), legacyOff = await splitProbe(page, false, false, false);
  assert.equal(along.meta.byChar['갸'].status, 'partial', 'a color boundary along a line is used');
  assert.equal(across.meta.byChar['갸'].status, 'kept', 'a boundary across a stroke cannot be recovered from its centerline');
  assert.match(across.meta.byChar['갸'].reasons.join(' '), /수동 색칠 경계/);
  assert.equal(legacy.meta.byChar['가'].status, 'kept', 'missing trajectories do not discard old drawings');
  const files = [];
  for (const [name, value] of [['across', across], ['off', off], ['legacy', legacy], ['legacyoff', legacyOff]]) {
    const file = path.join(OUT, `${browserName}-boundary-${name}.ttf`); fs.writeFileSync(file, Buffer.from(value.ttf)); files.push(file);
  }
  console.log(compareFonts(files, `a,b,c,d=fonts\nassert shape(a,'갸')==shape(b,'갸'), 'ambiguous manual coloring must preserve the existing outline'\nfor ch in '가갸': assert shape(c,ch)==shape(d,ch), ('missing path preserves legacy outline',ch)`));
  await page.close(); console.log(`${browserName}: along/across manual-color boundary and old data fallback passed`);
}
async function compatibility(browser, reference) {
  const page = await browser.newPage({ acceptDownloads: true }); const requests = [];
  await seed(page, state(basic)); page.on('request', (r) => { if (r.url().includes('/engine-main.js')) requests.push(r.url()); });
  await page.route('**/worker.js*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `self.OffscreenCanvas = undefined;\n${workerSource}` }));
  await page.goto(url); const fallback = await build(page, `${browserName}-dom-canvas.ttf`, { workerResult: false });
  assert.match(await page.locator('#build-status').innerText(), /브라우저 호환 모드/);
  assert.match(await page.locator('#correction-report-text').innerText(), /직접 쓴 음절 2자/);
  assert.equal(requests.length, 1); assert.equal((await page.evaluate(() => window.__workerAttempts)).length, 1, 'unsupported worker canvas goes directly to page engine');
  console.log(compareFonts([reference.onFile, fallback], `a,b=fonts\nfor ch in '가고갸ㄱ0': assert shape(a,ch)==shape(b,ch),(ch,'worker and DOM-canvas fallback differ')`));
  await page.close();
  const domCanvas = await browser.newPage({ acceptDownloads: true });
  await seed(domCanvas, state(basic), 'bad-offscreen'); await domCanvas.goto(url);
  const domFile = await build(domCanvas, `${browserName}-bad-offscreen.ttf`, { workerResult: false });
  assert.match(await domCanvas.locator('#correction-report-text').innerText(), /직접 쓴 음절 2자/);
  console.log(compareFonts([reference.onFile, domFile], `a,b=fonts\nfor ch in '가고갸ㄱ0': assert shape(a,ch)==shape(b,ch),(ch,'HTML canvas fallback differs')`));
  await domCanvas.close();
  const noCanvas = await browser.newPage({ acceptDownloads: true });
  await seed(noCanvas, state(basic), 'no-path2d'); await noCanvas.goto(url);
  const kept = await build(noCanvas, `${browserName}-unavailable.ttf`, { workerResult: false });
  assert.match(await noCanvas.locator('#correction-report-title').innerText(), /사용할 수 없어요/);
  console.log(compareFonts([reference.offFile, kept], `a,b=fonts\nfor ch in '가고갸ㄱ0': assert shape(a,ch)==shape(b,ch),(ch,'missing canvas must preserve previous outline')`));
  await noCanvas.close(); console.log(`${browserName}: worker canvas fallback and unavailable-canvas preservation passed`);
}
(async () => {
  const browser = await browserType.launch({ headless: true, ...(browserName === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
  try {
    const reference = await basicFlow(browser); await topologyGuard(browser); await manualBoundary(browser); await compatibility(browser, reference);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
