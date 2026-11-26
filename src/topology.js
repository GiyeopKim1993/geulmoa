'use strict';
// Counts are used as warnings, not as proof of glyph identity or safety.
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
module.exports = { topology };
