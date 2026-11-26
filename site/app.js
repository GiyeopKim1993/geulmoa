(() => {
  'use strict';
  const BASE = [...'는성줄합복림댓같맞욕받닿싶판넷트'];
  const CONTEXT = [...'가거고구과각곡관값'];
  const EXTRAS = [...'0123456789.,?!-()'];
  const LEADS = [...'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'];
  const VOWELS = [...'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'];
  const FINALS = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'];
  const KEY = 'geulmoa-drawing-v1';
  const Coloring = window.GeulmoaColoring;
  const DEFAULT_PREVIEW = '안녕하세요, 반가워요.\n다람쥐 헌 쳇바퀴에 타고파';
  const $ = (id) => document.getElementById(id);
  const defaultState = () => ({ samples: {}, custom: [], current: BASE[0], fontName: 'My Hand', preview: DEFAULT_PREVIEW });
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
      state = { ...defaultState(), ...saved, custom: [...new Set(custom)], samples: normalizeSamples(saved.samples) };
      if (!allChars().includes(state.current)) state.current = BASE[0];
      role = nextMissingRole(state.current);
      mode = hasAny(state.current) && parts(state.current) ? 'paint' : 'draw';
    } catch (_) { state = defaultState(); analysisCache.clear(); }
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      document.querySelector('.top-local').innerHTML = '<span class="local-dot"></span> 내 기기에서 작업 중';
    } catch (_) {
      document.querySelector('.top-local').textContent = '자동 저장 공간을 확인해 주세요';
    }
  }
  function dirty() {
    revision++;
    if (result) {
      $('font-state').textContent = '변경 있음 · 다시 생성 필요';
      $('font-state').className = 'status-pill dirty';
      $('build-status').textContent = '필기 또는 이름이 바뀌었어요. 다시 생성하면 최신 내용이 반영돼요.';
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
  function renderPad() {
    const ch = state.current, rs = rolesFor(ch), p = parts(ch), a = analysis(ch);
    const r = rs.find((item) => item.id === role) || rs[0]; role = r.id;
    const coloring = mode === 'paint' && Boolean(p);
    $('target-char').textContent = ch;
    $('sample-category').textContent = groupInfo(ch);
    const index = allChars().indexOf(ch) + 1;
    $('sample-number').innerHTML = `${String(index).padStart(2, '0')} <i>/</i> ${String(allChars().length).padStart(2, '0')}`;
    $('target-hint').textContent = p ? '한 번에 쓰고, 색으로 나눠요' : '표시된 문자를 그대로 써 주세요';
    $('context-hint').textContent = p ? `${({ vertical: '세로 모음', horizontal: '가로 모음', mixed: '복합 모음' })[vowelLayout(p.vowel)]} · ${p.final ? '받침 있음' : '받침 없음'}` : '숫자와 기호는 색칠하지 않아요';
    $('mode-draw').classList.toggle('active', !coloring);
    $('mode-draw').setAttribute('aria-pressed', String(!coloring));
    $('mode-color').classList.toggle('active', coloring);
    $('mode-color').setAttribute('aria-pressed', String(coloring));
    $('mode-color').disabled = !hasAny(ch); $('mode-color').hidden = !p;
    $('mode-draw').parentElement.classList.toggle('single', !p);
    $('role-count').textContent = p ? `${coloring ? '2' : '1'} / 2` : '1 / 1';
    $('role-prompt').textContent = !coloring ? `‘${ch}’ 전체를 평소처럼 써 주세요`
      : paintTool === 'erase' ? '잘못 칠한 부분의 색만 지워요' : `${r.label} ‘${r.jamo}’의 획 위를 칠해 주세요`;
    $('remove-custom').hidden = !state.custom.includes(ch);
    const tabs = $('role-tabs'); tabs.replaceChildren(); tabs.hidden = !coloring;
    for (const item of p ? rs : []) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'role-tab'; b.dataset.role = item.id;
      if (item.id === role && paintTool === 'paint') b.classList.add('active');
      if (hasRole(ch, item.id)) b.classList.add('done');
      b.setAttribute('aria-pressed', String(item.id === role && paintTool === 'paint'));
      b.setAttribute('aria-label', `${item.label} ${item.jamo} 색으로 칠하기${hasRole(ch, item.id) ? ', 색칠한 획 있음' : ''}`);
      const dot = document.createElement('span'); dot.className = 'color-dot'; dot.setAttribute('aria-hidden', 'true');
      const name = document.createTextNode(item.label);
      const letter = document.createElement('span'); letter.textContent = item.jamo;
      const check = document.createElement('span'); check.className = 'check'; check.textContent = hasRole(ch, item.id) ? '✓' : '';
      b.append(dot, name, letter, check);
      b.addEventListener('click', () => { role = item.id; paintTool = 'paint'; $('draw-message').textContent = ''; renderPad(); });
      tabs.append(b);
    }
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
    $('pad').setAttribute('aria-label', coloring ? '자모 색칠 영역. 색을 선택한 뒤 해당 획 위를 칠하세요.' : '손글씨 입력 영역. 한 글자를 한 번에 쓰세요.');
    $('pad-instruction').textContent = coloring
      ? '선택한 색은 기존 획에만 칠해져요. 닿은 부분은 작은 붓으로 나누고, 틀리면 다시 칠하세요.'
      : p ? '초성·중성·종성을 나누지 말고, 글자 전체를 평소처럼 써 주세요.' : '숫자와 기호는 그대로 쓰면 됩니다. 자모 색칠은 필요 없어요.';
    const lastSample = index === allChars().length;
    $('next-step').innerHTML = p && !coloring ? '다음: 자모 색칠 <span>→</span>' : lastSample ? '미리보기로 <span>→</span>' : '다음 글자 <span>→</span>';
    $('prev-char').disabled = index <= 1;
    $('skip-char').textContent = lastSample ? '미리보기로' : '건너뛰기';
    $('undo').disabled = !actions(ch).length;
    $('clear-char').disabled = !hasAny(ch);
    drawPad();
  }
  function selectChar(ch, scroll = false) {
    if (!allChars().includes(ch)) return;
    if (pointer) { invalidate(state.current); pointer = null; dirty(); }
    state.current = ch; role = nextMissingRole(ch);
    mode = hasAny(ch) && parts(ch) ? 'paint' : 'draw'; paintTool = 'paint'; $('brush-cursor').hidden = true;
    $('draw-message').textContent = '';
    renderGroups(); renderPad(); save();
    if (scroll) $('drawing-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function setMode(next) {
    if (next === 'paint' && (!parts(state.current) || !hasAny(state.current))) return;
    mode = next; paintTool = 'paint';
    if (next === 'paint') role = nextMissingRole(state.current);
    $('draw-message').textContent = ''; renderPad();
  }
  function moveChar(delta) {
    const list = allChars(), at = list.indexOf(state.current), next = at + delta;
    if (next < 0) return;
    if (next >= list.length) { $('preview').scrollIntoView({ behavior: 'smooth' }); return; }
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
        : { kind: 'ink', points: [point(e)] };
      mutableActions(state.current).push(action);
      pointer = { id: e.pointerId, type: e.pointerType, action };
      invalidate(state.current); $('draw-message').textContent = '';
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
      pointer = null; invalidate(state.current); dirty(); save(); renderGroups(); renderPad();
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
  function createJobSamples() {
    const list = [], transfers = [], skipped = [], size = Coloring.SIZE;
    for (const ch of allChars()) {
      if (!hasAny(ch)) continue;
      // Do not silently assign leftover ink or treat an unseparated drawing as
      // an original glyph. Keep it editable and clearly exclude it this time.
      if (!isComplete(ch)) { skipped.push(ch); continue; }
      const masks = {}, a = analysis(ch);
      for (const r of rolesFor(ch)) {
        const mask = a.masks[r.id].slice(); // Worker transfer must not detach the UI's cached masks.
        masks[r.id] = mask.buffer; transfers.push(mask.buffer);
      }
      list.push({ char: ch, size, roles: masks });
    }
    return { list, transfers, skipped };
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
    if (result.originals.has(value)) info.textContent = '직접 쓴 원본 음절을 사용했어요.';
    else if (result.chars.has(value)) {
      const p = parts(value), src = result.sources[value];
      const explain = (label, jamo, from) => `${label} ${jamo}: ${from ? from + '에서' : '추정형'}`;
      info.textContent = src ? `자모 조합 · ${explain('초성', p.lead, src[0])} / ${explain('중성', p.vowel, src[1])}${p.final ? ' / ' + explain('종성', p.final, src[2]) : ''}` : '자모를 골라 조합한 추정 음절이에요.';
    }
    else info.textContent = '폰트에 없는 글자예요. 다른 글꼴로 표시됩니다.';
  }
  function renderResult(data, skipped = []) {
    $('stat-coverage').innerHTML = `${data.hangulCount.toLocaleString('ko-KR')} <small>/ 11,172</small>`;
    $('stat-original').innerHTML = `${data.originalCount} <small>자</small>`;
    $('stat-context').innerHTML = `${data.contextCount} <small>개</small>`;
    $('stat-extra').innerHTML = `${data.extraCount} <small>자</small>`;
    const msg = [];
    if (data.hangulCount < 11172) msg.push(`부분 폰트예요. 현재 ${data.hangulCount.toLocaleString('ko-KR')}개의 한글 음절이 포함됩니다.`);
    else msg.push('현대 한글 완성 음절 11,172개가 포함됐어요. 표시 품질은 글자별로 확인해 주세요.');
    if (skipped.length) msg.push(`색칠이 끝나지 않아 이번 생성에서 제외한 글자: ${skipped.join(' ')}`);
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
  async function build() {
    if (building) return;
    const job = createJobSamples();
    if (!job.list.length) {
      $('build-status').textContent = job.skipped.length ? '글자를 쓴 뒤 초성·중성·종성을 모두 색칠해 주세요. 색칠을 완료한 글자만 폰트에 사용돼요.' : '먼저 위에서 글자를 하나 이상 써 주세요.'; $('build-status').classList.add('error');
      $('studio').scrollIntoView({ behavior: 'smooth' }); return;
    }
    $('build-status').classList.remove('error'); setBusy(true);
    $('build-status').textContent = '작성한 획을 모으고 있어요';
    const jobRevision = revision, name = $('font-name').value.trim() || 'My Hand';
    try {
      const data = await new Promise((resolve, reject) => {
        worker = new Worker('worker.js');
        worker.onerror = (event) => { worker?.terminate(); worker = null; reject(new Error(event.message || '브라우저 작업자 오류')); };
        worker.onmessage = ({ data }) => {
          if (data.type === 'progress') { $('build-status').textContent = data.message; return; }
          worker?.terminate(); worker = null;
          if (data.type === 'error') reject(new Error(data.message)); else resolve(data);
        };
        worker.postMessage({ samples: job.list, name }, job.transfers);
      });
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
      $('download-font').hidden = false;
      result = { chars: new Set(data.chars), originals: new Set(data.originalChars), sources: data.sources || {}, revision: jobRevision };
      const stale = jobRevision !== revision;
      $('font-state').textContent = stale ? '변경 있음 · 다시 생성 필요' : '내 손글씨 폰트 적용 중';
      $('font-state').className = `status-pill ${stale ? 'dirty' : 'ready'}`;
      $('build-status').textContent = stale ? '생성 중 필기가 바뀌었어요. 다시 생성해 최신 내용을 반영해 주세요.'
        : data.hangulCount === 0 ? '완성 음절이 없어요. 글자의 초성·중성부터 채워 주세요.'
        : `${data.hangulCount === 11172 ? '폰트가 완성됐어요.' : '부분 폰트를 만들었어요.'} 한글 음절 ${data.hangulCount.toLocaleString('ko-KR')}자를 담았습니다.`;
      renderResult(data, job.skipped);
    } catch (error) {
      $('build-status').textContent = `생성하지 못했어요: ${error.message}`;
      $('build-status').classList.add('error');
    } finally { setBusy(false); }
  }
  function wire() {
    setupPointer();
    $('mode-draw').addEventListener('click', () => setMode('draw'));
    $('mode-color').addEventListener('click', () => setMode('paint'));
    $('paint-erase').addEventListener('click', () => { paintTool = paintTool === 'erase' ? 'paint' : 'erase'; renderPad(); });
    $('brush-size').addEventListener('input', () => {
      $('brush-size-label').textContent = `${$('brush-size').value}%`;
      $('brush-cursor').style.width = `${$('brush-size').value}%`;
    });
    $('prev-char').addEventListener('click', () => moveChar(-1));
    $('skip-char').addEventListener('click', () => moveChar(1));
    $('next-step').addEventListener('click', () => {
      const ch = state.current;
      if (!hasAny(ch)) { $('draw-message').textContent = '먼저 글자 전체를 써 주세요. 나중에 하려면 건너뛰기를 눌러 주세요.'; return; }
      if (parts(ch) && mode === 'draw') { setMode('paint'); return; }
      if (!isComplete(ch)) {
        const a = analysis(ch), missing = rolesFor(ch).filter((r) => !a.counts[r.id]).map((r) => `${r.label} ${r.jamo}`);
        $('draw-message').textContent = a.unassigned
          ? `검은색으로 남은 획을 모두 색칠해 주세요.${missing.length ? ` 아직 ${missing.join(', ')} 색도 필요해요.` : ''}`
          : `${missing.join(', ')}에 해당하는 획도 해당 색으로 칠해 주세요.`;
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
    $('clear-colors').addEventListener('click', () => {
      const ch = state.current;
      if (!hasPaint(ch) || !confirm(`‘${ch}’의 색칠만 지우고 다시 나눌까요? 쓴 글자는 그대로 남아요.`)) return;
      state.samples[ch] = { version: 2, actions: actions(ch).filter((a) => a.kind === 'ink').map((a) => ({ kind: 'ink', points: a.points })) };
      invalidate(ch); role = rolesFor(ch)[0].id; paintTool = 'paint';
      $('draw-message').textContent = '글자는 그대로 두고 색칠만 지웠어요.'; dirty(); save(); renderGroups(); renderPad();
    });
    $('clear-char').addEventListener('click', () => {
      const ch = state.current;
      if (!hasAny(ch) || !confirm(`‘${ch}’에 쓴 획과 색칠을 모두 지울까요?`)) return;
      state.samples[ch] = { version: 2, actions: [] }; invalidate(ch);
      role = rolesFor(ch)[0].id; mode = 'draw'; paintTool = 'paint';
      $('draw-message').textContent = ''; dirty(); save(); renderGroups(); renderPad();
    });
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
      $('download-font').hidden = true; $('result-info').hidden = true; $('build-status').classList.remove('error');
      $('build-status').textContent = '작성한 글씨는 자동 저장돼요.'; $('preview-missing').textContent = ''; updateInspector();
      $('font-name').value = state.fontName; $('preview-text').value = state.preview; save(); renderGroups(); renderPad();
    });
    $('add-custom').addEventListener('click', () => addCustom($('custom-char').value, true));
    $('custom-char').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addCustom(e.currentTarget.value, true); } });
    $('font-name').addEventListener('input', (e) => { state.fontName = e.currentTarget.value; dirty(); save(); });
    $('preview-text').addEventListener('input', (e) => { state.preview = e.currentTarget.value; save(); updateMissingPreview(); });
    $('inspect-char').addEventListener('input', updateInspector);
    $('inspect-add').addEventListener('click', () => {
      if (!addCustom($('inspect-char').value, true)) $('inspect-status').textContent = '한글 음절 한 글자를 입력해 주세요.';
    });
    $('build-font').addEventListener('click', build);
  }
  readState();
  $('font-name').value = state.fontName || 'My Hand';
  if (typeof state.preview === 'string') $('preview-text').value = state.preview;
  wire(); renderGroups(); renderPad(); updateInspector();
  if (migrated) {
    $('draw-message').textContent = '이전에 쓴 글씨와 자모 지정은 보존했어요. 잘못 지정된 획은 다른 색으로 다시 칠하거나 색칠만 초기화할 수 있어요.';
    save();
  }
})();
