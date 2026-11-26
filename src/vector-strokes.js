'use strict';
// Experimental vector-first path reconstruction. The input points are those
// saved while writing; role labels come ONLY from the user's colored pixels.
const { pathBox } = require('./hangul');
const INK_WIDTH = 0.03;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Reproduce coloring.js's M, Q-to-midpoint, ..., L interpolation and flatten
// it finely enough to consult the manually painted role map along the path.
function flattenStroke(raw, size, spacing = 0.55) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const points = raw.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([x, y]) => [Math.max(0, Math.min(1, x)) * size, Math.max(0, Math.min(1, y)) * size]);
  if (!points.length) return [];
  const out = [points[0]], maxPoints = 120000;
  let from = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const control = points[i], end = [(points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2];
    const n = Math.max(1, Math.ceil((dist(from, control) + dist(control, end)) / spacing));
    if (out.length + n > maxPoints) throw new Error('저장된 획의 경로가 너무 복잡해요.');
    for (let k = 1; k <= n; k++) {
      const t = k / n, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
      out.push([a * from[0] + b * control[0] + c * end[0], a * from[1] + b * control[1] + c * end[1]]);
    }
    from = end;
  }
  if (points.length > 1) {
    const end = points[points.length - 1], n = Math.max(1, Math.ceil(dist(from, end) / spacing));
    if (out.length + n > maxPoints) throw new Error('저장된 획의 경로가 너무 복잡해요.');
    for (let k = 1; k <= n; k++) { const t = k / n; out.push([from[0] * (1 - t) + end[0] * t, from[1] * (1 - t) + end[1] * t]); }
  }
  return out;
}

// Never infer a jamo from position: look up the user-painted pixel. Nearest
// labeled pixel is only a small antialias/rounding fallback at the ink edge.
function roleAt(point, masks, size, roles) {
  const x = Math.max(0, Math.min(size - 1, Math.floor(point[0])));
  const y = Math.max(0, Math.min(size - 1, Math.floor(point[1])));
  const p = y * size + x;
  for (const role of roles) if (masks[role] && masks[role][p]) return { role, nearby: false };
  let best = null, bestDistance = Infinity;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const xx = x + dx, yy = y + dy, d = dx * dx + dy * dy;
    if (xx < 0 || yy < 0 || xx >= size || yy >= size || d > 9 || d >= bestDistance) continue;
    const q = yy * size + xx;
    for (const role of roles) if (masks[role] && masks[role][q]) { best = role; bestDistance = d; break; }
  }
  return { role: best, nearby: Boolean(best) };
}

function splitByColor(strokes, masks, size, roles, maxSampled = 200000) {
  const byRole = Object.fromEntries(roles.map((r) => [r, []]));
  let missing = 0, nearest = 0, sampled = 0;
  for (const stroke of strokes) {
    const line = flattenStroke(stroke.points, size);
    if (sampled + line.length > maxSampled) throw new Error('저장된 획의 경로가 너무 복잡해요.');
    let role = null, current = null, last = null;
    function finish() { if (role && current && current.length) byRole[role].push(current); current = null; }
    for (const point of line) {
      sampled++;
      const found = roleAt(point, masks, size, roles), next = found.role;
      if (found.nearby) nearest++; if (!next) missing++;
      if (next !== role) {
        let boundary = null;
        if (current && last && next && role) {
          boundary = [(last[0] + point[0]) / 2, (last[1] + point[1]) / 2];
          current.push(boundary);
        }
        finish(); role = next; current = role ? (boundary ? [boundary, point] : [point]) : null;
      } else if (current) current.push(point);
      last = point;
    }
    finish();
  }
  return { byRole, missing, nearest, sampled };
}

function frameFor(box, { inset = 60, share } = {}) {
  const width = box.x1 - box.x0 + 1, height = box.y1 - box.y0 + 1;
  if (width <= 0 || height <= 0) throw new Error('빈 글씨 영역이에요.');
  const span = (1000 - 2 * inset) * (share ? Math.max(0.15, Math.min(1, share)) : 1);
  const scale = Math.min(span / width, span / height);
  return { x0: box.x0, y0: box.y0, scale, left: (1000 - width * scale) / 2, top: (1000 - height * scale) / 2 };
}
// Exact same affine fit as hangul.transform(..., preserve=false).
function slotFor(path, slot) {
  const box = pathBox(path), w = Math.max(1, box.x1 - box.x0), h = Math.max(1, box.y1 - box.y0);
  const slotW = 1000 * slot.sx, slotH = 1000 * slot.sy;
  const fit = Math.min(slotW / w, slotH / h), stretch = 1.5;
  const kx = Math.min(slotW / w, fit * stretch), ky = Math.min(slotH / h, fit * stretch);
  const left = slot.x + (slotW - w * kx) / 2;
  const top = slot.y + (slotH - h * ky) / 2;
  const bottom = 1000 - top - h * ky;
  return { kx, ky, tx: left - box.x0 * kx, ty: bottom - box.y0 * ky };
}
function mapPoint(point, frame, slot = null) {
  let x = frame.left + (point[0] - frame.x0) * frame.scale;
  let y = 1000 - frame.top - (point[1] - frame.y0) * frame.scale;
  if (slot) { x = x * slot.kx + slot.tx; y = y * slot.ky + slot.ty; }
  return [x, y]; // font coordinates, y up
}
function median(values) {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
module.exports = { INK_WIDTH, flattenStroke, roleAt, splitByColor, frameFor, slotFor, mapPoint, median };
