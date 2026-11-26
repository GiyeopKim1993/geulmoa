'use strict';
// Automatic, vector-first stroke-width correction for the actual font.
// The user's painted masks are authoritative; this code never infers a role
// from position. Unreliable paths, changed topology, and unsafe contacts keep
// the previous traced outline. No source drawing or coloring is modified.
const svgpath = require('svgpath');
const { pathBox, transform } = require('./hangul');
const { fixWinding } = require('./winding');
const { topology } = require('./topology');
const { INK_WIDTH, splitByColor, frameFor, slotFor, mapPoint, median } = require('./vector-strokes');

// 512px per 1000 font units. Small counters and contacts can still escape a
// raster check; it is a safeguard, not a guarantee of visual quality.
const GRID = 512;
const THRESHOLD = 100;
const MIN_RATIO = 0.42, MAX_RATIO = 2.5;
const MAX_STROKES = 1000, MAX_POINTS = 60000;

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') {
    try {
      const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) return { canvas, ctx };
    } catch (_) {}
  }
  if (typeof document !== 'undefined' && document.createElement) {
    try {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) return { canvas, ctx };
    } catch (_) {}
  }
  return null;
}
function supportsVectorRaster() {
  try {
    if (typeof Path2D !== 'function') return false;
    const target = makeCanvas(4, 4);
    if (!target) return false;
    target.ctx.fill(new Path2D('M0 0L2 0L0 2Z'), 'nonzero');
    return true;
  } catch (_) { return false; }
}
function validStrokes(strokes) {
  if (!Array.isArray(strokes) || !strokes.length || strokes.length > MAX_STROKES) return null;
  let count = 0;
  const out = [];
  for (const stroke of strokes) {
    if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length || stroke.points.length > 3000) return null;
    count += stroke.points.length;
    if (count > MAX_POINTS) return null;
    const points = [];
    for (const p of stroke.points) {
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] < 0 || p[0] > 1 || p[1] < 0 || p[1] > 1) return null;
      points.push([p[0], p[1]]);
    }
    out.push({ points });
  }
  return out;
}
function sourcePath(ctx, points, size) {
  if (points.length === 1) {
    ctx.beginPath(); ctx.arc(points[0][0] * size, points[0][1] * size, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); return;
  }
  ctx.beginPath(); ctx.moveTo(points[0][0] * size, points[0][1] * size);
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    ctx.quadraticCurveTo(a[0] * size, a[1] * size, (a[0] + b[0]) * size / 2, (a[1] + b[1]) * size / 2);
  }
  const end = points[points.length - 1]; ctx.lineTo(end[0] * size, end[1] * size); ctx.stroke();
}
function polyline(ctx, points) {
  if (!points.length) return;
  if (points.length === 1) { ctx.beginPath(); ctx.arc(points[0][0], points[0][1], ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); return; }
  ctx.beginPath(); ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.stroke();
}
function comparePixels(mask, rgba) {
  let reference = 0, rendered = 0, both = 0;
  for (let p = 0; p < mask.length; p++) {
    const a = Boolean(mask[p]), b = rgba[p * 4 + 3] >= THRESHOLD;
    if (a) reference++; if (b) rendered++; if (a && b) both++;
  }
  return { recall: reference ? both / reference : 0, precision: rendered ? both / rendered : 0 };
}
function sourceFits(strokes, masks, union, size, roles) {
  const surface = makeCanvas(size, size);
  if (!surface) return null;
  const ctx = surface.ctx;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = INK_WIDTH * size;
  ctx.strokeStyle = ctx.fillStyle = '#000';
  for (const stroke of strokes) sourcePath(ctx, stroke.points, size);
  const whole = comparePixels(union, ctx.getImageData(0, 0, size, size).data);
  const split = splitByColor(strokes, masks, size, roles), fits = {};
  for (const role of roles) {
    ctx.clearRect(0, 0, size, size);
    for (const line of split.byRole[role]) polyline(ctx, line);
    const fit = comparePixels(masks[role], ctx.getImageData(0, 0, size, size).data);
    fits[role] = { lines: split.byRole[role], ...fit,
      usable: split.byRole[role].length > 0 && fit.recall >= 0.88 && fit.precision >= 0.82 &&
        split.missing <= Math.max(2, split.sampled * 0.005) };
  }
  return { fits, wholeUsable: whole.recall >= 0.94 && whole.precision >= 0.94 };
}
function gridPoint(point, frame, slot) {
  const [x, y] = mapPoint(point, frame, slot);
  return [x * GRID / 1000, (1000 - y) * GRID / 1000];
}
function clipBoard(ctx, frame, slot, size) {
  const a = gridPoint([0, 0], frame, slot), b = gridPoint([size, size], frame, slot);
  ctx.beginPath(); ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); ctx.clip();
}
function aloneMatrix(path) {
  const box = pathBox(path), w = Math.max(1, box.x1 - box.x0), h = Math.max(1, box.y1 - box.y0);
  const k = Math.min(620 / w, 720 / h), x = (1000 - w * k) / 2, y = (1000 - h * k) / 2;
  return { kx: k, ky: k, tx: x - box.x0 * k, ty: y - box.y0 * k };
}
function slotKey(slot) { return `${slot.x},${slot.y},${slot.sx},${slot.sy}`; }

