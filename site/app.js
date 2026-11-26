(() => {
  'use strict';
  const BASE = [...'는성줄합복림댓같맞욕받닿싶판넷트'];
  const CONTEXT = [...'가거고구과각곡관값'];
  const EXTRAS = [...'0123456789.,?!-()'];
  const LEADS = [...'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'];
  const VOWELS = [...'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'];
  const FINALS = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'];
  const KEY = 'geulmoa-drawing-v1';
  // Keep the HTML, main engine and workers on the same deployment version.
  const WORKER_URL = 'worker.js?v=auto-vector-1', MAIN_ENGINE_URL = 'engine-main.js?v=auto-vector-1';
  const IMPORT_LIMIT = 8_000_000; // cap untrusted pasted JSON and uploaded files
  const Coloring = window.GeulmoaColoring;
  const Cleanup = window.GeulmoaStrokeCleanup;
  const Designer = window.GeulmoaDesigner;
  const DEFAULT_PREVIEW = '안녕하세요, 반가워요.\n다람쥐 헌 쳇바퀴에 타고파';
  const $ = (id) => document.getElementById(id);
  const defaultState = () => ({ samples: {}, custom: [], current: BASE[0], fontName: 'My Hand', preview: DEFAULT_PREVIEW, autoStroke: true });
  let state = defaultState();
  let role = 'L';
  let mode = 'draw';
  let paintTool = 'paint';
  let migrated = false;
  const analysisCache = new Map();
  const emptyAnalysis = { inkCount: 0, unassigned: 0, counts: { L: 0, V: 0, T: 0, X: 0 }, masks: {} };
  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.width = overlayCanvas.height = Coloring.SIZE;
  let pointer = null;
  let lastPenTime = 0;
  let revision = 0;
  let worker = null;
  let building = false;
  let result = null;
  let fontFace = null;
  let downloadURL = null;
  // Each step has its own dialog. The one shared canvas is moved between
  // dialogs so handwriting and chronological paint actions stay identical.
  const DIALOG_FOR = { draw: 'modal-write', L: 'modal-lead', V: 'modal-vowel', T: 'modal-final' };
  let captureDialog = null, captureReturnFocus = null, captureScroll = null;
  let fallbackInert = [], pendingClear = null;

  function parts(ch) {
    const n = ch.codePointAt(0) - 0xac00;
    if (n < 0 || n >= 11172) return null;
    return { lead: LEADS[Math.floor(n / 588)], vowel: VOWELS[Math.floor(n / 28) % 21], final: FINALS[n % 28] };
  }
  function rolesFor(ch) {
    const p = parts(ch);
    if (!p) return [{ id: 'X', label: '문자', jamo: ch }];
    return [
      { id: 'L', label: '초성', jamo: p.lead },
      { id: 'V', label: '중성', jamo: p.vowel },
      ...(p.final ? [{ id: 'T', label: '종성', jamo: p.final }] : []),
    ];
  }
  function vowelLayout(v) {
    if ('ㅘㅙㅚㅝㅞㅟㅢ'.includes(v)) return 'mixed';
    if ('ㅏㅐㅑㅒㅓㅔㅕㅖㅣ'.includes(v)) return 'vertical';
    return 'horizontal';
  }
  function allChars() { return [...BASE, ...CONTEXT, ...EXTRAS, ...state.custom]; }
  function actions(ch) { return Array.isArray(state.samples[ch]?.actions) ? state.samples[ch].actions : []; }
  function mutableActions(ch) {
    if (!state.samples[ch] || !Array.isArray(state.samples[ch].actions)) state.samples[ch] = { version: 2, actions: [] };
    return state.samples[ch].actions;
  }
  function invalidate(ch) { analysisCache.delete(ch); }
  function hasAny(ch) { return actions(ch).some((s) => s.kind === 'ink' && Array.isArray(s.points) && s.points.length); }
  function hasPaint(ch) { return actions(ch).some((s) => s.kind === 'paint' || s.legacyRole); }
  function analysis(ch) {
    if (!hasAny(ch)) return emptyAnalysis;
    if (!analysisCache.has(ch)) analysisCache.set(ch, Coloring.analyzeActions(actions(ch), rolesFor(ch).map((r) => r.id)));
    return analysisCache.get(ch);
  }
  function hasRole(ch, r) { return (analysis(ch).counts[r] || 0) > 0; }
  function isComplete(ch) {
    const a = analysis(ch);
    return a.inkCount > 0 && a.unassigned === 0 && rolesFor(ch).every((r) => a.counts[r.id] > 0);
  }
  function nextMissingRole(ch) { return (rolesFor(ch).find((r) => !hasRole(ch, r.id)) || rolesFor(ch)[0]).id; }
  function normalizeSamples(raw) {
    const samples = {};
    if (!raw || typeof raw !== 'object') return samples;
    for (const [ch, entry] of Object.entries(raw)) {
      if (Array.isArray(entry)) {
        // Keep every old stroke and its previous assignment. It can be painted
        // over (or reset) if it was incorrectly entered entirely as 초성.
        const ink = entry.filter((s) => Array.isArray(s?.points) && s.points.length).map((s) => ({
          kind: 'ink', points: s.points,
          ...(['L', 'V', 'T'].includes(s.role) ? { legacyRole: s.role } : {}),
        }));
        if (ink.length) { samples[ch] = { version: 2, actions: ink }; migrated = true; }
      } else if (entry && Array.isArray(entry.actions)) {
        samples[ch] = { version: 2, actions: entry.actions.filter((s) => s && ['ink', 'paint'].includes(s.kind) && Array.isArray(s.points) && s.points.length) };
      }
    }
    return samples;
  }
  function readState() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!saved || typeof saved !== 'object') return;
      const custom = Array.isArray(saved.custom) ? saved.custom.filter((c) => typeof c === 'string' && [...c].length === 1 && parts(c) && ![...BASE, ...CONTEXT, ...EXTRAS].includes(c)).slice(0, 50) : [];
      state = { ...defaultState(), ...saved, custom: [...new Set(custom)], samples: normalizeSamples(saved.samples), autoStroke: saved.autoStroke !== false };
      if (!allChars().includes(state.current)) state.current = BASE[0];
      role = nextMissingRole(state.current);
      mode = 'draw';
    } catch (_) { state = defaultState(); analysisCache.clear(); }
  }
  function showStorageStatus(ok) {
    $('storage-warning').hidden = ok;
    $('modal-storage-warning').hidden = ok;
    if (ok) document.querySelector('.top-local').innerHTML = '<span class="local-dot"></span> 내 기기에서 작업 중';
    else document.querySelector('.top-local').textContent = '자동 저장 안 됨';
  }
  function probeStorage() {
    try {
      const key = `geulmoa-storage-probe-${Date.now()}-${Math.random()}`;
      localStorage.setItem(key, '1'); localStorage.removeItem(key); showStorageStatus(true);
    } catch (_) { showStorageStatus(false); }
  }
  function save() {
    // A manually displayed backup is a snapshot. Clear it on subsequent
    // changes so an old, incomplete copy cannot be mistaken for the latest.
    const manualBackup = $('backup-text');
    if (manualBackup && manualBackup.value) {
      manualBackup.value = '';
      $('backup-status').textContent = '작업 내용이 바뀌었어요. 최신 필기는 ‘현재 필기 내용 준비’를 다시 눌러 복사해 주세요.';
    }
    try { localStorage.setItem(KEY, JSON.stringify(state)); showStorageStatus(true); }
    catch (_) { showStorageStatus(false); }
  }
  function dirty() {
    revision++;
    if (Designer) Designer.markDirty();
    if (window.GeulmoaThicknessLab) window.GeulmoaThicknessLab.markDirty();
    if (result) {
      $('font-state').textContent = '변경 있음 · 다시 생성 필요';
      $('font-state').className = 'status-pill dirty';
      $('download-font').innerHTML = '이전 상태 TTF 다운로드 <span>↓</span>';
      $('build-status').classList.remove('error');
      $('build-status').textContent = '필기, 폰트 이름 또는 설정이 바뀌었어요. 다시 생성하면 최신 내용이 반영돼요.';
    }
  }
  function groupInfo(ch) {
    if (BASE.includes(ch)) return '기초 음절';
    if (CONTEXT.includes(ch)) return 'ㄱ 모양 더하기';
    if (EXTRAS.includes(ch)) return '숫자 · 기호';
    return '직접 추가한 음절';
  }
  function renderGroups() {
    const container = $('sample-groups');
    container.replaceChildren();
    const groups = [
      { name: '기초 음절', chars: BASE, hint: '필수 권장' },
      { name: 'ㄱ 모양 더하기', chars: CONTEXT, hint: '선택' },
      { name: '숫자 · 기호', chars: EXTRAS, hint: '선택' },
      ...(state.custom.length ? [{ name: '추가한 음절', chars: state.custom, hint: '선택' }] : []),
    ];
    for (const g of groups) {
      const block = document.createElement('div'); block.className = 'sample-group';
      const title = document.createElement('div'); title.className = 'sample-group-title';
      const b = document.createElement('b'); b.textContent = g.name;
      const count = document.createElement('span'); count.textContent = `${g.chars.filter(isComplete).length}/${g.chars.length} · ${g.hint}`;
      title.append(b, count); block.append(title);
      const grid = document.createElement('div'); grid.className = 'sample-grid';
      for (const ch of g.chars) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'sample-chip';
        if (isComplete(ch)) button.classList.add('done'); else if (hasAny(ch)) button.classList.add('partial');
        if (state.current === ch) button.classList.add('active');
        button.textContent = ch;
        button.setAttribute('aria-label', `${g.name} ${ch}${isComplete(ch) ? ', 작성 완료' : hasAny(ch) ? ', 작성 중' : ', 미작성'}`);
        button.setAttribute('aria-pressed', String(state.current === ch));
        button.addEventListener('click', () => selectChar(ch, window.innerWidth <= 720));
        grid.append(button);
      }
      block.append(grid); container.append(block);
    }
    const done = BASE.filter(isComplete).length;
    $('base-progress').textContent = `${done} / ${BASE.length}`;
    $('base-bar').style.width = `${100 * done / BASE.length}%`;
    const quick = $('quick-sample-list'), previousScroll = quick.scrollLeft;
    quick.replaceChildren();
    for (const ch of BASE) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'quick-chip';
      if (state.current === ch) button.classList.add('active');
      if (isComplete(ch)) button.classList.add('done'); else if (hasAny(ch)) button.classList.add('partial');
      button.textContent = ch; button.dataset.char = ch;
      button.setAttribute('aria-label', `${ch}${isComplete(ch) ? ', 작성 완료' : hasAny(ch) ? ', 작성 중' : ', 미작성'}`);
      button.setAttribute('aria-pressed', String(state.current === ch));
      button.addEventListener('click', () => selectChar(ch)); quick.append(button);
    }
    quick.scrollLeft = previousScroll;
    const current = quick.querySelector('.active');
    if (current && quick.clientWidth) {
      if (current.offsetLeft < quick.scrollLeft) quick.scrollLeft = current.offsetLeft;
      else if (current.offsetLeft + current.offsetWidth > quick.scrollLeft + quick.clientWidth)
        quick.scrollLeft = current.offsetLeft + current.offsetWidth - quick.clientWidth;
    }
  }
  function drawPad() {
    const canvas = $('pad'), ctx = canvas.getContext('2d'), ch = state.current;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const action of actions(ch)) if (action.kind === 'ink') {
      Coloring.drawPath(ctx, action.points, canvas.width, Coloring.INK_WIDTH, '#26252b');
    }
    const a = analysis(ch);
    if (a.overlay && parts(ch)) {
      const overlay = overlayCanvas.getContext('2d');
      const image = overlay.createImageData(Coloring.SIZE, Coloring.SIZE); image.data.set(a.overlay);
      overlay.putImageData(image, 0, 0);
      ctx.drawImage(overlayCanvas, 0, 0, canvas.width, canvas.height);
    }
    $('pad-empty').hidden = hasAny(ch);
  }
  function currentStage() { return mode === 'paint' ? role : 'draw'; }
  function stagesFor(ch) {
    const p = parts(ch);
    return [{ id: 'draw', label: '쓰기' }, ...(p ? rolesFor(ch) : [])];
  }
  function renderPhaseNav(ch) {
    const steps = stagesFor(ch), nav = $('capture-phase-nav');
    const signature = `${ch}:${steps.map((s) => s.id).join(',')}`;
    if (nav.dataset.signature !== signature) {
      nav.replaceChildren(); nav.dataset.signature = signature;
      nav.style.setProperty('--phase-count', steps.length);
      steps.forEach((step, index) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'phase-step'; b.dataset.stage = step.id;
        const n = document.createElement('span'); n.className = 'phase-number'; n.textContent = String(index + 1);
        const text = document.createElement('b'); text.textContent = step.label;
        b.append(n, text); b.addEventListener('click', () => setStage(step.id)); nav.append(b);
      });
      const intro = $('landing-steps'); intro.replaceChildren();
      steps.forEach((step, index) => {
        if (index) { const arrow = document.createElement('i'); arrow.textContent = '→'; arrow.setAttribute('aria-hidden', 'true'); intro.append(arrow); }
        const label = document.createElement('span'); label.textContent = step.id === 'draw' ? '글자 쓰기' : step.label; intro.append(label);
      });
    }
    for (const [index, step] of steps.entries()) {
      const b = nav.children[index], active = step.id === currentStage();
      const marked = step.id === 'draw' ? hasAny(ch) : hasRole(ch, step.id);
      b.disabled = step.id !== 'draw' && !hasAny(ch);
      b.classList.toggle('active', active); b.classList.toggle('has-work', marked);
      if (active) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.setAttribute('aria-label', `${index + 1}단계 ${step.label}${step.jamo ? ` ${step.jamo}` : ''}${marked ? ', 입력한 획 있음' : ''}`);
    }
  }
  function renderPad() {
    const ch = state.current, rs = rolesFor(ch), p = parts(ch), a = analysis(ch);
    if (mode === 'paint' && (!p || !hasAny(ch))) { mode = 'draw'; paintTool = 'paint'; }
    const r = rs.find((item) => item.id === role) || rs[0]; role = r.id;
    const coloring = mode === 'paint' && Boolean(p), stage = currentStage();
    const steps = stagesFor(ch), at = steps.findIndex((item) => item.id === stage);
    const index = allChars().indexOf(ch) + 1, lastSample = index === allChars().length;
    $('target-char').textContent = ch;
    $('sample-category').textContent = groupInfo(ch);
    $('sample-number').innerHTML = `${String(index).padStart(2, '0')} <i>/</i> ${String(allChars().length).padStart(2, '0')}`;
    $('target-hint').textContent = p ? '한 번에 쓰고, 색으로 나눠요' : '표시된 문자를 그대로 써 주세요';
    $('context-hint').textContent = p ? `${({ vertical: '세로 모음', horizontal: '가로 모음', mixed: '복합 모음' })[vowelLayout(p.vowel)]} · ${p.final ? '받침 있음' : '받침 없음'}` : '숫자와 기호는 색칠하지 않아요';
    $('landing-state').textContent = !hasAny(ch) ? '아직 작성하지 않은 글자예요.'
      : isComplete(ch) ? '작성한 글자가 있어요. 다시 열어 고칠 수 있어요.' : '작성 중인 글자가 있어요. 이어서 완성해 주세요.';
    $('start-writing').innerHTML = `${hasAny(ch) ? '이 글자 이어서 쓰기' : '이 글자 쓰기 시작'} <span>→</span>`;
    $('remove-custom').hidden = !state.custom.includes(ch);
    $('landing-prev').disabled = index <= 1;
    $('landing-next').textContent = lastSample ? '폰트 만들기로 →' : '다음 글자 →';
    renderPhaseNav(ch);

    $('capture-editor').dataset.stage = stage;
    $('modal-target-char').textContent = ch;
    $('capture-kicker').textContent = `글자 ${String(index).padStart(2, '0')} / ${String(allChars().length).padStart(2, '0')} · ${at + 1} / ${steps.length}`;
    $('capture-modal-title').textContent = !coloring ? `‘${ch}’ 한 번에 쓰기` : `${r.label} ‘${r.jamo}’ 칠하기`;
    const colorNames = { L: '보라색', V: '청록색', T: '주황색' };
    $('capture-modal-description').textContent = !coloring
      ? p ? '한 글자를 나누지 말고 평소처럼 써 주세요.' : '숫자와 기호는 색칠 없이 쓰기만 해요.'
      : paintTool === 'erase' ? '잘못 칠한 부분의 색만 지울 수 있어요.' : `${colorNames[role]}으로 ${r.label}의 획 위를 칠해 주세요.`;
    $('paint-controls').hidden = !coloring;
    $('paint-erase').classList.toggle('active', paintTool === 'erase');
    $('paint-erase').setAttribute('aria-pressed', String(paintTool === 'erase'));
    $('clear-colors').disabled = !hasPaint(ch);
    const missing = rs.filter((item) => !a.counts[item.id]).map((item) => item.label);
    const painted = a.inkCount ? Math.floor((a.inkCount - a.unassigned) * 100 / a.inkCount) : 0;
    $('paint-bar').style.width = `${painted}%`;
    $('paint-status').textContent = !a.inkCount ? '먼저 글자를 써 주세요'
      : a.unassigned ? `칠하지 않은 획 ${Math.ceil(a.unassigned * 100 / a.inkCount)}%${missing.length ? ` · ${missing.join('·')} 필요` : ''}`
      : missing.length ? `모든 획을 칠했어요 · ${missing.join('·')} 필요` : '모든 획을 자모별로 나눴어요 ✓';
    $('brush-size-label').textContent = `${$('brush-size').value}%`;
    $('board').classList.toggle('is-coloring', coloring);
    if (!coloring) $('brush-cursor').hidden = true;
    $('pad').setAttribute('aria-label', coloring ? `${r.label} ${r.jamo} 색칠 영역. 해당 획 위를 칠하세요.` : '손글씨 입력 영역. 한 글자를 한 번에 쓰세요.');
    $('pad-instruction').textContent = coloring
      ? '색은 기존 획에만 칠해져요. 틀리면 다시 칠해 주세요.'
      : p ? '펜·손가락·마우스로 글자 전체를 써 주세요.' : '펜·손가락·마우스로 이 문자를 써 주세요.';
    const next = steps[at + 1];
    $('next-step').innerHTML = next ? `다음: ${next.label} <span>→</span>` : lastSample ? '완료 · 미리보기 <span>→</span>' : '완료 · 다음 글자 <span>→</span>';
    $('modal-back').disabled = at <= 0;
    $('prev-char').disabled = index <= 1;
    $('skip-char').textContent = lastSample ? '건너뛰고 미리보기 →' : '이 글자 건너뛰기 →';
    $('skip-char').setAttribute('aria-label', lastSample ? '이 글자를 건너뛰고 미리보기로' : '이 글자를 건너뛰고 다음 글자로');
    $('undo').disabled = !actions(ch).length;
    $('clear-char').disabled = !hasAny(ch);
    drawPad();
    if (Designer) Designer.refreshStroke();
    // Undoing the last ink or changing characters returns to the writing
    // dialog; never leave a coloring dialog open without any handwriting.
    if (captureDialog && captureDialog.id !== DIALOG_FOR[stage]) switchCaptureDialog(stage);
  }
  function finishPendingPointer() {
    if (!pointer) return;
    const pending = pointer;
    pointer = null;
    try { $('pad').releasePointerCapture(pending.id); } catch (_) {}
    invalidate(state.current); dirty(); save(); renderGroups();
  }
  function lockBackground() {
    const root = document.documentElement, body = document.body;
    captureScroll = { x: window.scrollX, y: window.scrollY, htmlOverflow: root.style.overflow,
      htmlBehavior: root.style.scrollBehavior, bodyPosition: body.style.position, bodyTop: body.style.top,
      bodyLeft: body.style.left, bodyWidth: body.style.width, bodyOverflow: body.style.overflow };
    root.style.overflow = 'hidden';
    body.style.position = 'fixed'; body.style.top = `${-captureScroll.y}px`; body.style.left = `${-captureScroll.x}px`;
    body.style.width = '100%'; body.style.overflow = 'hidden';
    root.classList.add('capture-open');
  }
  function unlockBackground() {
    if (!captureScroll) return;
    const root = document.documentElement, body = document.body, saved = captureScroll;
    body.style.position = saved.bodyPosition; body.style.top = saved.bodyTop; body.style.left = saved.bodyLeft;
    body.style.width = saved.bodyWidth; body.style.overflow = saved.bodyOverflow;
    root.style.overflow = saved.htmlOverflow; root.style.scrollBehavior = 'auto'; root.classList.remove('capture-open');
    window.scrollTo(saved.x, saved.y); root.style.scrollBehavior = saved.htmlBehavior;
    captureScroll = null;
  }
  function setFallbackModal(enabled) {
    $('capture-fallback-backdrop').hidden = !enabled;
    if (enabled && !fallbackInert.length) {
      fallbackInert = [...document.body.children]
        .filter((el) => !el.classList.contains('capture-dialog') && el.id !== 'capture-fallback-backdrop')
        .map((el) => ({ el, inert: el.inert }));
      for (const item of fallbackInert) item.el.inert = true;
    } else if (!enabled && fallbackInert.length) {
      for (const item of fallbackInert) item.el.inert = item.inert;
      fallbackInert = [];
    }
  }
  function fitCaptureBoard() {
    if (!captureDialog || !captureDialog.open) return;
    const frame = $('capture-board-frame'), board = $('board');
    const size = Math.max(0, Math.floor(Math.min(frame.clientWidth, frame.clientHeight, 570)));
    if (size) { board.style.width = `${size}px`; board.style.height = `${size}px`; }
  }
  function focusCaptureTitle() {
    try { $('capture-modal-title').focus({ preventScroll: true }); }
    catch (_) { $('capture-modal-title').focus(); }
  }
  function switchCaptureDialog(stage) {
    const next = $(DIALOG_FOR[stage]);
    if (!next || (captureDialog === next && next.open)) return;
    const previous = captureDialog;
    if (previous) {
      if (typeof previous.close === 'function') previous.close(); else previous.removeAttribute('open');
    }
    next.append($('capture-editor')); captureDialog = next;
    let native = false;
    try { if (typeof next.showModal === 'function') { next.showModal(); native = true; } } catch (_) {}
    if (native) setFallbackModal(false);
    else { next.setAttribute('open', ''); next.setAttribute('role', 'dialog'); setFallbackModal(true); }
    // ResizeObserver covers changes in toolbars, warnings and viewport sizes.
    fitCaptureBoard(); requestAnimationFrame(fitCaptureBoard); focusCaptureTitle();
  }
  function openCapture() {
    if (captureDialog) return;
    captureReturnFocus = document.activeElement;
    mode = 'draw'; paintTool = 'paint'; $('draw-message').textContent = '';
    lockBackground(); renderPad(); switchCaptureDialog('draw');
  }
  function closeCapture() {
    if (!captureDialog) return;
    dismissClearConfirmation(); finishPendingPointer();
    const dialog = captureDialog; captureDialog = null;
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
    setFallbackModal(false); $('brush-cursor').hidden = true;
    unlockBackground(); renderGroups(); renderPad();
    const target = captureReturnFocus; captureReturnFocus = null;
    if (target && target.isConnected && typeof target.focus === 'function') {
      try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
    }
  }
  function setupCaptureAccessibility() {
    for (const id of Object.values(DIALOG_FOR)) {
      $(id).addEventListener('cancel', (e) => {
        e.preventDefault();
        if (pendingClear) dismissClearConfirmation(true); else closeCapture();
      });
    }
    // The native modal makes its background inert. Keep programmatic focus
    // inside the dialog as well when using the older-browser fallback.
    document.addEventListener('focusin', (e) => {
      if (captureDialog?.open && !captureDialog.contains(e.target)) focusCaptureTitle();
    });
    document.addEventListener('keydown', (e) => {
      if (!captureDialog) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (pendingClear) dismissClearConfirmation(true); else closeCapture();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...captureDialog.querySelectorAll('button:not(:disabled), input:not(:disabled), [href], [tabindex="0"]')]
        .filter((el) => el.getClientRects().length && !el.hidden && !el.closest('[hidden]'));
      if (!items.length) { e.preventDefault(); focusCaptureTitle(); return; }
      const pos = items.indexOf(document.activeElement);
      if (e.shiftKey && pos <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
      else if (!e.shiftKey && (pos === items.length - 1 || (pos < 0 && document.activeElement !== $('capture-modal-title')))) {
        e.preventDefault(); items[0].focus();
      }
    });
    if ('ResizeObserver' in window) new ResizeObserver(fitCaptureBoard).observe($('capture-board-frame'));
    window.addEventListener('resize', fitCaptureBoard);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fitCaptureBoard);
  }
  // Native window.confirm is silently blocked in some embedded browsers. Keep
  // destructive confirmations inside the editor so they work there too.
  function dismissClearConfirmation(restoreFocus = false) {
    const previous = pendingClear; pendingClear = null;
    $('capture-confirm').hidden = true; $('capture-editor').classList.remove('is-confirming');
    if (restoreFocus && previous) {
      const target = $(previous.kind === 'colors' ? 'clear-colors' : 'clear-char');
      try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
    }
  }
  function requestClearConfirmation(kind) {
    const ch = state.current;
    if (!captureDialog || (kind === 'colors' ? !hasPaint(ch) : !hasAny(ch))) return;
    pendingClear = { kind, ch }; $('draw-message').textContent = '';
    $('capture-confirm-message').textContent = kind === 'colors'
      ? `‘${ch}’의 색칠만 지울까요? 쓴 획은 남아요.` : `‘${ch}’의 획과 색칠을 모두 지울까요?`;
    $('capture-confirm-accept').textContent = kind === 'colors' ? '색칠 지우기' : '모두 지우기';
    $('capture-confirm').hidden = false; $('capture-editor').classList.add('is-confirming');
    try { $('capture-confirm-cancel').focus({ preventScroll: true }); } catch (_) { $('capture-confirm-cancel').focus(); }
  }
  function acceptClearConfirmation() {
    const pending = pendingClear; if (!pending) return;
    dismissClearConfirmation();
    const ch = pending.ch; if (ch !== state.current) return;
    if (pending.kind === 'colors') {
      state.samples[ch] = { version: 2, actions: actions(ch).filter((a) => a.kind === 'ink').map((a) => {
        const { legacyRole, ...ink } = a; return ink;
      }) };
      invalidate(ch); role = rolesFor(ch)[0].id; paintTool = 'paint';
      $('draw-message').textContent = '글자는 그대로 두고 색칠만 지웠어요.';
    } else {
      state.samples[ch] = { version: 2, actions: [] }; invalidate(ch);
      role = rolesFor(ch)[0].id; mode = 'draw'; paintTool = 'paint';
      $('draw-message').textContent = '';
    }
    dirty(); save(); renderGroups(); renderPad();
    if (captureDialog) focusCaptureTitle();
  }
  function selectChar(ch, scroll = false) {
    if (!allChars().includes(ch)) return;
    dismissClearConfirmation(); finishPendingPointer();
    state.current = ch; role = nextMissingRole(ch);
    mode = 'draw'; paintTool = 'paint'; $('brush-cursor').hidden = true;
    $('draw-message').textContent = '';
    renderGroups(); renderPad(); save();
    if (scroll && !captureDialog) $('drawing-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function setStage(stage) {
    const steps = stagesFor(state.current);
    if (!steps.some((item) => item.id === stage)) return;
    if (stage !== 'draw' && !hasAny(state.current)) {
      $('draw-message').textContent = '먼저 글자 전체를 써 주세요.'; return;
    }
    dismissClearConfirmation(); finishPendingPointer();
    mode = stage === 'draw' ? 'draw' : 'paint';
    if (stage !== 'draw') role = stage;
    paintTool = 'paint'; $('brush-cursor').hidden = true;
    $('draw-message').textContent = ''; renderPad();
  }
  function moveChar(delta) {
    const list = allChars(), at = list.indexOf(state.current), next = at + delta;
    if (next < 0) return;
    if (next >= list.length) {
      if (captureDialog) closeCapture();
      $('preview').scrollIntoView({ behavior: 'smooth' }); return;
    }
    selectChar(list[next]);
  }
  function point(e) {
    const box = $('pad').getBoundingClientRect();
    return [Math.max(0.002, Math.min(.998, (e.clientX - box.left) / box.width)),
      Math.max(0.002, Math.min(.998, (e.clientY - box.top) / box.height))];
  }
  function addPoint(e) {
    if (!pointer) return;
    const ps = pointer.action.points, n = point(e), last = ps[ps.length - 1];
    if (!last || (n[0] - last[0]) ** 2 + (n[1] - last[1]) ** 2 > 0.000002) {
      if (ps.length < 3000) ps.push(n);
    }
  }
  function updateBrushCursor(e) {
    const cursor = $('brush-cursor');
    if (mode !== 'paint' || e.pointerType === 'touch') { cursor.hidden = true; return; }
    const p = point(e);
    cursor.hidden = false; cursor.style.left = `${p[0] * 100}%`; cursor.style.top = `${p[1] * 100}%`;
    cursor.style.width = `${$('brush-size').value}%`;
    const colors = { L: '#6a4ed3', V: '#008b81', T: '#da6a38' };
    cursor.style.borderColor = paintTool === 'erase' ? '#59545c' : colors[role];
  }
  function setupPointer() {
    const pad = $('pad');
    pad.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.pointerType === 'pen') {
        lastPenTime = Date.now();
        if (pointer && pointer.type === 'touch') {
          const a = mutableActions(state.current), index = a.indexOf(pointer.action);
          if (index !== -1) a.splice(index, 1);
          invalidate(state.current); pointer = null;
        }
      }
      if (e.pointerType === 'touch' && (pointer?.type === 'pen' || Date.now() - lastPenTime < 1200)) return;
      if (pointer) return;
      e.preventDefault();
      try { pad.setPointerCapture(e.pointerId); } catch (_) {}
      const action = mode === 'paint'
        ? { kind: 'paint', role: paintTool === 'erase' ? 'U' : role, width: Number($('brush-size').value) / 100, points: [point(e)] }
        : { kind: 'ink', device: ['pen', 'touch', 'mouse'].includes(e.pointerType) ? e.pointerType : 'unknown', points: [point(e)] };
      mutableActions(state.current).push(action);
      pointer = { id: e.pointerId, type: e.pointerType, action };
      // Do not clear a validation message until pointerup. On a small phone
      // its removal changes the canvas size; reflowing mid-stroke would shift
      // the coordinates underneath the finger or pen.
      invalidate(state.current);
      updateBrushCursor(e); drawPad();
    });
    pad.addEventListener('pointermove', (e) => {
      updateBrushCursor(e);
      if (!pointer || pointer.id !== e.pointerId) return;
      e.preventDefault();
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
      for (const ev of events.length ? events : [e]) addPoint(ev);
      invalidate(state.current); drawPad();
    });
    pad.addEventListener('pointerleave', () => { if (!pointer) $('brush-cursor').hidden = true; });
    const finish = (e) => {
      if (!pointer || e.pointerId !== pointer.id) return;
      if (e.type === 'pointerup') addPoint(e);
      pointer = null; $('draw-message').textContent = ''; invalidate(state.current); dirty(); save(); renderGroups(); renderPad();
      if (e.pointerType === 'touch' || e.type === 'pointercancel') $('brush-cursor').hidden = true;
    };
    pad.addEventListener('pointerup', finish);
    pad.addEventListener('pointercancel', finish);
  }
  function addCustom(raw, scroll = false) {
    const ch = String(raw || '').trim().normalize('NFC');
    if ([...ch].length !== 1 || !parts(ch)) {
      $('custom-error').textContent = '현대 한글 음절 한 글자를 입력해 주세요. 예: 국'; return false;
    }
    $('custom-error').textContent = '';
    if (!allChars().includes(ch)) {
      if (state.custom.length >= 50) { $('custom-error').textContent = '추가 글자는 최대 50개까지 쓸 수 있어요.'; return false; }
      state.custom.push(ch); dirty();
    }
    $('custom-char').value = '';
    selectChar(ch, scroll); return true;
  }
  // Work on a copy and replay the actual paint actions. If replay cannot
  // reproduce the user's labels or changes basic topology, retain the entire
  // original sample; no raw paths or paint actions are ever overwritten.
  function resolveCleanup(ch, design) {
    const original = actions(ch), a = analysis(ch);
    if (!design?.cleanupStrength) return { actions: original, analysis: a, changed: false, fallback: false };
    const cleaned = Cleanup.cleanActions(original, design.cleanupStrength, design.device);
    let changed = false;
    for (let j = 0; j < cleaned.length && !changed; j++) {
      if (cleaned[j]?.kind !== 'ink') continue;
      const points = cleaned[j].points, old = original[j].points;
      for (let i = 0; i < points.length; i++) {
        if (points[i][0] !== old[i][0] || points[i][1] !== old[i][1]) { changed = true; break; }
      }
    }
    if (!changed) return { actions: original, analysis: a, changed: false, fallback: false };
    if (!isComplete(ch)) return { actions: cleaned, analysis: null, changed: true, pending: true, fallback: false };
    const roleIds = rolesFor(ch).map((r) => r.id);
    const b = Coloring.analyzeActions(cleaned, roleIds);
    const verdict = Cleanup.compatible(a, b, roleIds);
    return verdict.ok ? { actions: cleaned, analysis: b, changed: true, fallback: false }
      : { actions: original, analysis: a, changed: true, fallback: true, reason: verdict.reason };
  }
  function strokePreview(design) {
    const ch = state.current;
    if (!hasAny(ch)) return null;
    const cleaned = resolveCleanup(ch, design);
    let note;
    if (!design.cleanupStrength) note = '0%로 설정되어 원본 획 그대로예요. 다듬어도 저장된 원본은 바뀌지 않아요.';
    else if (cleaned.pending) note = '색칠 완료 전의 예상 모습이에요. 생성할 때 색칠과 획 형태를 다시 확인합니다.';
    else if (cleaned.fallback) note = `이 글자는 ${cleaned.reason} 때문에 원본을 유지해요. 검사에서 놓치는 변화도 있으니 직접 확인해 주세요.`;
    else if (cleaned.changed) note = '색칠과 획·구멍 개수 검사를 통과한 예상 모습이에요. 작은 변화이므로 직접 확인해 주세요.';
    else note = '현재 설정으로 움직인 점이 없어 원본과 같아요. 점이 적거나 짧은 획은 그대로 둡니다.';
    return { source: `선택한 ‘${ch}’ · 내 입력`, before: actions(ch), after: cleaned.actions, note };
  }
  function createJobSamples(design = null) {
    const list = [], transfers = [], skipped = [], size = Coloring.SIZE;
    const cleanup = { applied: [], fallback: [] };
    for (const ch of allChars()) {
      if (!hasAny(ch)) continue;
      // Do not silently assign leftover ink or treat an unseparated drawing as
      // an original glyph. Keep it editable and clearly exclude it this time.
      if (!isComplete(ch)) { skipped.push(ch); continue; }
      const masks = {}, resolved = resolveCleanup(ch, design), a = resolved.analysis;
      if (resolved.fallback) cleanup.fallback.push({ char: ch, reason: resolved.reason });
      else if (resolved.changed) cleanup.applied.push(ch);
      for (const r of rolesFor(ch)) {
        const mask = a.masks[r.id].slice(); // Worker transfer must not detach the UI's cached masks.
        masks[r.id] = mask.buffer; transfers.push(mask.buffer);
      }
      // Send the same post-cleanup paths that were used to make these masks.
      // Copy points too: a main-thread fallback may yield while the user edits.
      const strokes = resolved.actions.filter((action) => action.kind === 'ink').map((action) => ({
        points: action.points.map((point) => [point[0], point[1]]),
      }));
      list.push({ char: ch, size, roles: masks, strokes });
    }
    return { list, transfers, skipped, cleanup };
  }
  function createVectorSamples() { return createJobSamples(); }
  // Explicitly copy saved drawings from another origin into this experiment.
  // Never replace an existing local drawing, copy names or touch the source.
  function importDrawings(raw) {
    if (!raw || !raw.trim()) throw new Error('복사한 저장 데이터를 먼저 붙여 넣어 주세요.');
    if (raw.length > IMPORT_LIMIT) throw new Error('데이터가 너무 커요. 저장 항목의 Value만 복사해 주세요.');
    let saved;
    try { saved = JSON.parse(raw); } catch (_) { throw new Error('저장 데이터 형식을 읽지 못했어요. JSON 값 전체를 복사해 주세요.'); }
    if (!saved || !saved.samples || typeof saved.samples !== 'object' || Array.isArray(saved.samples)) throw new Error('글씨 저장 데이터가 아니에요. geulmoa-drawing-v1 항목을 확인해 주세요.');
    const entries = Object.entries(saved.samples);
    if (entries.length > 150) throw new Error('글자 항목이 너무 많아요. 저장 항목의 전체 Value가 맞는지 확인해 주세요.');
    const added = [], existing = [], invalid = [], full = [];
    for (const [ch, entry] of entries) {
      if ([...ch].length !== 1 || (!parts(ch) && !EXTRAS.includes(ch))) { invalid.push(ch); continue; }
      if (hasAny(ch)) { existing.push(ch); continue; }
      const legacy = Array.isArray(entry), source = legacy ? entry : entry?.actions;
      if (!Array.isArray(source) || source.length > 4000) { invalid.push(ch); continue; }
      const next = []; let bad = false;
      for (const action of source) {
        if (!action || !Array.isArray(action.points) || !action.points.length || action.points.length > 3000 ||
          action.points.some((p) => !Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] < 0 || p[0] > 1 || p[1] < 0 || p[1] > 1)) { bad = true; break; }
        const points = action.points.map((p) => [p[0], p[1]]);
        if (legacy || action.kind === 'ink') {
          const role = legacy ? action.role : action.legacyRole;
          next.push({ kind: 'ink', points, ...(['L', 'V', 'T'].includes(role) ? { legacyRole: role } : {}),
            ...(['pen', 'touch', 'mouse', 'unknown'].includes(action.device) ? { device: action.device } : {}) });
        } else if (action.kind === 'paint' && ['L', 'V', 'T', 'U'].includes(action.role)) {
          const width = Number(action.width);
          next.push({ kind: 'paint', role: action.role, width: Number.isFinite(width) ? Math.max(.02, Math.min(.3, width)) : .12, points });
        } else { bad = true; break; }
      }
      if (bad || !next.some((a) => a.kind === 'ink')) { invalid.push(ch); continue; }
      if (!allChars().includes(ch)) {
        if (state.custom.length >= 50) { full.push(ch); continue; }
        state.custom.push(ch);
      }
      state.samples[ch] = { version: 2, actions: next }; invalidate(ch); added.push(ch);
    }
    if (added.length) { dirty(); save(); renderGroups(); renderPad(); }
    return { added, existing, invalid, full };
  }
  // Read (but never store or send) pasted data from the published origin for
  // the isolated local vector comparison. Validation matches normal export.
  function comparisonImport(raw) {
    if (!raw || !raw.trim()) throw new Error('먼저 공개 사이트에서 복사한 저장 데이터를 붙여 넣어 주세요.');
    if (raw.length > IMPORT_LIMIT) throw new Error('붙여 넣은 데이터가 너무 커요. 글씨 저장 항목의 값만 복사해 주세요.');
    let saved;
    try { saved = JSON.parse(raw); } catch (_) { throw new Error('저장 데이터 형식을 읽지 못했어요. 항목의 Value 전체를 복사해 주세요.'); }
    if (!saved || !saved.samples || typeof saved.samples !== 'object' || Array.isArray(saved.samples)) throw new Error('글씨 저장 데이터가 아니에요. geulmoa-drawing-v1의 Value를 복사해 주세요.');
    const chars = [...new Set([...BASE, ...CONTEXT, ...Object.keys(saved.samples)])];
    const list = [], skipped = [];
    for (const ch of chars) {
      if ([...ch].length !== 1 || !parts(ch)) continue;
      const entry = saved.samples[ch];
      let entries;
      if (Array.isArray(entry)) {
        entries = entry.filter((s) => s && Array.isArray(s.points) && s.points.length).map((s) => ({
          kind: 'ink', points: s.points, ...(['L', 'V', 'T'].includes(s.role) ? { legacyRole: s.role } : {}),
        }));
      } else entries = Array.isArray(entry?.actions) ? entry.actions.filter((s) => s && ['ink', 'paint'].includes(s.kind) && Array.isArray(s.points) && s.points.length) : [];
      if (!entries.some((s) => s.kind === 'ink')) continue;
      const rs = rolesFor(ch), a = Coloring.analyzeActions(entries, rs.map((r) => r.id));
      if (!a.inkCount || a.unassigned || rs.some((r) => !a.counts[r.id])) { skipped.push(ch); continue; }
      const masks = {};
      for (const r of rs) masks[r.id] = a.masks[r.id].slice().buffer;
      list.push({ char: ch, size: Coloring.SIZE, roles: masks,
        strokes: entries.filter((a) => a.kind === 'ink').map((a) => ({ points: a.points })) });
    }
    return { list, skipped };
  }
  function setBusy(busy) {
    building = busy; $('build-font').disabled = busy; $('reset-all').disabled = busy; $('build-progress').hidden = !busy;
    $('build-font').innerHTML = busy ? '폰트를 만들고 있어요 <span>···</span>' : '내 폰트 만들기 <span>↗</span>';
  }
  function updateMissingPreview() {
    if (!result) { $('preview-missing').textContent = ''; return; }
    const missing = [...new Set([...$('preview-text').value.normalize('NFC')].filter((c) => !/\s/.test(c) && !result.chars.has(c)))];
    $('preview-missing').textContent = missing.length ? `이 글자는 다른 글꼴로 표시돼요: ${missing.slice(0, 14).join(' ')}${missing.length > 14 ? ' …' : ''}` : '이 문장의 모든 글자가 포함되어 있어요';
  }
  function updateInspector() {
    const value = $('inspect-char').value.trim().normalize('NFC'), info = $('inspect-status');
    if (!result) { info.textContent = '폰트를 생성하면 확인할 수 있어요.'; return; }
    if ([...value].length !== 1 || !parts(value)) { info.textContent = '한글 음절 한 글자를 입력해 주세요.'; return; }
    if (result.originals.has(value)) {
      const kept = result.cleanupFallback.get(value);
      info.textContent = result.cleanupApplied.has(value) ? '직접 쓴 음절에 흔들림 정리를 적용했어요.'
        : kept ? `흔들림 정리는 원본 음절을 유지했어요. (${kept})` : '직접 쓴 원본 음절을 바탕으로 만들었어요.';
    } else if (result.chars.has(value)) {
      const p = parts(value), src = result.sources[value];
      const explain = (label, jamo, from) => `${label} ${jamo}: ${from ? from + '에서' : '추정형'}`;
      info.textContent = src ? `자모 조합 · ${explain('초성', p.lead, src[0])} / ${explain('중성', p.vowel, src[1])}${p.final ? ' / ' + explain('종성', p.final, src[2]) : ''}` : '자모를 골라 조합한 추정 음절이에요.';
    }
    else { info.textContent = '폰트에 없는 글자예요. 다른 글꼴로 표시됩니다.'; return; }
    const correction = result.correction?.byChar?.[value];
    if (correction) {
      const labels = { adjusted: '벡터 획 굵기를 보정했어요.', partial: '일부 자모만 벡터 획 굵기를 보정했어요.',
        kept: '안전을 위해 보정 전 윤곽을 유지했어요.', same: '기준 굵기와 가까워 윤곽을 유지했어요.', off: '벡터 획 보정은 꺼져 있어요.' };
      info.textContent += ` ${labels[correction.status] || ''}${correction.reasons?.length ? ` (${correction.reasons.join(' · ')})` : ''}`;
    }
  }
  function renderCorrectionReport(data) {
    const report = data.strokeCorrection, title = $('correction-report-title'), text = $('correction-report-text');
    const keptText = $('correction-report-kept'), more = $('correction-report-more'), detail = $('correction-report-detail');
    keptText.textContent = ''; detail.textContent = ''; more.hidden = true;
    if (!report) { title.textContent = '획 보정 상태를 확인할 수 없어요'; text.textContent = '미리보기와 TTF를 확인해 주세요.'; return; }
    if (!report.enabled) {
      title.textContent = '벡터 획 보정 꺼짐';
      text.textContent = '보정 전 윤곽으로 TTF를 만들었어요. 다시 켜고 생성해 비교할 수 있어요.';
      return;
    }
    if (!report.available) {
      title.textContent = '벡터 보정을 사용할 수 없어요';
      text.textContent = '이 브라우저에서 획 경로를 그리지 못해 보정 전 윤곽으로 만들었어요.';
      keptText.textContent = '다른 브라우저에서 다시 시도하거나 이대로 결과를 확인해 주세요.'; return;
    }
    if (!report.target) {
      title.textContent = '벡터 보정을 적용하지 못했어요';
      text.textContent = '기준으로 삼을 수 있는 저장된 획 경로가 없어 기존 윤곽을 유지했어요.';
      keptText.textContent = '완료한 한글을 다시 쓰고 수동 색칠한 뒤 폰트를 다시 만들어 보세요.'; return;
    }
    const n = (x) => Number(x || 0).toLocaleString('ko-KR');
    const o = report.original, c = report.composed, j = report.jamo;
    title.textContent = '벡터 획 굵기 자동 보정 결과';
    text.textContent = `직접 쓴 음절 ${n(o.adjusted)}자, 조합 음절 ${n(c.adjusted + c.partial)}자에 적용했어요${c.partial ? ` (그중 ${n(c.partial)}자는 일부 자모만 보정)` : ''}. 독립 자모 ${n(j.adjusted)}자에도 적용했어요.`;
    const reasons = Object.keys(report.reasons || {});
    const kept = o.kept + c.kept, same = o.same + c.same;
    keptText.textContent = `보정 전 음절 윤곽 유지 ${n(kept)}자${same ? ` · 기준과 가까워 유지 ${n(same)}자` : ''}`;
    detail.textContent = `${reasons.length ? `보정 제외 사유: ${reasons.join(' / ')}. ` : ''}${report.extrasKept ? `숫자·기호 ${n(report.extrasKept)}자는 원래 윤곽을 사용했어요. ` : ''}작은 형태 변화까지 모두 판별하지는 못하므로 결과를 직접 확인해 주세요.`;
    more.hidden = false;
  }
  function renderResult(data, skipped = [], cleanup = { applied: [], fallback: [] }) {
    renderCorrectionReport(data);
    $('stat-coverage').innerHTML = `${data.hangulCount.toLocaleString('ko-KR')} <small>/ 11,172</small>`;
    $('stat-original').innerHTML = `${data.originalCount} <small>자</small>`;
    $('stat-context').innerHTML = `${data.contextCount} <small>개</small>`;
    $('stat-extra').innerHTML = `${data.extraCount} <small>자</small>`;
    const msg = [];
    if (data.hangulCount < 11172) msg.push(`부분 폰트예요. 현재 ${data.hangulCount.toLocaleString('ko-KR')}개의 한글 음절이 포함됩니다.`);
    else msg.push('현대 한글 완성 음절 11,172개가 포함됐어요. 표시 품질은 글자별로 확인해 주세요.');
    if (skipped.length) msg.push(`색칠이 끝나지 않아 이번 생성에서 제외한 글자: ${skipped.join(' ')}`);
    if (cleanup.applied.length) msg.push(`흔들림 정리 적용: ${cleanup.applied.join(' ')} (${cleanup.applied.length}자).`);
    if (cleanup.fallback.length) msg.push(`색칠이나 획 형태를 보존하기 위해 원본 유지: ${cleanup.fallback.map((x) => `${x.char}(${x.reason})`).join(' ')}.`);
    if (data.spacingClamped) msg.push(`너무 좁아지는 글자 ${data.spacingClamped}개에는 최소 폭을 적용했어요.`);
    if (data.incomplete.length) msg.push(`자모를 끝까지 나누지 않은 음절: ${data.incomplete.join(' ')}`);
    if (data.missing.length) {
      const examples = data.missing.slice(0, 8).map((s) => s.replace('L:', '초성 ').replace('V:', '중성 ').replace('T:', '종성 '));
      msg.push(`아직 부족한 자모 ${data.missing.length}개 (예: ${examples.join(', ')}${data.missing.length > 8 ? ' 등' : ''}). 아래 추천 음절을 완성해 주세요.`);
    }
    $('result-warning').textContent = msg.join(' ');
    const suggestions = $('suggestions'); suggestions.replaceChildren();
    if (data.suggest?.length) {
      const label = document.createElement('span'); label.textContent = '이 글자들을 채워 보세요 →'; suggestions.append(label);
      for (const ch of data.suggest) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'suggestion'; b.textContent = ch;
        b.addEventListener('click', () => addCustom(ch, true)); suggestions.append(b);
      }
    }
    $('result-info').hidden = false; updateMissingPreview(); updateInspector();
  }
  function commitFontName() {
    const name = String($('font-name').value || '').trim().normalize('NFC').slice(0, 40) || 'My Hand';
    if (state.fontName !== name) dirty();
    state.fontName = name; $('font-name').value = name; $('designer-font-name').value = name;
    if (Designer) Designer.switchProfile(name);
    save(); return name;
  }
  function startupError(message) {
    const error = new Error(message || '작업자를 시작하지 못했어요.'); error.workerStartup = true; return error;
  }
  function canvasCompatibilityError() {
    const error = new Error('작업자에서 획 경로를 그릴 수 없어요.'); error.vectorCompat = true; return error;
  }
  function runFontWorker(url, job, name, design) {
    return new Promise((resolve, reject) => {
      let active, finished = false, sawProgress = false, timer;
      function settle(error, data) {
        if (finished) return; finished = true; clearTimeout(timer);
        if (active) { try { active.terminate(); } catch (_) {} }
        if (worker === active) worker = null;
        if (error) reject(error); else resolve(data);
      }
      try { active = new Worker(url); worker = active; }
      catch (error) { settle(startupError(error.message)); return; }
      // On sandboxed/proxied previews a worker can fail to load with an empty
      // onerror message. Distinguish this from an error in an already running
      // font job so only startup failures are retried on the main page.
      timer = setTimeout(() => { if (!sawProgress) settle(startupError('작업자 시작 시간이 초과됐어요.')); }, 15000);
      active.onerror = (event) => {
        if (event.preventDefault) event.preventDefault();
        const message = event.message || (sawProgress ? '글꼴 생성 중 작업이 중단됐어요.' : '작업자를 불러오지 못했어요.');
        settle(sawProgress ? new Error(message) : startupError(message));
      };
      active.onmessageerror = () => settle(sawProgress
        ? new Error('글꼴 생성 중 작업자의 결과를 읽지 못했어요.')
        : startupError('작업자의 결과를 읽지 못했어요.'));
      active.onmessage = ({ data }) => {
        if (!data || typeof data !== 'object') { settle(new Error('작업자가 알 수 없는 결과를 보냈어요.')); return; }
        if (data.type === 'progress') { sawProgress = true; clearTimeout(timer); $('build-status').textContent = data.message; return; }
        if (data.type === 'compat-required' && !sawProgress) { settle(canvasCompatibilityError()); return; }
        if (data.type === 'error') { settle(new Error(data.message || '글꼴 생성 중 오류가 발생했어요.')); return; }
        if (data.type === 'done') settle(null, data);
      };
      // Do not detach the original mask buffers: an embedded browser can fail
      // to launch a worker after postMessage and must be able to retry safely.
      try { active.postMessage({ samples: job.list, name, design }); }
      catch (error) { settle(startupError(error.message)); }
    });
  }
  let mainEnginePromise = null;
  function loadMainEngine() {
    if (window.GeulmoaMainEngine) return Promise.resolve(window.GeulmoaMainEngine);
    if (mainEnginePromise) return mainEnginePromise;
    mainEnginePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = MAIN_ENGINE_URL; script.async = true;
      script.onload = () => window.GeulmoaMainEngine ? resolve(window.GeulmoaMainEngine) : reject(new Error('호환 생성기를 초기화하지 못했어요.'));
      script.onerror = () => reject(new Error('호환 생성기 파일을 불러오지 못했어요. 로컬 서버와 브라우저 보안 설정을 확인해 주세요.'));
      document.head.append(script);
    }).catch((error) => { mainEnginePromise = null; throw error; });
    return mainEnginePromise;
  }
  async function workerBlobUrl() {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 10000) : null;
    try {
      const response = await fetch(WORKER_URL, { cache: 'no-store', credentials: 'same-origin', ...(controller ? { signal: controller.signal } : {}) });
      if (!response.ok) throw new Error(`작업자 파일을 읽지 못했어요 (${response.status}).`);
      const source = await response.text();
      if (!source.trim()) throw new Error('작업자 파일이 비어 있어요.');
      return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    } finally { clearTimeout(timer); }
  }
  async function runFontJob(job, name, design) {
    // Sandboxed frames have an opaque origin even when location.origin looks
    // normal. Their Worker and fetch attempts are commonly blocked by the
    // browser itself, so avoid the doomed requests and their noisy errors.
    const opaqueOrigin = typeof self.origin === 'string' && self.origin === 'null';
    if (!opaqueOrigin) {
      let needsCanvasFallback = false;
      try { return { data: await runFontWorker(WORKER_URL, job, name, design), mode: 'worker' }; }
      catch (error) {
        if (error.vectorCompat) needsCanvasFallback = true;
        else if (!error.workerStartup) throw error;
      }
      if (!needsCanvasFallback) {
        $('build-status').textContent = '작업자 연결을 다시 시도하고 있어요. 작성한 글씨는 그대로입니다.';
        if (typeof Worker === 'function') {
          let blobUrl;
          try {
            blobUrl = await workerBlobUrl();
            return { data: await runFontWorker(blobUrl, job, name, design), mode: 'blob' };
          } catch (error) { if (blobUrl && !error.workerStartup && !error.vectorCompat) throw error; }
          finally { if (blobUrl) URL.revokeObjectURL(blobUrl); }
        }
      }
    }
    $('build-status').textContent = '브라우저 호환 모드로 만들고 있어요. 마지막 단계에서 화면이 수 초 이상 멈출 수 있어요.';
    await new Promise((resolve) => setTimeout(resolve, 20));
    const engine = await loadMainEngine();
    const data = await engine.buildScreenFont(job.list, name,
      (message) => { $('build-status').textContent = `호환 모드 · ${message}${message.startsWith('TTF') ? ' · 화면이 수 초 이상 멈출 수 있어요.' : ''}`; },
      { ...design, cooperative: true });
    return { data, mode: 'compat' };
  }
  async function build() {
    if (building) return;
    const name = commitFontName();
    const design = { ...(Designer ? Designer.getSettings() : {}), vectorCorrection: state.autoStroke };
    const job = createJobSamples(design);
    if (!job.list.length) {
      $('build-status').textContent = job.skipped.length ? '글자를 쓴 뒤 초성·중성·종성을 모두 색칠해 주세요. 색칠을 완료한 글자만 폰트에 사용돼요.' : '먼저 위에서 글자를 하나 이상 써 주세요.'; $('build-status').classList.add('error');
      $('studio').scrollIntoView({ behavior: 'smooth' }); return;
    }
    $('build-status').classList.remove('error'); setBusy(true);
    $('build-status').textContent = '작성한 획을 모으고 있어요';
    const jobRevision = revision;
    try {
      const { data, mode: generationMode } = await runFontJob(job, name, design);
      const family = `GeulmoaPreview${Date.now()}`;
      const freshFace = new FontFace(family, data.ttf);
      await freshFace.load();
      if (fontFace) document.fonts.delete(fontFace);
      fontFace = freshFace; document.fonts.add(fontFace);
      $('preview-text').style.fontFamily = `"${family}", -apple-system, BlinkMacSystemFont, sans-serif`;
      if (downloadURL) URL.revokeObjectURL(downloadURL);
      downloadURL = URL.createObjectURL(new Blob([data.ttf], { type: 'font/ttf' }));
      $('download-font').href = downloadURL;
      $('download-font').download = `${name.replace(/[^a-zA-Z0-9가-힣_-]+/g, '_').slice(0, 40) || 'MyHand'}.ttf`;
      $('download-font').hidden = false; $('download-help').hidden = false;
      result = { chars: new Set(data.chars), originals: new Set(data.originalChars), sources: data.sources || {}, revision: jobRevision,
        correction: data.strokeCorrection || null,
        cleanupApplied: new Set(job.cleanup.applied), cleanupFallback: new Map(job.cleanup.fallback.map((x) => [x.char, x.reason])) };
      const stale = jobRevision !== revision;
      $('download-font').innerHTML = `${stale ? '이전 상태 TTF 다운로드' : 'TTF 다운로드'} <span>↓</span>`;
      $('font-state').textContent = stale ? '변경 있음 · 다시 생성 필요' : '내 손글씨 폰트 적용 중';
      $('font-state').className = `status-pill ${stale ? 'dirty' : 'ready'}`;
      $('build-status').textContent = stale ? '생성 중 필기나 설정이 바뀌었어요. 다시 생성해 최신 내용을 반영해 주세요.'
        : data.hangulCount === 0 ? '완성 음절이 없어요. 글자의 초성·중성부터 채워 주세요.'
        : `${data.hangulCount === 11172 ? '폰트가 완성됐어요.' : '부분 폰트를 만들었어요.'} 한글 음절 ${data.hangulCount.toLocaleString('ko-KR')}자를 담았습니다.${generationMode === 'compat' ? ' 브라우저 호환 모드로 만들었어요.' : generationMode === 'blob' ? ' 대체 작업자 방식으로 만들었어요.' : ''}`;
      if (Designer) Designer.setFont({ family, design: data.design, chars: data.chars, stale });
      renderResult(data, job.skipped, job.cleanup);
    } catch (error) {
      const detail = String(error?.message || '알 수 없는 오류').slice(0, 240);
      $('build-status').textContent = `생성하지 못했어요: ${detail} 작성한 글씨는 화면에 그대로 있어요. 자동 저장을 확인하거나 필기를 백업한 뒤 다시 시도해 주세요.`;
      $('build-status').classList.add('error');
    } finally { setBusy(false); }
  }
  function setupMobileNavigation() {
    const links = [...document.querySelectorAll('.mobile-nav a')];
    function activate(id) {
      for (const link of links) {
        const active = link.getAttribute('href') === `#${id}`;
        link.classList.toggle('mobile-nav-active', active);
        if (active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
      }
    }
    for (const link of links) link.addEventListener('click', () => activate(link.getAttribute('href').slice(1)));
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) if (entry.isIntersecting) activate(entry.target.id);
      }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });
      for (const id of ['studio', 'preview', 'designer']) observer.observe($(id));
    }
  }
  function wire() {
    setupPointer(); setupMobileNavigation(); setupCaptureAccessibility();
    $('hero-start').addEventListener('click', openCapture);
    $('start-writing').addEventListener('click', openCapture);
    $('capture-close').addEventListener('click', closeCapture);
    $('landing-prev').addEventListener('click', () => moveChar(-1));
    $('landing-next').addEventListener('click', () => moveChar(1));
    $('paint-erase').addEventListener('click', () => { paintTool = paintTool === 'erase' ? 'paint' : 'erase'; renderPad(); });
    $('brush-size').addEventListener('input', () => {
      $('brush-size-label').textContent = `${$('brush-size').value}%`;
      $('brush-cursor').style.width = `${$('brush-size').value}%`;
    });
    $('prev-char').addEventListener('click', () => moveChar(-1));
    $('skip-char').addEventListener('click', () => moveChar(1));
    $('modal-back').addEventListener('click', () => {
      const steps = stagesFor(state.current), at = steps.findIndex((s) => s.id === currentStage());
      if (at > 0) setStage(steps[at - 1].id);
    });
    $('next-step').addEventListener('click', () => {
      dismissClearConfirmation();
      const ch = state.current;
      if (!hasAny(ch)) { $('draw-message').textContent = '먼저 글자 전체를 써 주세요. 나중에 하려면 건너뛰기를 눌러 주세요.'; return; }
      const steps = stagesFor(ch), at = steps.findIndex((s) => s.id === currentStage());
      const next = steps[at + 1];
      if (mode === 'paint' && !hasRole(ch, role)) {
        const current = rolesFor(ch).find((r) => r.id === role);
        $('draw-message').textContent = `${current.label} ‘${current.jamo}’ 획을 먼저 칠해 주세요.`; return;
      }
      if (next) { setStage(next.id); return; }
      if (!isComplete(ch)) {
        const a = analysis(ch), missing = rolesFor(ch).filter((r) => !a.counts[r.id]).map((r) => r.label);
        $('draw-message').textContent = a.unassigned
          ? `검은색으로 남은 획을 모두 칠해 주세요.${missing.length ? ` ${missing.join('·')} 색도 필요해요.` : ''}`
          : `${missing.join('·')}에 해당하는 획도 칠해 주세요.`;
        return;
      }
      moveChar(1);
    });
    $('undo').addEventListener('click', () => {
      const ch = state.current, a = actions(ch); if (!a.length) return;
      a.pop(); invalidate(ch);
      if (!hasAny(ch)) mode = 'draw';
      $('draw-message').textContent = ''; dirty(); save(); renderGroups(); renderPad();
    });
    $('clear-colors').addEventListener('click', () => requestClearConfirmation('colors'));
    $('clear-char').addEventListener('click', () => requestClearConfirmation('char'));
    $('capture-confirm-cancel').addEventListener('click', () => dismissClearConfirmation(true));
    $('capture-confirm-accept').addEventListener('click', acceptClearConfirmation);
    $('remove-custom').addEventListener('click', () => {
      const ch = state.current;
      if (hasAny(ch) && !confirm(`추가한 ‘${ch}’과 이 글자의 필기를 지울까요?`)) return;
      state.custom = state.custom.filter((x) => x !== ch); delete state.samples[ch]; invalidate(ch); dirty(); selectChar(BASE[0]);
    });
    $('reset-all').addEventListener('click', () => {
      if (!confirm('이 기기에 저장된 모든 필기를 지울까요? 되돌릴 수 없어요.')) return;
      if (worker) { worker.terminate(); worker = null; setBusy(false); }
      state = defaultState(); role = 'L'; mode = 'draw'; paintTool = 'paint'; analysisCache.clear(); revision++; result = null;
      if (fontFace) document.fonts.delete(fontFace); fontFace = null;
      if (downloadURL) URL.revokeObjectURL(downloadURL); downloadURL = null;
      $('preview-text').style.fontFamily = ''; $('font-state').className = 'status-pill'; $('font-state').textContent = '생성 전 · 시스템 글꼴';
      $('download-font').hidden = true; $('download-help').hidden = true; $('result-info').hidden = true; $('build-status').classList.remove('error');
      $('build-status').textContent = '작성한 글씨는 자동 저장돼요.'; $('preview-missing').textContent = ''; updateInspector();
      $('font-name').value = state.fontName; $('designer-font-name').value = state.fontName; $('auto-stroke').checked = state.autoStroke;
      if (Designer) { Designer.switchProfile(state.fontName); Designer.setFont(null); }
      $('preview-text').value = state.preview; save(); renderGroups(); renderPad();
    });
    $('add-custom').addEventListener('click', () => addCustom($('custom-char').value, true));
    $('custom-char').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addCustom(e.currentTarget.value, true); } });
    for (const id of ['font-name', 'designer-font-name']) {
      $(id).addEventListener('input', (e) => {
        state.fontName = e.currentTarget.value;
        $(id === 'font-name' ? 'designer-font-name' : 'font-name').value = state.fontName;
        dirty(); save();
      });
      $(id).addEventListener('change', commitFontName);
      $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) e.currentTarget.blur(); });
    }
    // Export drawings (including unfinished strokes and paint), not the font
    // name, preview text, or separately stored design profiles. A manual copy
    // path also works where an embedded browser silently blocks downloads.
    const backupText = () => JSON.stringify({ version: 2, samples: state.samples, custom: state.custom });
    $('backup-make-text').addEventListener('click', () => {
      const text = $('backup-text'); text.value = backupText(); text.focus(); text.select();
      $('backup-status').textContent = text.value.length > IMPORT_LIMIT
        ? '백업 내용이 너무 길어 한 번에 가져올 수 없어요. 복사해 보관하고 글자별로 나눠 가져와 주세요.'
        : '선택된 백업 내용을 복사해 보관해 주세요. 필기를 더 했다면 다시 준비해 주세요.';
    });
    $('backup-save').addEventListener('click', () => {
      try {
        const blob = new Blob([backupText()], { type: 'application/json' });
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = 'geulmoa-handwriting-backup.json'; document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        $('backup-status').textContent = blob.size > IMPORT_LIMIT
          ? '백업 다운로드를 요청했지만 8MB를 넘어 한 번에 불러올 수 없어요. 파일을 보관하고 글자별로 나눠 가져와 주세요.'
          : '필기 백업 다운로드를 요청했어요. 파일이 보이지 않으면 아래에서 백업 내용을 직접 복사해 주세요.';
      } catch (_) { $('backup-status').textContent = '파일로 저장하지 못했어요. 아래에서 백업 내용을 직접 복사해 주세요.'; }
    });
    $('backup-open').addEventListener('click', () => $('backup-file').click());
    $('backup-file').addEventListener('change', async (event) => {
      const input = event.currentTarget, file = input.files && input.files[0];
      if (!file) return;
      try {
        if (file.size > IMPORT_LIMIT) throw new Error('백업 파일이 8MB를 넘어요. 글자별로 나눈 백업 파일을 불러와 주세요.');
        const raw = typeof file.text === 'function' ? await file.text() : await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('백업 파일을 읽지 못했어요.')); reader.readAsText(file);
        });
        const report = importDrawings(raw);
        const parts = [`${report.added.length}자 불러왔어요`];
        if (report.existing.length) parts.push(`기존 글씨 유지: ${report.existing.join(' ')}`);
        if (report.invalid.length) parts.push(`읽을 수 없어 제외: ${report.invalid.join(' ')}`);
        if (report.full.length) parts.push(`추가 글자 한도로 제외: ${report.full.join(' ')}`);
        $('backup-status').textContent = parts.join(' · ') + '.';
      } catch (error) { $('backup-status').textContent = error.message || '백업 파일을 읽지 못했어요.'; }
      finally { input.value = ''; }
    });
    $('designer-import-button').addEventListener('click', () => {
      try {
        const report = importDrawings($('designer-import-data').value);
        const notes = [`이 주소에 ${report.added.length}자 복사했어요`];
        if (report.existing.length) notes.push(`기존 글씨 유지: ${report.existing.join(' ')}`);
        if (report.invalid.length) notes.push(`읽을 수 없어 제외: ${report.invalid.join(' ')}`);
        if (report.full.length) notes.push(`추가 글자 한도로 제외: ${report.full.join(' ')}`);
        $('designer-import-status').textContent = notes.join(' · ') + '. 색칠이 끝나지 않은 글자는 완성한 뒤 생성할 수 있어요.';
        $('designer-import-data').value = '';
      } catch (error) { $('designer-import-status').textContent = error.message; }
    });
    $('preview-text').addEventListener('input', (e) => { state.preview = e.currentTarget.value; save(); updateMissingPreview(); });
    $('inspect-char').addEventListener('input', updateInspector);
    $('inspect-add').addEventListener('click', () => {
      if (!addCustom($('inspect-char').value, true)) $('inspect-status').textContent = '한글 음절 한 글자를 입력해 주세요.';
    });
    $('auto-stroke').addEventListener('change', (event) => { state.autoStroke = event.currentTarget.checked; dirty(); save(); });
    $('build-font').addEventListener('click', build);
  }
  readState();
  probeStorage();
  $('font-name').value = state.fontName || 'My Hand';
  $('designer-font-name').value = state.fontName || 'My Hand';
  $('auto-stroke').checked = state.autoStroke;
  if (typeof state.preview === 'string') $('preview-text').value = state.preview;
  wire(); renderGroups(); renderPad(); updateInspector();
  if (Designer) Designer.init({
    getName: () => state.fontName, getStrokePreview: strokePreview, onChange: dirty,
    selectProfile: (name) => {
      state.fontName = name; $('font-name').value = name; $('designer-font-name').value = name;
      Designer.switchProfile(name); save();
    },
  });
  if (window.GeulmoaThicknessLab) window.GeulmoaThicknessLab.init({ getLocal: createVectorSamples, parseImported: comparisonImport });
  if (migrated) {
    $('landing-state').textContent = '이전에 쓴 글씨와 색 지정도 보존했어요. 다시 열어 고칠 수 있어요.';
    save();
  }
})();
