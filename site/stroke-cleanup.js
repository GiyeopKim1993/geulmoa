/* Corner-aware, opt-in cleanup for saved screen strokes. No raw data is changed. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GeulmoaStrokeCleanup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DEVICE_FACTOR = { pen: 0.55, mouse: 0.8, touch: 1, unknown: 0.7 };
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  function cleanStroke(points, strength, device = 'unknown') {
    if (!Array.isArray(points)) return [];
    const original = points.map((p) => Array.isArray(p) ? [p[0], p[1]] : p);
    const amount = clamp(Number(strength) || 0, 0, 100) / 100 * (DEVICE_FACTOR[device] || DEVICE_FACTOR.unknown);
    if (!amount || original.length < 4 || original.some((p) => !Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return original;
    const n = original.length, cumulative = new Float64Array(n), corners = new Uint8Array(n);
    for (let i = 1; i < n; i++) cumulative[i] = cumulative[i - 1] + dist(original[i - 1], original[i]);
    if (cumulative[n - 1] < 0.02) return original; // keep tiny dots/marks
    // A malformed import could contain thousands of identical samples. Bound
    // neighbour scans so a single stroke cannot stall the main UI thread.
    const maxNeighbours = 192, span = 0.018, cosLimit = Math.cos(52 * Math.PI / 180);
    for (let i = 1; i < n - 1; i++) {
      let l = i - 1, r = i + 1;
      while (l > 0 && i - l < maxNeighbours && cumulative[i] - cumulative[l] < span) l--;
      while (r < n - 1 && r - i < maxNeighbours && cumulative[r] - cumulative[i] < span) r++;
      const ax = original[i][0] - original[l][0], ay = original[i][1] - original[l][1];
      const bx = original[r][0] - original[i][0], by = original[r][1] - original[i][1];
      const al = Math.hypot(ax, ay), bl = Math.hypot(bx, by);
      if (al >= 0.006 && bl >= 0.006 && (ax * bx + ay * by) / (al * bl) < cosLimit) corners[i] = 1;
    }
    const window = 0.009 + 0.012 * amount, maxMove = 0.0045 * amount;
    return original.map((p, i) => {
      if (i === 0 || i === n - 1 || corners[i]) return p;
      let weight = 1, x = p[0], y = p[1];
      for (const direction of [-1, 1]) {
        for (let j = i + direction; j > 0 && j < n - 1 && Math.abs(j - i) <= maxNeighbours; j += direction) {
          if (corners[j]) break; // never smooth across a detected corner
          const length = Math.abs(cumulative[j] - cumulative[i]);
          if (length >= window) break;
          const w = 1 - length / window; weight += w; x += original[j][0] * w; y += original[j][1] * w;
        }
      }
      let dx = (x / weight - p[0]) * amount, dy = (y / weight - p[1]) * amount;
      const d = Math.hypot(dx, dy);
      if (d > maxMove) { dx *= maxMove / d; dy *= maxMove / d; }
      return [clamp(p[0] + dx, 0, 1), clamp(p[1] + dy, 0, 1)];
    });
  }
  function cleanActions(actions, strength, device) {
    return actions.map((action) => {
      if (!action || action.kind !== 'ink') return action;
      const mode = device === 'auto' ? (DEVICE_FACTOR[action.device] ? action.device : 'unknown') : device;
      return { ...action, points: cleanStroke(action.points, strength, mode) };
    });
  }
  function topology(mask, width, height) {
    const seen = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
    function count(wanted, diagonal, holesOnly) {
      seen.fill(0); let total = 0;
      for (let start = 0; start < mask.length; start++) {
        if (seen[start] || mask[start] !== wanted) continue;
        let head = 0, tail = 0, edge = false; seen[start] = 1; queue[tail++] = start;
        while (head < tail) {
          const p = queue[head++], x = p % width, y = (p / width) | 0;
          if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge = true;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if ((!dx && !dy) || (!diagonal && dx && dy)) continue;
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
            const next = yy * width + xx;
            if (!seen[next] && mask[next] === wanted) { seen[next] = 1; queue[tail++] = next; }
          }
        }
        if (!holesOnly || !edge) total++;
      }
      return total;
    }
    return { components: count(1, true, false), holes: count(0, false, true) };
  }
  // Replaying the user's paint on cleaned ink must remain complete and close
  // to the user's original labels. Also reject changes to black components or
  // enclosed white regions. These checks are safeguards, not quality proof.
  function compatible(before, after, roles) {
    if (!before || !after || !after.inkCount || after.unassigned || roles.some((r) => !after.counts[r])) return { ok: false, reason: '색칠이 맞지 않음' };
    const n = before.size * before.size, a = new Uint8Array(n), b = new Uint8Array(n);
    for (const role of roles) {
      const oldMask = before.masks[role], newMask = after.masks[role];
      if (!oldMask || !newMask) return { ok: false, reason: '색칠이 맞지 않음' };
      let oldN = 0, newN = 0, intersection = 0;
      for (let i = 0; i < n; i++) {
        const x = Boolean(oldMask[i]), y = Boolean(newMask[i]);
        if (x) { a[i] = 1; oldN++; } if (y) { b[i] = 1; newN++; } if (x && y) intersection++;
      }
      if (!oldN || !newN || intersection / oldN < 0.82 || intersection / newN < 0.82) return { ok: false, reason: '색칠 경계가 달라짐' };
    }
    const x = topology(a, before.size, before.size), y = topology(b, before.size, before.size);
    if (x.components !== y.components || x.holes !== y.holes) return { ok: false, reason: '획 또는 구멍 형태가 달라짐' };
    return { ok: true, reason: '' };
  }
  return { cleanStroke, cleanActions, compatible, topology, DEVICE_FACTOR };
});