class VectorCorrection {
  constructor({ enabled = true, traceGray }) {
    this.enabled = enabled;
    this.available = enabled && supportsVectorRaster();
    this.traceGray = traceGray;
    this.target = 0;
    this.records = new Map();
    this.contacts = new Map();
    this.nextSnapshotId = 1;
    if (this.available) {
      const surface = makeCanvas(GRID, GRID);
      if (!surface) this.available = false;
      else this.ctx = surface.ctx;
    }
  }
  prepare({ strokes: raw, masks, union, size, roles, wholeBox }) {
    const frame = frameFor(wholeBox, { inset: 90 });
    const width = INK_WIDTH * size * frame.scale;
    if (!this.enabled) return { frame, width, reason: '자동 보정 꺼짐' };
    if (!this.available) return { frame, width, reason: '이 브라우저에서 경로 보정을 사용할 수 없음' };
    const strokes = validStrokes(raw);
    if (!strokes) return { frame, width, reason: '저장된 획 경로가 없거나 너무 복잡함' };
    try {
      const fit = sourceFits(strokes, masks, union, size, roles);
      if (!fit) return { frame, width, reason: '경로를 확인할 수 없음' };
      return { frame, width, strokes, size, ...fit,
        reason: fit.wholeUsable ? '' : '저장된 경로가 원래 글씨와 맞지 않음' };
    } catch (_) {
      return { frame, width, reason: '저장된 획 경로를 안전하게 확인하지 못함' };
    }
  }
  setTarget(sources) {
    const widths = sources.filter((s) => s && s.strokes && s.wholeUsable).map((s) => s.width);
    this.target = widths.length ? Math.max(14, Math.min(150, median(widths))) : 0;
    this.targetSamples = widths.length;
  }
  reset() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, GRID, GRID);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.fillStyle = ctx.strokeStyle = '#000';
  }
  drawWhole(source, width) {
    const ctx = this.ctx; this.reset(); ctx.lineWidth = width * GRID / 1000;
    ctx.save(); clipBoard(ctx, source.frame, null, source.size);
    for (const stroke of source.strokes) {
      const points = stroke.points.map(([x, y]) => gridPoint([x * source.size, y * source.size], source.frame, null));
      if (points.length === 1) { ctx.beginPath(); ctx.arc(points[0][0], points[0][1], ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); continue; }
      ctx.beginPath(); ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        ctx.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      }
      const p = points[points.length - 1]; ctx.lineTo(p[0], p[1]); ctx.stroke();
    }
    ctx.restore();
  }
  drawPart(variant, matrix, width) {
    const ctx = this.ctx; this.reset(); ctx.lineWidth = width * GRID / 1000;
    ctx.save(); clipBoard(ctx, variant.frame, matrix, variant.size);
    for (const line of variant.fit.lines) polyline(ctx, line.map((p) => gridPoint(p, variant.frame, matrix)));
    ctx.restore();
  }
  crop(path, extra = 0) {
    const b = pathBox(path), scale = GRID / 1000, margin = Math.ceil((extra + 12) * scale) + 2;
    const x0 = Math.max(0, Math.floor(b.x0 * scale) - margin), y0 = Math.max(0, Math.floor((1000 - b.y1) * scale) - margin);
    const x1 = Math.min(GRID, Math.ceil(b.x1 * scale) + margin), y1 = Math.min(GRID, Math.ceil((1000 - b.y0) * scale) + margin);
    return { x0, y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
  }
  mask(crop) {
    const rgba = this.ctx.getImageData(crop.x0, crop.y0, crop.width, crop.height).data;
    const mask = new Uint8Array(crop.width * crop.height); let area = 0;
    for (let i = 0; i < mask.length; i++) if (rgba[i * 4 + 3] >= THRESHOLD) { mask[i] = 1; area++; }
    return { mask, area };
  }
  traceCurrent(pathBounds, width) {
    const crop = this.crop(pathBounds, width), { mask, area } = this.mask(crop);
    if (!area) return null;
    const gray = new Uint8Array(mask.length);
    for (let p = 0; p < mask.length; p++) gray[p] = mask[p] ? 0 : 255;
    const d = this.traceGray(gray, crop.width, crop.height);
    return d ? fixWinding(svgpath(d).translate(crop.x0, crop.y0).scale(1000 / GRID, -1000 / GRID).translate(0, 1000).round(1).toString()) : null;
  }
  snapshot(path) {
    this.reset(); const ctx = this.ctx;
    ctx.setTransform(GRID / 1000, 0, 0, -GRID / 1000, 0, GRID);
    ctx.fill(new Path2D(path), 'nonzero');
    const crop = this.crop(path), { mask, area } = this.mask(crop);
    return { ...crop, mask, area, topo: topology(mask, crop.width, crop.height), id: this.nextSnapshotId++ };
  }
  equivalent(before, after) {
    if (!before.area || !after.area) return false;
    const a = before.topo, b = after.topo, ratio = after.area / before.area;
    return a.components === b.components && a.holes === b.holes && ratio >= 0.4 && ratio <= 2.6;
  }
  original(base, source) {
    if (!this.enabled) return { d: base, status: 'off', reason: '' };
    if (!this.available) return { d: base, status: 'kept', reason: '이 브라우저에서 경로 보정을 사용할 수 없음' };
    if (!source || !source.strokes || !source.wholeUsable) return { d: base, status: 'kept', reason: source?.reason || '저장된 획 경로 없음' };
    if (!this.target) return { d: base, status: 'kept', reason: '기준 획 굵기를 정할 수 없음' };
    const ratio = this.target / source.width;
    if (ratio < MIN_RATIO || ratio > MAX_RATIO) return { d: base, status: 'kept', reason: '필요한 굵기 변화가 너무 큼' };
    if (Math.abs(source.width - this.target) < 1) return { d: base, status: 'same', reason: '' };
    try {
      this.drawWhole(source, this.target);
      const candidate = this.traceCurrent(base, this.target);
      if (!candidate) return { d: base, status: 'kept', reason: '다시 그린 획의 윤곽을 만들지 못함' };
      if (!this.equivalent(this.snapshot(base), this.snapshot(candidate))) return { d: base, status: 'kept', reason: '획 덩어리·구멍 또는 면적이 달라짐' };
      return { d: candidate, status: 'adjusted', reason: '' };
    } catch (_) { return { d: base, status: 'kept', reason: '획 모양을 안전하게 확인하지 못함' }; }
  }
  // A unique source/role/slot is redrawn and traced just once. The same
  // corrected outline is reused across all applicable 11,172 combinations.
  component({ key, part, variant, slot, alone = false, baseAlone }) {
    const cacheKey = `${alone ? 'alone' : slotKey(slot)}|${key}|${variant ? variant.source : 'derived'}`;
    if (this.records.has(cacheKey)) return this.records.get(cacheKey);
    const base = alone ? baseAlone : transform(part, slot, false);
    const record = { base, d: base, status: 'kept', reason: '', before: null, after: null };
    this.records.set(cacheKey, record);
    if (!this.enabled) { record.status = 'off'; return record; }
    if (!this.available) { record.reason = '이 브라우저에서 경로 보정을 사용할 수 없음'; return record; }
    if (!this.target) { record.reason = '기준 획 굵기를 정할 수 없음'; return record; }
    if (!variant) { record.reason = '추정 자모에는 원래 획 경로가 없음'; return record; }
    if (!variant.fit || !variant.fit.usable) { record.reason = variant.sourceReason || '수동 색칠 경계와 획 경로가 맞지 않음'; return record; }
    const matrix = alone ? aloneMatrix(part) : slotFor(part, slot);
    const natural = INK_WIDTH * variant.size * variant.frame.scale * Math.sqrt(matrix.kx * matrix.ky);
    const ratio = this.target / natural;
    if (!Number.isFinite(ratio) || ratio < MIN_RATIO || ratio > MAX_RATIO) { record.reason = '필요한 굵기 변화가 너무 큼'; return record; }
    if (Math.abs(natural - this.target) < 1 && Math.max(matrix.kx, matrix.ky) / Math.min(matrix.kx, matrix.ky) < 1.04) {
      record.status = 'same'; return record;
    }
    try {
      this.drawPart(variant, matrix, this.target);
      const candidate = this.traceCurrent(base, this.target);
      if (!candidate) { record.reason = '다시 그린 획의 윤곽을 만들지 못함'; return record; }
      record.before = this.snapshot(base); record.after = this.snapshot(candidate);
      if (!this.equivalent(record.before, record.after)) { record.reason = '획 덩어리·구멍 또는 면적이 달라짐'; record.after = null; return record; }
      record.d = candidate; record.status = 'adjusted';
    } catch (_) { record.reason = '획 모양을 안전하게 확인하지 못함'; }
    return record;
  }
  before(record) { return record.before || (record.before = this.snapshot(record.base)); }
  after(record) { return record.status === 'adjusted' ? record.after : this.before(record); }
  // If different roles already touch, or would touch after correction, retain
  // the original syllable. This conservative rule avoids introducing/removing
  // inter-role connections without needing 11,172 expensive whole-glyph traces.
  touching(a, b) {
    const lo = Math.min(a.id, b.id), hi = Math.max(a.id, b.id), key = `${lo}:${hi}`;
    if (this.contacts.has(key)) return this.contacts.get(key);
    const x0 = Math.max(a.x0, b.x0 - 1), y0 = Math.max(a.y0, b.y0 - 1);
    const x1 = Math.min(a.x0 + a.width - 1, b.x0 + b.width), y1 = Math.min(a.y0 + a.height - 1, b.y0 + b.height);
    let yes = false;
    outer: for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!a.mask[(y - a.y0) * a.width + x - a.x0]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx - b.x0, yy = y + dy - b.y0;
        if (xx >= 0 && yy >= 0 && xx < b.width && yy < b.height && b.mask[yy * b.width + xx]) { yes = true; break outer; }
      }
    }
    this.contacts.set(key, yes); return yes;
  }
  compose(components) {
    const records = components.map((c) => this.component(c));
    const baseline = () => fixWinding(records.map((r) => r.base).join(' '));
    const reasons = [...new Set(records.filter((r) => r.reason).map((r) => r.reason))];
    const adjusted = records.some((r) => r.status === 'adjusted');
    if (!adjusted) return { d: baseline(), status: this.enabled ? (reasons.length ? 'kept' : 'same') : 'off', reasons };
    try {
      for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) {
        if (this.touching(this.before(records[i]), this.before(records[j])) ||
            this.touching(this.after(records[i]), this.after(records[j]))) {
          return { d: baseline(), status: 'kept', reasons: ['자모 사이의 획이 닿거나 닿을 수 있음'] };
        }
      }
      return { d: fixWinding(records.map((r) => r.d).join(' ')), status: reasons.length ? 'partial' : 'adjusted', reasons };
    } catch (_) { return { d: baseline(), status: 'kept', reasons: ['자모 사이의 획을 안전하게 확인하지 못함'] }; }
  }
}
module.exports = { VectorCorrection, supportsVectorRaster, validStrokes, aloneMatrix, GRID };
