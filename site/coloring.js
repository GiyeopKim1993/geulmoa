/* Manual pixel-level color separation for screen-written syllables.
 * A paint stroke only labels ink that existed when it was applied. Later
 * handwriting is never silently colored by an earlier, broad brush stroke.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GeulmoaColoring = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SIZE = 256;
  const INK_WIDTH = 0.03;
  const THRESHOLD = 100;
  const LABEL_COLORS = { L: '#ff0000', V: '#00ff00', T: '#0000ff' };
  const DISPLAY_COLORS = { L: [106, 78, 211], V: [0, 139, 129], T: [218, 106, 56] };

  function drawPath(ctx, points, size, width, color) {
    if (!Array.isArray(points) || !points.length) return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width * size;
    if (points.length === 1) {
      ctx.beginPath(); ctx.arc(points[0][0] * size, points[0][1] * size, width * size / 2, 0, Math.PI * 2); ctx.fill(); return;
    }
    ctx.beginPath(); ctx.moveTo(points[0][0] * size, points[0][1] * size);
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      ctx.quadraticCurveTo(a[0] * size, a[1] * size, (a[0] + b[0]) * size / 2, (a[1] + b[1]) * size / 2);
    }
    const last = points[points.length - 1]; ctx.lineTo(last[0] * size, last[1] * size); ctx.stroke();
  }

  // This pure part also runs in Node tests. Every ink pixel is either assigned
  // to exactly one allowed role or explicitly left unclassified.
  function extractMasks(ink, labels, size, roleIds) {
    const literal = roleIds.length === 1 && roleIds[0] === 'X';
    const masks = {}, counts = { L: 0, V: 0, T: 0, X: 0 };
    for (const r of roleIds) masks[r] = new Uint8Array(size * size);
    const overlay = new Uint8ClampedArray(size * size * 4);
    let inkCount = 0, unassigned = 0;
    for (let p = 0; p < size * size; p++) {
      const i = p * 4, alpha = ink[i + 3];
      if (alpha < THRESHOLD) continue;
      inkCount++;
      let role = null;
      if (literal) role = 'X';
      else if (labels && labels[i + 3] >= THRESHOLD) {
        const [red, green, blue] = [labels[i], labels[i + 1], labels[i + 2]];
        role = red >= green && red >= blue ? 'L' : green >= blue ? 'V' : 'T';
        if (!masks[role]) role = null;
      }
      if (!role) { unassigned++; continue; }
      masks[role][p] = 1; counts[role]++;
      if (role !== 'X') {
        const color = DISPLAY_COLORS[role];
        overlay[i] = color[0]; overlay[i + 1] = color[1]; overlay[i + 2] = color[2];
        overlay[i + 3] = alpha;
      }
    }
    return { masks, counts, overlay, inkCount, unassigned, size };
  }

  function makeCanvas(size) {
    const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
    return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  function analyzeActions(actions, roleIds, size = SIZE) {
    const ink = makeCanvas(size), labels = makeCanvas(size), scratch = makeCanvas(size);
    const literal = roleIds.length === 1 && roleIds[0] === 'X';
    function applyBrush(action, role, width) {
      if (role !== 'U' && !roleIds.includes(role)) return;
      const ctx = scratch.ctx;
      ctx.clearRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'source-over';
      drawPath(ctx, action.points, size, width, LABEL_COLORS[role] || '#ffffff');
      // Limit the stroke to ink already present at this moment, not future ink.
      ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(ink.canvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      labels.ctx.globalCompositeOperation = role === 'U' ? 'destination-out' : 'source-over';
      labels.ctx.drawImage(scratch.canvas, 0, 0);
      labels.ctx.globalCompositeOperation = 'source-over';
    }
    for (const action of actions) {
      if (!action || !Array.isArray(action.points) || !action.points.length) continue;
      if (action.kind === 'ink') {
        drawPath(ink.ctx, action.points, size, INK_WIDTH, '#000000');
        // Old role-tagged drawings retain their tags and can be recolored.
        // Slightly over-cover the same path so antialiased edge pixels remain
        // labeled after clipping, instead of becoming accidental leftovers.
        if (!literal && action.legacyRole) applyBrush(action, action.legacyRole, INK_WIDTH + 4 / size);
      } else if (action.kind === 'paint' && !literal) {
        applyBrush(action, action.role, Math.min(0.3, Math.max(0.02, Number(action.width) || 0.12)));
      }
    }
    const inkRgba = ink.ctx.getImageData(0, 0, size, size).data;
    const labelRgba = literal ? null : labels.ctx.getImageData(0, 0, size, size).data;
    return extractMasks(inkRgba, labelRgba, size, roleIds);
  }

  return { SIZE, INK_WIDTH, DISPLAY_COLORS, drawPath, extractMasks, analyzeActions };
});
