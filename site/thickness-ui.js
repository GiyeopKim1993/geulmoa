/* Local-only comparison: scale saved stroke paths, then choose pen width. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id), SIZE = 256;
  const roleName = { L: '초성', V: '중성', T: '종성', '전체': '전체' };
  let getLocal, parseImported, source = 'demo', worker = null, serial = 0;
  let faces = [], urls = [], available = new Set(), hasResult = false, labStarted = false;

  // These six drawings are synthetic, at two different source scales. The
  // input pen is the same width in all of them, just as in the writing pad.
  function demoSamples() {
    const circle = (cx, cy, rx, ry) => Array.from({ length: 33 }, (_, i) =>
      [cx + rx * Math.cos(2 * Math.PI * i / 32), cy + ry * Math.sin(2 * Math.PI * i / 32)]);
    const defs = [
      ['가', { L: [[[.34,.35],[.51,.35],[.51,.56]]], V: [[[.61,.31],[.61,.67]],[[.61,.48],[.68,.48]]] }],
      ['고', { L: [[[.35,.31],[.63,.31],[.63,.44]]], V: [[[.35,.64],[.65,.64]],[[.50,.64],[.50,.51]]] }],
      ['성', { L: [[[.34,.43],[.42,.31],[.49,.43]]], V: [[[.59,.30],[.59,.52]],[[.53,.40],[.59,.40]]], T: [circle(.48,.62,.075,.055)] }],
      ['각', { L: [[[.13,.14],[.46,.14],[.46,.51]]], V: [[[.70,.12],[.70,.58]],[[.70,.37],[.84,.37]]], T: [[[.22,.72],[.76,.72],[.76,.86]]] }],
      ['국', { L: [[[.13,.12],[.78,.12],[.78,.31]]], V: [[[.15,.46],[.77,.46]],[[.46,.46],[.46,.61]]], T: [[[.20,.73],[.75,.73],[.75,.86]]] }],
      ['공', { L: [[[.15,.12],[.77,.12],[.77,.30]]], V: [[[.17,.50],[.78,.50]],[[.48,.50],[.48,.35]]], T: [circle(.48,.75,.20,.085)] }],
    ];
    const c = document.createElement('canvas'); c.width = c.height = SIZE;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    return defs.map(([char, roles]) => {
      const masks = {}, strokes = [];
      for (const [role, paths] of Object.entries(roles)) {
        ctx.clearRect(0, 0, SIZE, SIZE);
        for (const points of paths) { window.GeulmoaColoring.drawPath(ctx, points, SIZE, 0.03, '#000'); strokes.push({ points }); }
        const rgba = ctx.getImageData(0, 0, SIZE, SIZE).data, mask = new Uint8Array(SIZE * SIZE);
        for (let p = 0; p < mask.length; p++) if (rgba[p * 4 + 3] >= 100) mask[p] = 1;
        // A painted pixel has one owner, including where sample strokes touch.
        for (const previous of Object.values(masks)) for (let p = 0; p < mask.length; p++) if (mask[p]) previous[p] = 0;
        masks[role] = mask;
      }
      return { char, size: SIZE, roles: Object.fromEntries(Object.entries(masks).map(([r,m]) => [r,m.buffer])), strokes };
    });
  }
  function setSource(next) {
    source = next;
    for (const [id, key] of [['thickness-demo', 'demo'], ['thickness-mine', 'mine']]) {
      $(id).classList.toggle('active', source === key); $(id).setAttribute('aria-pressed', String(source === key));
    }
    $('thickness-source-help').textContent = source === 'demo'
      ? '같은 펜으로 작게·크게 쓴 가상의 예시예요. 실제 손글씨가 아닙니다.'
      : source === 'mine'
        ? '이 실험 주소에서 쓰고 자모 색칠을 완료한 한글을 사용해요. 공개 사이트의 저장 내용은 자동으로 넘어오지 않아요.'
        : '붙여 넣은 공개 사이트의 저장 데이터를 이번 비교에만 사용하며, 이 실험 주소에 저장하지 않아요.';
  }
  function status(message, error = false) {
    $('thickness-status').textContent = message; $('thickness-status').classList.toggle('error', error);
  }
  function busy(isBusy) {
    for (const id of ['thickness-run', 'thickness-demo', 'thickness-mine', 'thickness-import', 'thickness-strength', 'thickness-target', 'thickness-requested']) $(id).disabled = isBusy;
    $('thickness-run').innerHTML = isBusy ? '비교 중 <span>···</span>' : '비교 만들기 <span>↗</span>';
  }
  function updateText() {
    const text = $('thickness-text').value.normalize('NFC');
    for (const id of ['thickness-before', 'thickness-after', 'thickness-small-before', 'thickness-small-after']) $(id).textContent = text;
    const absent = [...new Set([...text].filter((ch) => !/\s/u.test(ch) && !available.has(ch)))];
    $('thickness-fallback').textContent = absent.length
      ? `비교 폰트에 없는 글자 (기본 글꼴로 표시): ${absent.slice(0, 16).join(' ')}${absent.length > 16 ? ' …' : ''}` : '';
  }
  function labelStep(s) {
    const name = (roleName[s.role] || s.role) + (s.jamo ? ` ${s.jamo}` : '');
    const src = s.source ? ` · ${s.source}에서` : '';
    if (s.method === 'fallback') return `${name}: 기존 윤곽 유지 (${s.reason})${src}`;
    if (s.method === 'off') return `${name}: 기존 윤곽${src}`;
    return `${name}: 획 굵기 ${Math.round(s.after)}${src}`;
  }
  async function showResult(data) {
    const n = ++serial, beforeFamily = `GeulmoaPathBefore${n}`, afterFamily = `GeulmoaPathAfter${n}`;
    const nextFaces = await Promise.all([new FontFace(beforeFamily, data.before).load(), new FontFace(afterFamily, data.after).load()]);
    nextFaces.forEach((face) => document.fonts.add(face));
    faces.forEach((face) => document.fonts.delete(face)); faces = nextFaces;
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls = [URL.createObjectURL(new Blob([data.before], { type: 'font/ttf' })), URL.createObjectURL(new Blob([data.after], { type: 'font/ttf' }))];
    $('thickness-download-before').href = urls[0]; $('thickness-download-after').href = urls[1];
    for (const id of ['thickness-before', 'thickness-small-before']) $(id).style.fontFamily = `"${beforeFamily}", sans-serif`;
    for (const id of ['thickness-after', 'thickness-small-after']) $(id).style.fontFamily = `"${afterFamily}", sans-serif`;
    available = new Set([...data.chars, ' ']); $('thickness-text').value = [...data.chars].join(' '); updateText();
    const originals = data.stats.filter((s) => s.kind === 'original').length, combined = data.stats.length - originals;
    const fallbackCount = data.stats.filter((s) => s.steps.some((p) => p.method === 'fallback')).length;
    const warningCount = data.stats.filter((s) => s.warning).length;
    $('thickness-summary').textContent = `기준 획 굵기 약 ${Math.round(data.target)} · 직접 ${originals}자 / 조합 ${combined}자${fallbackCount ? ` · ${fallbackCount}자 일부 유지` : ''}${warningCount ? ` · ${warningCount}자 형태 확인` : ''}`;
    const grid = $('thickness-glyphs'); grid.replaceChildren();
    for (const glyph of data.stats) {
      const fallback = glyph.steps.some((p) => p.method === 'fallback');
      const card = document.createElement('article'); card.className = 'lab-glyph';
      card.dataset.char = glyph.char; card.dataset.kind = glyph.kind; card.dataset.adjusted = String(glyph.adjusted);
      card.dataset.fallback = String(fallback); card.dataset.warning = String(glyph.warning);
      const head = document.createElement('div'); head.className = 'lab-glyph-header';
      const title = document.createElement('strong'); title.textContent = `${glyph.char} · ${glyph.kind === 'original' ? '직접 쓴 글자' : '자모 조합'}`;
      const flag = document.createElement('span'); flag.className = glyph.warning || fallback ? 'lab-guarded' : '';
      flag.textContent = glyph.warning ? '형태 확인' : fallback ? '일부 유지' : glyph.adjusted ? '획 경로' : '기존 그대로';
      head.append(title, flag);
      const pair = document.createElement('div'); pair.className = 'lab-glyph-pair';
      for (const [family, caption] of [[beforeFamily, 'BEFORE'], [afterFamily, 'AFTER']]) {
        const box = document.createElement('div'), small = document.createElement('small'), letter = document.createElement('span');
        small.textContent = caption; letter.className = 'lab-glyph-letter'; letter.style.fontFamily = `"${family}", sans-serif`;
        letter.textContent = glyph.char; box.append(small, letter); pair.append(box);
      }
      const metrics = document.createElement('p'); metrics.className = 'lab-glyph-metrics';
      for (const step of glyph.steps) {
        const row = document.createElement('span'); row.textContent = labelStep(step); metrics.append(row, document.createElement('br'));
      }
      if (glyph.warning) {
        const warning = document.createElement('span'); warning.className = 'lab-notice';
        warning.textContent = '획 덩어리 또는 구멍 수가 달라져 확인이 필요해요.'; metrics.append(warning);
      }
      card.append(head, pair, metrics); grid.append(card);
    }
    $('thickness-result').hidden = false; hasResult = true;
    const notes = [`비교 완료: 직접 ${originals}자와 조합 ${combined}자`];
    if (fallbackCount) notes.push(`${fallbackCount}자는 일부 자모의 기존 윤곽 유지`);
    if (warningCount) notes.push(`${warningCount}자는 획이나 구멍 형태 확인 필요`);
    if (data.unavailable.length) notes.push(`자모가 없어 만들지 못한 글자: ${data.unavailable.join(' ')}`);
    if (data.overLimit.length) notes.push(`20자 한도를 넘어 제외: ${data.overLimit.join(' ')}`);
    if (data.skipped.length) notes.push(`완성되지 않아 제외: ${data.skipped.join(' ')}`);
    if (data.sampleLimit) notes.push('직접 쓴 글자는 앞의 30자만 사용');
    status(notes.join(' · ') + '.');
  }
  function run() {
    $('thickness-result').hidden = true; hasResult = false;
    let job;
    try {
      if (source === 'demo') job = { list: demoSamples(), skipped: [] };
      else if (source === 'mine') job = getLocal();
      else job = parseImported($('thickness-import-data').value);
      job.list = job.list.filter((s) => [...s.char].length === 1 && s.char.codePointAt(0) >= 0xac00 && s.char.codePointAt(0) <= 0xd7a3);
      if (!job.list.length) {
        const skipped = job.skipped && job.skipped.length ? ` 색칠이 끝나지 않은 글자: ${job.skipped.join(' ')}` : '';
        throw new Error(`비교할 한글이 없어요. 이 실험 주소에서 글자를 쓰고 자모 색칠을 마치거나 예시 글씨를 선택해 주세요.${skipped}`);
      }
    } catch (e) { status(e.message || '글씨 데이터를 읽지 못했어요.', true); return; }
    if (worker) worker.terminate(); busy(true); status('저장된 획 경로를 분석하고 있어요. 잠시만 기다려 주세요.');
    // The optional path-comparison still requires its own worker; unlike the
    // main font generator it does not yet have a main-thread fallback.
    if (typeof self.origin === 'string' && self.origin === 'null') {
      busy(false); status('이 내장 화면에서는 획 굵기 비교 작업자를 사용할 수 없어요. 필기를 백업한 뒤 브라우저 새 탭에서 열어 주세요.', true); return;
    }
    try { worker = new Worker('vector-worker.js?v=auto-vector-1'); }
    catch (_) { busy(false); status('획 굵기 비교 작업자를 시작하지 못했어요. 필기를 백업한 뒤 브라우저 새 탭에서 열어 주세요.', true); return; }
    const thisWorker = worker;
    thisWorker.onmessage = async ({ data }) => {
      if (worker !== thisWorker) return;
      if (data.type === 'progress') status(data.message);
      if (data.type === 'error') { status(data.message, true); thisWorker.terminate(); worker = null; busy(false); }
      if (data.type === 'done') {
        data.skipped = [...new Set([...(data.skipped || []), ...(job.skipped || [])])];
        try { await showResult(data); }
        catch (e) { status(`비교 폰트를 표시하지 못했어요: ${e.message}`, true); }
        thisWorker.terminate(); if (worker === thisWorker) worker = null; busy(false);
      }
    };
    thisWorker.onerror = (e) => {
      if (e.preventDefault) e.preventDefault();
      status(e.message ? `획 굵기 비교 중 오류가 발생했어요: ${e.message}`
        : '획 굵기 비교 작업자를 불러오지 못했어요. 필기를 백업한 뒤 브라우저 새 탭에서 열어 주세요.', true);
      thisWorker.terminate(); if (worker === thisWorker) worker = null; busy(false);
    };
    thisWorker.postMessage({ samples: job.list, strength: Number($('thickness-strength').value) / 100,
      targetRatio: Number($('thickness-target').value) / 100, requested: $('thickness-requested').value });
  }
  function stale() { if (hasResult) status('설정이 바뀌었어요. ‘비교 만들기’를 눌러 새 결과를 확인해 주세요.'); }
  function init(options) {
    getLocal = options.getLocal; parseImported = options.parseImported;
    const launch = () => { labStarted = true; run(); };
    $('thickness-demo').addEventListener('click', () => { setSource('demo'); launch(); });
    $('thickness-mine').addEventListener('click', () => { setSource('mine'); launch(); });
    $('thickness-import').addEventListener('click', () => { setSource('import'); launch(); });
    $('thickness-run').addEventListener('click', launch);
    for (const [id, out] of [['thickness-strength', 'thickness-strength-value'], ['thickness-target', 'thickness-target-value']]) {
      $(id).addEventListener('input', () => { $(out).value = `${$(id).value}%`; stale(); });
    }
    $('thickness-requested').addEventListener('input', stale);
    $('thickness-import-data').addEventListener('input', () => { if (source === 'import') stale(); });
    $('thickness-text').addEventListener('input', updateText);
    setSource('demo');
    const disclosure = $('thickness-details');
    if (disclosure) {
      status('열면 가상 예시 비교를 준비해요.');
      disclosure.addEventListener('toggle', () => { if (disclosure.open && !labStarted) launch(); });
      if (disclosure.open) launch();
    } else launch();
  }
  function markDirty() { if (source === 'mine' && hasResult) status('필기가 바뀌었어요. ‘비교 만들기’를 눌러 최신 글씨를 확인해 주세요.'); }
  window.GeulmoaThicknessLab = { init, markDirty };
})();
