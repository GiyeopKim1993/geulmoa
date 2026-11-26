'use strict';
// Full 11,172-syllable regression of the actual default-on TTF, using only
// synthetic paths. Every glyph reported as kept/same is checked against the
// downloaded default-off font; a substantial set must really be different.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { chromium, firefox, webkit } = require('playwright');
const samples = require('./fixtures/full-hangul');
const browserName = process.env.TEST_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unknown TEST_BROWSER: ${browserName}`);
const url = process.env.APP_URL || 'http://127.0.0.1:4176/';
const OUT = process.env.VECTOR_FULL_TEST_DIR || path.join(os.tmpdir(), `geulmoa-auto-vector-full-${browserName}`);
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const browser = await browserType.launch({ headless: true, ...(browserName === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((samples) => {
      localStorage.setItem('geulmoa-drawing-v1', JSON.stringify({ samples, custom: [], current: '가', fontName: 'Full Vector QA', preview: '안녕하세요. 가각 곽 성 공' }));
      window.__results = []; window.__ticks = 0; setInterval(() => window.__ticks++, 25);
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(message, transfer) {
        if (message.design) this.addEventListener('message', ({ data }) => { if (data.type === 'done') window.__results.push(data.strokeCorrection); });
        return send.call(this, message, transfer);
      };
    }, samples);
    await page.goto(url); const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples);
    assert(await page.locator('#auto-stroke').isChecked());
    async function build(name) {
      const n = await page.evaluate(() => window.__results.length), start = Date.now();
      await page.locator('#build-font').click();
      await page.waitForFunction((n) => !document.querySelector('#build-font').disabled &&
        (window.__results.length > n || document.querySelector('#build-status').classList.contains('error')), n, { timeout: 240000 });
      const status = await page.locator('#build-status').innerText();
      assert(!await page.locator('#build-status').evaluate((el) => el.classList.contains('error')), status);
      assert.match(await page.locator('#stat-coverage').innerText(), /11,172/);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#download-font').click()]);
      const file = path.join(OUT, name); await dl.saveAs(file);
      return { file, ms: Date.now() - start, meta: await page.evaluate((n) => window.__results[n], n) };
    }
    const on = await build('full-auto.ttf');
    assert.equal(on.meta.original.total, 25); assert.equal(on.meta.composed.total, 11147);
    assert(on.meta.original.adjusted > 0 && on.meta.composed.adjusted + on.meta.composed.partial > 100);
    const collisionReason = '자모 사이의 획이 닿거나 닿을 수 있음';
    assert(on.meta.reasons[collisionReason] > 0, 'inter-role safety is actually exercised');
    assert(Object.values(on.meta.byChar).some((v) => v.status === 'kept' && v.reasons.includes(collisionReason)));
    assert.match(await page.locator('#correction-report-title').innerText(), /자동 보정 결과/);
    await page.locator('#auto-stroke').uncheck(); const off = await build('full-off.ttf');
    assert.equal(off.meta.original.off, 25); assert.equal(off.meta.composed.off, 11147);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('geulmoa-drawing-v1')).samples), saved);
    const meta = path.join(OUT, 'full-metadata.json'); fs.writeFileSync(meta, JSON.stringify(on.meta.byChar));
    const py = `from fontTools.ttLib import TTFont\nimport sys,json,collections\na,b=map(TTFont,sys.argv[1:3]); meta=json.load(open(sys.argv[3],encoding='utf8'))\nca,cb=a.getBestCmap(),b.getBestCmap()\nassert all(i in ca and i in cb for i in range(0xac00,0xd7a4))\nassert len(meta)==11172\ndef shape(f,cmap,c):\n g=f['glyf'][cmap[ord(c)]]\n coords,ends,flags=g.getCoordinates(f['glyf'])\n return (tuple(coords),tuple(ends),tuple(flags))\ncounts=collections.Counter(); changed=collections.Counter(); failed=[]\nfor ch,info in meta.items():\n s=info['status']; counts[s]+=1\n same=shape(a,ca,ch)==shape(b,cb,ch)\n if s in ('kept','same') and not same: failed.append((ch,s,info['reasons']))\n if not same: changed[s]+=1\nassert not failed,('unsafe or unchanged glyph differs',failed[:10])\nassert changed['adjusted']>100 and changed['partial']>100,changed\nprint('11,172 glyphs verified; per-status counts',dict(counts),'actual changed',dict(changed))`;
    console.log(execFileSync('python', ['-c', py, on.file, off.file, meta], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim());
    assert(await page.evaluate(() => window.__ticks) > 10, 'worker allows the main page to run');
    assert.deepEqual(errors, []);
    console.log(`${browserName}: full default-on TTF ${on.ms}ms; baseline ${off.ms}ms; ${fs.statSync(on.file).size} bytes; every retained/same outline preserved`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
