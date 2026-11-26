'use strict';
// Start the app on :4173 first, then npm run test:browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const url = process.env.APP_URL || 'http://127.0.0.1:4173/';

async function stroke(page, points) {
  const pad = page.locator('#pad');
  await pad.scrollIntoViewIfNeeded();
  const box = await pad.boundingBox();
  const pos = ([x, y]) => [box.x + box.width * x, box.y + box.height * y];
  await page.mouse.move(...pos(points[0])); await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...pos(p), { steps: 10 });
  await page.mouse.up();
}
async function saved(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('geulmoa-drawing-v1')));
}
async function assertSingleBoard(page) {
  const layout = await page.locator('#board').evaluate(board => ({
    canvases: board.querySelectorAll('canvas').length,
    guides: board.querySelectorAll('svg, .board-guides').length,
    before: getComputedStyle(board, '::before').content,
    after: getComputedStyle(board, '::after').content,
  }));
  assert.equal(layout.canvases, 1, 'write in one canvas');
  assert.equal(layout.guides, 0, 'no initial, medial or final boxes');
  assert(['none', 'normal'].includes(layout.before), 'no horizontal guide line');
  assert(['none', 'normal'].includes(layout.after), 'no vertical guide line');
}
async function testDesktop(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      window.__fontJob = message.samples.map(s => {
        const arrays = Object.fromEntries(Object.entries(s.roles).map(([k, v]) => [k, new Uint8Array(v)]));
        const counts = Object.fromEntries(Object.entries(arrays).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0)]));
        let overlap = 0;
        for (let i = 0; i < s.size * s.size; i++) if (Object.values(arrays).reduce((n, v) => n + v[i], 0) > 1) overlap++;
        return { char: s.char, counts, overlap };
      });
      return post.call(this, message, transfer);
    };
  });
  await page.goto(url);
  await assertSingleBoard(page);
  assert(await page.locator('#mode-color').isDisabled());
  await page.locator('.sample-chip', { hasText: '가' }).first().click();
  // One natural connected drawing, not tagged as 초성 while writing.
  await stroke(page, [[.19,.26],[.49,.26],[.49,.70],[.49,.50],[.69,.50],[.69,.20],[.69,.78]]);
  let s = await saved(page);
  assert.equal(s.samples['가'].version, 2);
  assert(s.samples['가'].actions.every(a => a.kind === 'ink' && !a.role));
  assert(await page.locator('#mode-color').isEnabled());
  await page.locator('#build-font').click();
  assert.match(await page.locator('#build-status').innerText(), /색칠을 완료한 글자만/);
  await page.locator('#mode-color').click();
  await assertSingleBoard(page);
  assert.match(await page.locator('#paint-status').innerText(), /칠하지 않은 획 100%/);
  await stroke(page, [[.19,.26],[.49,.26],[.49,.70]]);
  assert.match(await page.locator('#paint-status').innerText(), /중성 필요/);
  await page.locator('.role-tab[data-role="V"]').click();
  await stroke(page, [[.49,.50],[.69,.50],[.69,.20],[.69,.78]]);
  assert.match(await page.locator('#paint-status').innerText(), /모든 획을 자모별로 나눴어요/);
  assert(await page.locator('.sample-chip.done', { hasText: '가' }).count());

  // Erase only a label, then undo. The handwriting must not disappear.
  await page.locator('#paint-erase').click();
  await stroke(page, [[.25,.26],[.29,.26]]);
  assert.match(await page.locator('#paint-status').innerText(), /칠하지 않은 획/);
  await page.locator('#next-step').click();
  assert.match(await page.locator('#draw-message').innerText(), /남은 획/);
  await page.locator('#undo').click();
  assert.match(await page.locator('#paint-status').innerText(), /모든 획을 자모별로 나눴어요/);
  await page.reload();
  assert.equal(await page.locator('#mode-color').getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#paint-status').innerText(), /모든 획을 자모별로 나눴어요/);

  // A syllable with a final consonant gets its own third, distinct mask.
  await page.locator('.sample-chip', { hasText: '각' }).first().click();
  const lead = [[.17,.18],[.44,.18],[.44,.51]], vowel = [[.68,.13],[.68,.56],[.82,.56]], final = [[.24,.75],[.72,.75],[.72,.88]];
  await stroke(page, lead); await stroke(page, vowel); await stroke(page, final);
  await page.locator('#mode-color').click();
  await stroke(page, lead);
  await page.locator('.role-tab[data-role="V"]').click(); await stroke(page, vowel);
  await page.locator('.role-tab[data-role="T"]').click(); await stroke(page, final);
  assert.match(await page.locator('#paint-status').innerText(), /모든 획을 자모별로 나눴어요/);

  await page.locator('#build-font').click();
  await page.waitForFunction(() => !document.querySelector('#download-font').hidden, { timeout: 120000 });
  const job = await page.evaluate(() => window.__fontJob);
  const ga = job.find(s => s.char === '가');
  assert(ga && ga.counts.L > 0 && ga.counts.V > 0, 'separate roles must actually reach the worker');
  assert.equal(ga.overlap, 0, 'a pixel cannot silently be assigned to multiple roles');
  const gak = job.find(s => s.char === '각');
  assert(gak && gak.counts.L > 0 && gak.counts.V > 0 && gak.counts.T > 0 && gak.overlap === 0, 'initial, medial and final masks must all reach the worker');
  await page.locator('#inspect-char').fill('가');
  assert.match(await page.locator('#inspect-status').innerText(), /직접 쓴 원본/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-font').click()]);
  const output = process.env.TEST_TTF || path.join(os.tmpdir(), 'geulmoa-manual-color-test.ttf');
  await download.saveAs(output);
  assert.deepEqual([...fs.readFileSync(output).subarray(0, 4)], [0, 1, 0, 0], 'download is a TrueType file');
  if (!process.env.TEST_TTF) fs.rmSync(output);

  // A second uncolored glyph is excluded rather than incorrectly reported as original.
  await page.locator('#custom-char').fill('국'); await page.locator('#add-custom').click();
  await stroke(page, [[.18,.25],[.48,.25],[.48,.44]]);
  await page.locator('#build-font').click();
  await page.waitForFunction(() => !document.querySelector('#build-font').disabled, { timeout: 120000 });
  assert.match(await page.locator('#result-warning').innerText(), /제외한 글자: 국/);
  assert.deepEqual((await page.evaluate(() => window.__fontJob)).map(s => s.char), ['가', '각']);

  // Old broad paint applied before new ink must not classify the new ink.
  await page.locator('.sample-chip', { hasText: '가' }).first().click();
  await page.locator('.role-tab[data-role="L"]').click();
  await stroke(page, [[.86,.80],[.88,.82]]); // brush only on empty paper
  await page.locator('#mode-draw').click();
  await stroke(page, [[.86,.80],[.88,.82]]); // newly written ink
  await page.locator('#mode-color').click();
  assert.match(await page.locator('#paint-status').innerText(), /칠하지 않은 획/, 'new ink must stay unclassified');
  await page.locator('#undo').click(); // remove new ink, not the original glyph
  assert.match(await page.locator('#paint-status').innerText(), /모든 획을 자모별로 나눴어요/);

  // Reset color without resetting ink.
  page.once('dialog', d => d.accept());
  await page.locator('#clear-colors').click();
  assert.match(await page.locator('#paint-status').innerText(), /칠하지 않은 획 100%/);
  s = await saved(page);
  assert.equal(s.samples['가'].actions.filter(a => a.kind === 'ink').length, 1);
  assert.equal(s.samples['가'].actions.filter(a => a.kind === 'paint').length, 0);
  page.once('dialog', d => d.accept()); await page.locator('#reset-all').click();
  assert.equal(await page.locator('#target-char').innerText(), '는');
  assert.equal(await page.locator('#mode-draw').getAttribute('aria-pressed'), 'true');
  assert(await page.locator('#mode-color').isDisabled());
  assert.deepEqual(errors, []);
  console.log('desktop: write → color → correct → save → generate TTF passed');
  await page.close();
}
async function testMigration(browser) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(url);
  await page.evaluate(() => localStorage.setItem('geulmoa-drawing-v1', JSON.stringify({
    samples: { 가: [
      { role: 'L', points: [[.2,.25],[.5,.25],[.5,.7]] },
      { role: 'L', points: [[.7,.2],[.7,.8]] },
    ] }, custom: [], current: '가', fontName: 'Legacy', preview: ''
  })));
  await page.reload();
  assert.match(await page.locator('#draw-message').innerText(), /이전에 쓴 글씨/);
  assert.match(await page.locator('#paint-status').innerText(), /중성 필요/);
  const before = await saved(page);
  assert.equal(before.samples['가'].actions.length, 2);
  await page.locator('.role-tab[data-role="V"]').click();
  await stroke(page, [[.7,.2],[.7,.8]]);
  assert.match(await page.locator('#paint-status').innerText(), /모든 획을 자모별로 나눴어요/);
  console.log('legacy: retain handwriting and recolor previously misclassified vowel passed');
  await page.close();
}
async function testLiteral(browser) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(url);
  await page.locator('.sample-chip').filter({ hasText: /^0$/ }).click();
  assert(await page.locator('#mode-color').isHidden(), 'digits do not need jamo coloring');
  await stroke(page, [[.5,.2],[.25,.3],[.22,.65],[.5,.8],[.78,.65],[.75,.3],[.5,.2]]);
  await page.locator('#build-font').click();
  await page.waitForFunction(() => !document.querySelector('#download-font').hidden, { timeout: 120000 });
  assert.match(await page.locator('#stat-extra').innerText(), /1/);
  assert.match(await page.locator('#stat-coverage').innerText(), /^0/);
  console.log('literal: digit builds without manual separation passed');
  await page.close();
}
async function testMobile(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  async function touch(points) {
    await page.locator('#pad').scrollIntoViewIfNeeded();
    await page.locator('#pad').evaluate((c, pts) => {
      const r = c.getBoundingClientRect();
      pts.forEach(([x,y], i) => c.dispatchEvent(new PointerEvent(i === 0 ? 'pointerdown' : i === pts.length - 1 ? 'pointerup' : 'pointermove', {
        bubbles: true, cancelable: true, pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: r.x + x * r.width, clientY: r.y + y * r.height
      })));
    }, points);
  }
  const lead = [[.2,.1],[.2,.35],[.8,.35]], vowel = [[.2,.5],[.5,.5],[.8,.5]], final = [[.25,.72],[.25,.85],[.75,.85]];
  await touch(lead); await touch(vowel); await touch(final);
  assert(await page.locator('#mode-color').isEnabled());
  await page.locator('#mode-color').click();
  await touch(lead);
  assert.equal(await page.locator('.role-tab[data-role="L"]').getAttribute('aria-pressed'), 'true');
  assert(await page.locator('.role-tab[data-role="L"]').evaluate(el => el.classList.contains('done')));
  await page.locator('.role-tab[data-role="V"]').click(); await touch(vowel);
  await page.locator('.role-tab[data-role="T"]').click(); await touch(final);
  assert.match(await page.locator('#paint-status').innerText(), /모든 획을 자모별로 나눴어요/);
  const dims = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert(dims[0] <= dims[1], `mobile horizontal overflow: ${dims}`);
  assert.deepEqual(errors, []);
  console.log('mobile: touch drawing and painting passed');
  await page.close();
}
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try { await testDesktop(browser); await testMigration(browser); await testLiteral(browser); await testMobile(browser); }
  finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
