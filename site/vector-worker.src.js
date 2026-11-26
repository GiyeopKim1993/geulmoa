// LOCAL EXPERIMENT: adjust pen width while redrawing captured stroke paths.
// The ordinary TTF generation worker is deliberately untouched.
const svgpath = require('svgpath');
const { tracePixels, traceGray } = require('../src/engine');
const { partsOf } = require('../src/screen-capture');
const { placeComponent, pathBox, slots, transform, componentKey } = require('../src/hangul');
const { selectVariation } = require('../src/jamo-context');
const { deriveComponents } = require('../src/derive');
const { fixWinding } = require('../src/winding');
const { topology } = require('../src/topology');
const { INK_WIDTH, splitByColor, frameFor, slotFor, mapPoint, median } = require('../src/vector-strokes');
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = { from: (u8) => new Uint8Array(u8) };
const { buildTTF } = require('../src/assemble');

const GRID = 640, PAD = 8, MAX_SAMPLES = 30, MAX_COMPOSED = 20;
let canvas, ctx;
function initRasterizer() {
  if (typeof OffscreenCanvas !== 'function' || typeof Path2D !== 'function') {
    throw new Error('이 브라우저에서는 경로 보정 실험을 지원하지 않아요. Chrome 또는 Edge에서 열어 주세요.');
  }
  canvas = new OffscreenCanvas(GRID, GRID);
  ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('실험용 그리기 화면을 만들지 못했어요.');
}
function isHangul(ch) {
  if (typeof ch !== 'string' || [...ch].length !== 1) return false;
  const code = ch.codePointAt(0); return code >= 0xac00 && code <= 0xd7a3;
}
function readMask(value, size) {
  if (!value) return new Uint8Array(size * size);
  const a = value instanceof Uint8Array ? value : new Uint8Array(value);
  return a.length === size * size ? a : new Uint8Array(size * size);
}
function maskPixels(a) { const out = []; for (let p = 0; p < a.length; p++) if (a[p]) out.push(p); return out; }
function cleanStrokes(strokes) {
  if (!Array.isArray(strokes)) return [];
  const out = [];
  for (const stroke of strokes.slice(0, 4000)) {
    const points = Array.isArray(stroke?.points) ? stroke.points.slice(0, 3000)
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map(([x, y]) => [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))]) : [];
    if (points.length) out.push({ points });
  }
  return out;
}
function drawPolyline(context, points) {
  if (!points.length) return;
  if (points.length === 1) { context.beginPath(); context.arc(points[0][0], points[0][1], context.lineWidth / 2, 0, Math.PI * 2); context.fill(); return; }
  context.beginPath(); context.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) context.lineTo(points[i][0], points[i][1]);
  context.stroke();
}
// Do the user's colored pixels correspond well enough to sampled centerlines?
// No role is guessed from a letter's visual position; questionable components
// retain their previous traced outline rather than silently dropping ink.
function splitWithFidelity(strokes, masks, size, roles) {
  const split = splitByColor(strokes, masks, size, roles), out = {};
  const c = new OffscreenCanvas(size, size), g = c.getContext('2d', { willReadFrequently: true });
  g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = INK_WIDTH * size; g.strokeStyle = g.fillStyle = '#000';
  for (const role of roles) {
    g.clearRect(0, 0, size, size);
    for (const line of split.byRole[role]) drawPolyline(g, line);
    const rgba = g.getImageData(0, 0, size, size).data, original = masks[role];
    let reference = 0, rendered = 0, both = 0;
    for (let p = 0; p < original.length; p++) {
      const a = Boolean(original[p]), b = rgba[p * 4 + 3] >= 100;
      if (a) reference++; if (b) rendered++; if (a && b) both++;
    }
    const recall = reference ? both / reference : 0, precision = rendered ? both / rendered : 0;
    out[role] = { lines: split.byRole[role], recall, precision,
      usable: split.byRole[role].length > 0 && recall >= 0.88 && precision >= 0.82 && split.missing <= Math.max(2, split.sampled * 0.005) };
  }
  return out;
}
function toGrid(point, frame, slot) {
  const [x, y] = mapPoint(point, frame, slot);
  return [x * GRID / 1000, (1000 - y) * GRID / 1000];
}
function clipToSourceBoard(context, frame, slot, size) {
  const a = toGrid([0, 0], frame, slot), b = toGrid([size, size], frame, slot);
  context.beginPath(); context.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); context.clip();
}
function resetContext(context) {
  context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, GRID, GRID);
  context.lineCap = 'round'; context.lineJoin = 'round'; context.fillStyle = context.strokeStyle = '#000';
}
// Reproduce exactly the M/Q/L smoothing of the captured path, but transform
// the centerline coordinates first. Only then choose the pen width in font
// space, so enlarging a drawing does not automatically enlarge its pen.
function drawWhole(strokes, frame, size, width) {
  resetContext(ctx); ctx.lineWidth = width * GRID / 1000;
  ctx.save(); clipToSourceBoard(ctx, frame, null, size);
  for (const stroke of strokes) {
    const p = stroke.points.map(([x, y]) => toGrid([x * size, y * size], frame, null));
    if (p.length === 1) { ctx.beginPath(); ctx.arc(p[0][0], p[0][1], ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); continue; }
    ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length - 1; i++) ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
    const last = p[p.length - 1]; ctx.lineTo(last[0], last[1]); ctx.stroke();
  }
  ctx.restore();
}
function drawPart(lines, frame, slot, size, width) {
  resetContext(ctx); ctx.lineWidth = width * GRID / 1000;
  ctx.save(); clipToSourceBoard(ctx, frame, slot, size);
  for (const line of lines) drawPolyline(ctx, line.map((p) => toGrid(p, frame, slot)));
  ctx.restore();
}
function cropFor(path, extraUnits = 0) {
  const b = pathBox(path), scale = GRID / 1000, margin = Math.ceil((extraUnits + 40) * scale);
  const x0 = Math.max(0, Math.floor(b.x0 * scale) - margin), y0 = Math.max(0, Math.floor((1000 - b.y1) * scale) - margin);
  const x1 = Math.min(GRID, Math.ceil(b.x1 * scale) + margin), y1 = Math.min(GRID, Math.ceil((1000 - b.y0) * scale) + margin);
  return { x0, y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}
function maskFromCrop(crop) {
  const rgba = ctx.getImageData(crop.x0, crop.y0, crop.width, crop.height).data, mask = new Uint8Array(crop.width * crop.height);
  for (let p = 0; p < mask.length; p++) if (rgba[p * 4 + 3] >= 100) mask[p] = 1;
  return mask;
}
function traceCurrent(pathBounds, width) {
  const crop = cropFor(pathBounds, width), mask = maskFromCrop(crop), gray = new Uint8Array(mask.length);
  for (let p = 0; p < mask.length; p++) gray[p] = mask[p] ? 0 : 255;
  const d = traceGray(gray, crop.width, crop.height);
  if (!d) return null;
  return fixWinding(svgpath(d).translate(crop.x0, crop.y0).scale(1000 / GRID, -1000 / GRID).translate(0, 1000).round(1).toString());
}
function signature(path) {
  resetContext(ctx);
  ctx.setTransform(GRID / 1000, 0, 0, -GRID / 1000, 0, GRID);
  ctx.fillStyle = '#000'; ctx.fill(new Path2D(path), 'nonzero');
  const crop = cropFor(path, 4), mask = maskFromCrop(crop);
  return topology(mask, crop.width, crop.height);
}
function fontBytes(name, glyphs) { return new Uint8Array(buildTTF(name, glyphs, { wordSpace: 500 })); }

self.onmessage = ({ data }) => {
  try {
    initRasterizer();
    const strength = Math.max(0, Math.min(1, Number(data.strength) || 0));
    const ratio = Math.max(0.7, Math.min(1.3, Number(data.targetRatio) || 1));
    const samples = (Array.isArray(data.samples) ? data.samples : []).slice(0, MAX_SAMPLES);
    const originals = new Map(), parts = {}, variations = {}, skipped = [];
    for (const sample of samples) {
      const char = sample && sample.char, size = Number(sample && sample.size);
      if (!isHangul(char) || !Number.isInteger(size) || size < 64 || size > 1024 || originals.has(char)) continue;
      const parsed = partsOf(char), requested = [['L', parsed.lead], ['V', parsed.vowel], ...(parsed.final ? [['T', parsed.final]] : [])];
      const masks = Object.fromEntries(requested.map(([role]) => [role, readMask(sample.roles && sample.roles[role], size)]));
      const groups = requested.map(([role, jamo]) => ({ role, key: componentKey(role, jamo), pixels: maskPixels(masks[role]) }));
      if (groups.some((g) => !g.pixels.length)) { skipped.push(char); continue; }
      const union = new Uint8Array(size * size);
      for (const group of groups) for (const p of group.pixels) union[p] = 1;
      const whole = tracePixels(maskPixels(union), size);
      if (!whole) { skipped.push(char); continue; }
      const d = placeComponent(whole.d, whole.cropSize, PAD, { inset: 90 });
      const strokes = cleanStrokes(sample.strokes), frame = frameFor(whole.box, { inset: 90 });
      const width = INK_WIDTH * size * frame.scale;
      const fit = strokes.length ? splitWithFidelity(strokes, masks, size, requested.map(([role]) => role)) : {};
      originals.set(char, { char, d, advance: 1000, strokes, frame, size, width });
      const sylW = whole.box.x1 - whole.box.x0 + 1, sylH = whole.box.y1 - whole.box.y0 + 1;
      for (const group of groups) {
        const crop = tracePixels(group.pixels, size);
        if (!crop) continue;
        const share = Math.max(crop.box.x1 - crop.box.x0 + 1, crop.box.y1 - crop.box.y0 + 1) / Math.max(sylW, sylH);
        const partD = placeComponent(crop.d, crop.cropSize, PAD, { share });
        if (!parts[group.key]) parts[group.key] = partD;
        (variations[group.key] ||= []).push({ d: partD, ...parsed, source: char,
          frame: frameFor(crop.box, { share }), size, fit: fit[group.role] || null });
      }
    }
    if (!originals.size) throw new Error('색칠을 완료한 한글 음절이 없어요. 먼저 글자를 쓰고 자모 색칠을 마쳐 주세요.');
    deriveComponents(parts);
    const baseTarget = median([...originals.values()].filter((g) => g.strokes.length).map((g) => g.width));
    if (!baseTarget) throw new Error('저장된 원래 획 경로를 찾지 못했어요.');
    const target = Math.max(14, Math.min(150, baseTarget * ratio));
    const candidates = [...originals.values()].map((g) => ({ ...g, kind: 'original' }));
    const unavailable = [], overLimit = [], wanted = [...new Set([...String(data.requested || '').normalize('NFC')].filter(isHangul))];
    for (const char of wanted) {
      if (originals.has(char)) continue;
      const p = partsOf(char), spec = slots(p.vowel, p.final);
      const requests = [['L', p.lead], ['V', p.vowel], ...(p.final ? [['T', p.final]] : [])];
      if (requests.some(([role, ch]) => !parts[componentKey(role, ch)])) { unavailable.push(char); continue; }
      if (candidates.length >= originals.size + MAX_COMPOSED) { overLimit.push(char); continue; }
      const components = requests.map(([role, jamo]) => {
        const key = componentKey(role, jamo), variant = selectVariation(variations, key, role, p);
        const part = variant && variant.d ? variant.d : parts[key];
        return { role, jamo, source: variant ? variant.source : null, variant,
          d: transform(part, spec[role], false), slot: slotFor(part, spec[role]) };
      });
      candidates.push({ char, d: fixWinding(components.map((c) => c.d).join(' ')), advance: 1000, kind: 'composed', components });
    }
    const cache = new Map(), sameWidth = (x) => x + (target - x) * strength;
    const before = [], after = [], stats = [];
    for (let i = 0; i < candidates.length; i++) {
      const g = candidates[i]; self.postMessage({ type: 'progress', message: `저장된 획 경로로 다시 그리고 있어요 ${i + 1} / ${candidates.length}` });
      let result = g.d, steps = [], adjusted = false;
      if (g.kind === 'original') {
        const newWidth = sameWidth(g.width);
        if (strength && g.strokes.length) {
          drawWhole(g.strokes, g.frame, g.size, newWidth);
          const redrawn = traceCurrent(g.d, newWidth);
          if (redrawn) { result = redrawn; adjusted = true; }
        }
        steps = [{ role: '전체', before: g.width, after: adjusted ? newWidth : g.width,
          method: adjusted ? 'vector' : strength ? 'fallback' : 'off', reason: !g.strokes.length ? '저장된 획 경로 없음' : '' }];
      } else {
        const paths = [];
        for (const c of g.components) {
          const variant = c.variant;
          let d = c.d, method = 'off', reason = '', widthBefore = 0, widthAfter = 0;
          if (variant) {
            widthBefore = INK_WIDTH * variant.size * variant.frame.scale * Math.sqrt(c.slot.kx * c.slot.ky);
            widthAfter = sameWidth(widthBefore);
          }
          if (strength) {
            if (!variant) { method = 'fallback'; reason = '추정 자모에는 원래 획 경로가 없음'; }
            else if (!variant.fit || !variant.fit.usable) { method = 'fallback'; reason = '색칠 경계와 획 경로를 충분히 맞추지 못함'; }
            else {
              const key = `${c.d}|${widthAfter.toFixed(3)}|${variant.source}|${c.role}`;
              if (!cache.has(key)) {
                drawPart(variant.fit.lines, variant.frame, c.slot, variant.size, widthAfter);
                cache.set(key, traceCurrent(c.d, widthAfter));
              }
              if (cache.get(key)) { d = cache.get(key); method = 'vector'; adjusted = true; }
              else { method = 'fallback'; reason = '다시 그린 획의 윤곽을 만들지 못함'; }
            }
          }
          if (method !== 'vector') widthAfter = widthBefore;
          paths.push(d); steps.push({ role: c.role, jamo: c.jamo, source: c.source,
            before: widthBefore, after: widthAfter, method, reason });
        }
        if (adjusted) result = fixWinding(paths.join(' '));
      }
      let warning = false;
      if (adjusted) {
        const a = signature(g.d), b = signature(result);
        warning = a.components !== b.components || a.holes !== b.holes;
      }
      before.push({ char: g.char, d: g.d, advance: 1000 });
      after.push({ char: g.char, d: result, advance: 1000 });
      stats.push({ char: g.char, kind: g.kind, adjusted, warning, steps });
    }
    self.postMessage({ type: 'progress', message: '비교용 폰트 두 개를 만들고 있어요' });
    const beforeFont = fontBytes('Geulmoa Path Test Before', before);
    const afterFont = fontBytes('Geulmoa Path Test After', after);
    self.postMessage({ type: 'done', before: beforeFont.buffer, after: afterFont.buffer,
      chars: candidates.map((s) => s.char).join(''), baseTarget, target, stats, unavailable, overLimit, skipped,
      sampleLimit: Array.isArray(data.samples) && data.samples.length > MAX_SAMPLES }, [beforeFont.buffer, afterFont.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error && error.message ? error.message : '획 경로 실험에 실패했어요.' });
  }
};
