/* Local, per-name font design profiles and a labelled, approximate specimen. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const KEY = 'geulmoa-font-design-profiles-v1';
  const DEFAULT = Object.freeze({ cleanupStrength: 0, device: 'auto', letterSpacing: 0, wordSpace: 500, verticalOffset: 0 });
  const DEVICES = new Set(['auto', 'pen', 'touch', 'mouse', 'unknown']);
  const clampNumber = (x, fallback, lo, hi) => {
    const n = Number(x); return Number.isFinite(n) ? Math.round(Math.max(lo, Math.min(hi, n))) : fallback;
  };
  function normalize(raw = {}) {
    return {
      cleanupStrength: clampNumber(raw.cleanupStrength, 0, 0, 100),
      device: DEVICES.has(raw.device) ? raw.device : 'auto',
      letterSpacing: clampNumber(raw.letterSpacing, 0, -100, 200),
      wordSpace: clampNumber(raw.wordSpace, 500, 200, 1000),
      verticalOffset: clampNumber(raw.verticalOffset, 0, -100, 100),
    };
  }
  function profileName(raw) { return String(raw || '').trim().normalize('NFC').slice(0, 40) || 'My Hand'; }
  let profiles = new Map(), profile = '', settings = { ...DEFAULT }, callbacks = null;
  let generated = null, pendingFrame = 0, saveFailed = false;

  function loadProfiles() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY) || '{}');
      if (!data || data.version !== 1 || !data.profiles || typeof data.profiles !== 'object' || Array.isArray(data.profiles)) return;
      profiles = new Map(Object.entries(data.profiles).map(([name, value]) => [profileName(name), normalize(value)]));
    } catch (_) { profiles = new Map(); }
  }
  function saveProfiles() {
    try {
      const data = Object.fromEntries(profiles);
      localStorage.setItem(KEY, JSON.stringify({ version: 1, profiles: data })); saveFailed = false;
    } catch (_) { saveFailed = true; }
  }
  function profileStatus(note = '') {
    $('design-profile-status').textContent = saveFailed ? '설정을 자동 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.'
      : `‘${profile}’ 설정${note ? ` · ${note}` : ' · 이 브라우저에 자동 저장'}`;
  }
  function switchProfile(raw, initial = false) {
    const name = profileName(raw);
    if (!initial && name === profile) return;
    const existing = profiles.has(name);
    // A new font begins with a copy of the current design; an existing font
    // restores its own settings. Handwriting itself remains a shared workspace.
    settings = normalize(existing ? profiles.get(name) : initial ? DEFAULT : settings);
    profile = name; profiles.set(profile, { ...settings }); saveProfiles();
    profileStatus(initial ? '' : existing ? '저장한 설정 불러옴' : '이전 설정에서 시작');
    renderControls(); refreshStroke(); queueSpecimen();
    if (!initial && callbacks) callbacks.onChange();
  }
  function signedEm(value) {
    const sign = value > 0 ? '+' : '';
    return `${sign}${(value / 1000).toFixed(2)}em`;
  }
  function wordEm(value) { return (value / 1000).toFixed(value % 10 ? 3 : 2); }
  function renderControls() {
    const selector = $('design-profile'); selector.replaceChildren();
    for (const name of profiles.keys()) {
      const option = document.createElement('option'); option.value = name; option.textContent = name; selector.append(option);
    }
    selector.value = profile;
    $('design-cleanup').value = settings.cleanupStrength;
    $('design-device').value = settings.device;
    $('design-spacing').value = settings.letterSpacing;
    $('design-word').value = settings.wordSpace;
    $('design-va').value = settings.verticalOffset;
    $('design-cleanup-value').value = settings.cleanupStrength ? `${settings.cleanupStrength}%` : '0% · 꺼짐';
    $('design-spacing-value').value = signedEm(settings.letterSpacing);
    $('design-word-value').value = `${wordEm(settings.wordSpace)}em`;
    $('design-va-value').value = signedEm(settings.verticalOffset);
    $('design-cleanup').setAttribute('aria-valuetext', settings.cleanupStrength ? `${settings.cleanupStrength} 퍼센트` : '꺼짐');
    $('design-spacing').setAttribute('aria-valuetext', `${signedEm(settings.letterSpacing)}, ${settings.letterSpacing < 0 ? '더 좁게' : settings.letterSpacing > 0 ? '더 넓게' : '기본'}`);
    $('design-word').setAttribute('aria-valuetext', `${wordEm(settings.wordSpace)} 이엠`);
    $('design-va').setAttribute('aria-valuetext', `${signedEm(settings.verticalOffset)}, ${settings.verticalOffset > 0 ? '위로' : settings.verticalOffset < 0 ? '아래로' : '기본'}`);
  }
  function fromControls() {
    return normalize({ cleanupStrength: $('design-cleanup').value, device: $('design-device').value,
      letterSpacing: $('design-spacing').value, wordSpace: $('design-word').value, verticalOffset: $('design-va').value });
  }
  function changed() {
    const next = fromControls();
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    settings = next; profiles.set(profile, { ...settings }); saveProfiles(); profileStatus();
    renderControls(); refreshStroke(); queueSpecimen();
    if (callbacks) callbacks.onChange();
  }
  function demoStroke() {
    // Deliberately artificial jitter and one right-angle corner. This is an
    // explanation of the controls, not evidence from a real device or writer.
    const wobble = (i) => .0042 * Math.sin(i * 2.15) + .0014 * Math.sin(i * .47);
    const lead = [];
    for (let i = 0; i <= 42; i++) lead.push([.15 + .008 * i, .27 + (i === 42 ? 0 : wobble(i))]);
    for (let i = 1; i <= 43; i++) lead.push([.486 + (i === 43 ? 0 : wobble(i + 13)), .27 + .009 * i]);
    const vowel = [], arm = [];
    for (let i = 0; i <= 50; i++) vowel.push([.69 + (i === 0 || i === 50 ? 0 : wobble(i + 4)), .18 + .012 * i]);
    for (let i = 0; i <= 15; i++) arm.push([.69 + i * .009, .48 + (i === 0 || i === 15 ? 0 : wobble(i + 8))]);
    return [lead, vowel, arm].map((points) => ({ kind: 'ink', device: 'touch', points }));
  }
  function drawStrokes(id, entries, color) {
    const canvas = $(id), ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save(); const size = 190;
    ctx.translate((canvas.width - size) / 2, (canvas.height - size) / 2);
    for (const action of entries || []) if (action.kind === 'ink') window.GeulmoaColoring.drawPath(ctx, action.points, size, window.GeulmoaColoring.INK_WIDTH, color);
    ctx.restore();
  }
  function refreshStroke() {
    if (!callbacks) return;
    let example = callbacks.getStrokePreview({ ...settings });
    if (!example) {
      const before = demoStroke();
      example = { before, after: window.GeulmoaStrokeCleanup.cleanActions(before, settings.cleanupStrength, settings.device),
        source: '가상의 입력 예시',
        note: settings.cleanupStrength ? '가상 예시의 작은 흔들림만 정리한 모습이에요. 실제 기기나 손글씨 검증 결과는 아닙니다.'
          : '가상 예시예요. 정리 정도가 0%라 원본과 같습니다. 정리 슬라이더를 조절해 보세요.' };
    }
    $('design-drawing-source').textContent = example.source;
    $('design-stroke-status').textContent = example.note;
    drawStrokes('design-stroke-before', example.before, '#34313b');
    drawStrokes('design-stroke-after', example.after, '#5e4dba');
  }
  function queueSpecimen() {
    if (pendingFrame) cancelAnimationFrame(pendingFrame);
    pendingFrame = requestAnimationFrame(() => { pendingFrame = 0; drawSpecimen(); drawMiniSpecimen(); });
  }
  function supported(ch) { return Boolean(generated && generated.chars.has(ch)); }
  function drawSpecimen() {
    const canvas = $('design-specimen'), box = canvas.getBoundingClientRect();
    const width = Math.max(180, box.width), height = box.height || 268;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
    const text = [...$('design-preview-input').value.normalize('NFC')].slice(0, 35);
    const defaultDesign = { letterSpacing: 0, wordSpace: 500, verticalOffset: 0 };
    const desired = [defaultDesign, settings];
    const family = generated ? `"${generated.family}", sans-serif` : 'sans-serif';
    const setFont = (size) => { ctx.font = `${size}px ${family}`; ctx.textBaseline = 'alphabetic'; };
    function layoutWidth(size, target) {
      setFont(size); let sum = 0;
      for (const ch of text) {
        if (/\s/u.test(ch)) { sum += target.wordSpace * size / 1000; continue; }
        const base = supported(ch) ? generated.design.letterSpacing : 0;
        sum += ctx.measureText(ch).width + (target.letterSpacing - base) * size / 1000;
      }
      return sum;
    }
    const available = width - 42;
    let fontSize = Math.min(60, Math.max(23, available / 7.4));
    const total = Math.max(...desired.map((target) => layoutWidth(fontSize, target)), 1);
    if (total > available) fontSize = Math.max(12, fontSize * available / total);
    setFont(fontSize);
    const baselines = [height * .405, height * .865];
    for (let row = 0; row < 2; row++) {
      const baseY = baselines[row], target = desired[row];
      ctx.save(); ctx.strokeStyle = row ? '#bdb0f0' : '#dcd9df'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(18, baseY + .5); ctx.lineTo(width - 18, baseY + .5); ctx.stroke(); ctx.restore();
      ctx.fillStyle = row ? '#7867c5' : '#aaa4ac'; ctx.font = '700 10px sans-serif';
      ctx.fillText(row ? '내 설정 · 간격 / 높이' : '기본 · 간격 / 높이', 19, baseY - 82);
      ctx.textAlign = 'right'; ctx.fillStyle = row ? '#a799dc' : '#b9b3bc'; ctx.font = '9px sans-serif';
      ctx.fillText('기준선', width - 18, baseY + 14); ctx.textAlign = 'left';
      setFont(fontSize); ctx.fillStyle = row ? '#504395' : '#39353d';
      ctx.save(); ctx.beginPath(); ctx.rect(18, baseY - 76, width - 36, 79); ctx.clip();
      let x = 21;
      for (const ch of text) {
        if (/\s/u.test(ch)) { x += target.wordSpace * fontSize / 1000; continue; }
        const isCustom = supported(ch);
        const baseSpacing = isCustom ? generated.design.letterSpacing : 0;
        const baseVertical = isCustom ? generated.design.verticalOffset : 0;
        const delta = (target.letterSpacing - baseSpacing) * fontSize / 1000;
        ctx.fillText(ch, x + delta / 2, baseY - (target.verticalOffset - baseVertical) * fontSize / 1000);
        x += ctx.measureText(ch).width + delta;
      }
      ctx.restore();
    }
    const missing = generated ? [...new Set(text.filter((c) => !/\s/u.test(c) && !generated.chars.has(c)))] : [];
    let note = generated ? '생성한 내 폰트를 기준으로 간격과 높이를 비교한 가이드예요.' : '시스템 글꼴 예시예요. 폰트를 생성하면 내 글씨를 기준으로 볼 수 있어요.';
    if (generated?.stale) note += ' 설정이나 글씨가 바뀌어 TTF는 다시 생성해야 해요.';
    if (generated) note += ' 좁은 기호나 사용 환경에 따라 실제와 조금 다를 수 있어요.';
    if (missing.length) note += ` 폰트에 없는 글자: ${missing.slice(0, 10).join(' ')} (기기 기본 글꼴)`;
    if (total > available && fontSize <= 12.01) note += ' 긴 문장의 뒷부분은 생략될 수 있어요.';
    $('design-sample-status').textContent = note;
  }
  // A compact specimen stays in view while a mobile user adjusts the sliders.
  // The detailed two-row specimen below remains the comparison reference.
  function drawMiniSpecimen() {
    const canvas = $('design-mini-specimen'), box = canvas.getBoundingClientRect();
    $('design-mini-source').textContent = generated ? (generated.stale ? '내 폰트 · 다시 생성 필요' : '내 폰트') : '시스템 예시';
    if (box.width < 2 || box.height < 2) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2), width = box.width, height = box.height;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
    const chars = [...$('design-preview-input').value.normalize('NFC')].slice(0, 35);
    const family = generated ? `"${generated.family}", sans-serif` : 'sans-serif';
    let size = Math.min(32, Math.max(17, (width - 24) / 7.6));
    function measure(fontSize) {
      ctx.font = `${fontSize}px ${family}`; let total = 0;
      for (const ch of chars) {
        if (/\s/u.test(ch)) total += settings.wordSpace * fontSize / 1000;
        else total += ctx.measureText(ch).width + (settings.letterSpacing - (supported(ch) ? generated.design.letterSpacing : 0)) * fontSize / 1000;
      }
      return total;
    }
    const total = measure(size), available = width - 24;
    if (total > available) size = Math.max(10, size * available / total);
    ctx.font = `${size}px ${family}`; ctx.textBaseline = 'alphabetic';
    const baseline = height - 13; ctx.strokeStyle = '#cfc5ed'; ctx.setLineDash([3,3]); ctx.beginPath(); ctx.moveTo(10,baseline+.5);ctx.lineTo(width-10,baseline+.5);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle = '#5544a8'; ctx.save();ctx.beginPath();ctx.rect(10,0,width-20,baseline+3);ctx.clip();
    let x = 12;
    for (const ch of chars) {
      if (/\s/u.test(ch)) { x += settings.wordSpace * size / 1000; continue; }
      const isCustom = supported(ch), baseSpacing = isCustom ? generated.design.letterSpacing : 0;
      const baseVertical = isCustom ? generated.design.verticalOffset : 0;
      const delta = (settings.letterSpacing - baseSpacing) * size / 1000;
      ctx.fillText(ch, x + delta / 2, baseline - (settings.verticalOffset - baseVertical) * size / 1000);
      x += ctx.measureText(ch).width + delta;
    }
    ctx.restore();
  }
  function markDirty() { if (generated) generated.stale = true; queueSpecimen(); }
  function setFont(value) {
    generated = value ? { family: value.family, design: normalize(value.design), chars: new Set(value.chars || []), stale: Boolean(value.stale) } : null;
    queueSpecimen();
  }
  function init(options) {
    callbacks = options; loadProfiles(); switchProfile(options.getName(), true);
    for (const id of ['design-cleanup', 'design-device', 'design-spacing', 'design-word', 'design-va']) $(id).addEventListener('input', changed);
    $('design-device').addEventListener('change', changed); // older browsers may emit only change for selects
    $('design-profile').addEventListener('change', (e) => callbacks.selectProfile(e.currentTarget.value));
    $('design-preview-input').addEventListener('input', queueSpecimen);
    $('design-reset').addEventListener('click', () => {
      const wasChanged = JSON.stringify(settings) !== JSON.stringify(DEFAULT);
      settings = { ...DEFAULT }; profiles.set(profile, { ...settings }); saveProfiles(); profileStatus('기본값으로 되돌림');
      renderControls(); refreshStroke(); queueSpecimen(); if (wasChanged) callbacks.onChange();
    });
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(queueSpecimen); observer.observe($('design-specimen')); observer.observe($('design-mini-specimen'));
    } else window.addEventListener('resize', queueSpecimen);
    refreshStroke(); queueSpecimen();
  }
  window.GeulmoaDesigner = { init, switchProfile, getSettings: () => ({ ...settings }), refreshStroke, markDirty, setFont };
})();
