'use strict';
// Adapted from kor-your-font/src/syllable-capture.js (MIT), by jogwangjae
// and contributors. See LICENSE. Screen-only, pure typed-array routines.
const { labelComponents } = require('./blob-core');
const { componentKey, decomposeSyllable } = require('./hangul');
const VERTICAL = new Set([...'ㅏㅐㅑㅒㅓㅔㅕㅖㅣ']);
const COMPOUND = new Set([...'ㅘㅙㅚㅝㅞㅟㅢ']);
const DOTTED = new Set([...'ㅎㅊㄶㅀ']);
const MIN_AREA = 20;
const layoutOf = (v) => COMPOUND.has(v) ? 'compound' : VERTICAL.has(v) ? 'vertical' : 'horizontal';
const partsOf = (ch) => {
  const code = ch.codePointAt(0);
  return code >= 0xAC00 && code <= 0xD7A3 ? decomposeSyllable(code) : null;
};

function componentsIn(ink, cs) {
  const parts = labelComponents(ink, cs, cs);
  const byId = new Map();
  for (let y = 0; y < cs; y++) for (let x = 0; x < cs; x++) {
    const p = y * cs + x;
    if (!ink[p]) continue;
    const id = parts.labels[p];
    const e = byId.get(id) || { id, x0: x, y0: y, x1: x, y1: y, area: 0 };
    if (x < e.x0) e.x0 = x; if (x > e.x1) e.x1 = x;
    if (y < e.y0) e.y0 = y; if (y > e.y1) e.y1 = y;
    e.area++;
    byId.set(id, e);
  }
  // the printed cell border is lighter than ink, but a stroke touching the
  // frame is a stroke that left the cell and cannot be trusted
  const boxes = [...byId.values()].filter((b) =>
    b.area >= MIN_AREA && b.x0 > 4 && b.y0 > 4 && b.x1 < cs - 5 && b.y1 < cs - 5);
  return { parts, boxes };
}

// Strokes written beside one another are one jamo; a cut across them halves it.
function bundle(boxes, axis) {
  const lo = axis === 'y' ? (b) => b.y0 : (b) => b.x0;
  const hi = axis === 'y' ? (b) => b.y1 : (b) => b.x1;
  const groups = boxes.map((b) => [b]);
  for (let again = true; again;) {
    again = false;
    outer:
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a0 = Math.min(...groups[i].map(lo)), a1 = Math.max(...groups[i].map(hi));
        const c0 = Math.min(...groups[j].map(lo)), c1 = Math.max(...groups[j].map(hi));
        const over = Math.min(a1, c1) - Math.max(a0, c0);
        if (over <= 0 || over < 0.7 * Math.min(a1 - a0, c1 - c0)) continue;
        groups[i] = [...groups[i], ...groups[j]];
        groups.splice(j, 1);
        again = true;
        break outer;
      }
    }
  }
  return groups;
}

const rightGroups = (bundles, lo, hi, p) =>
  bundles.filter((g) => (Math.min(...g.map(lo)) + Math.max(...g.map(hi))) / 2 >= p).length;

function cutInto(boxes, axis, ink, W, expect, window, minRight = 1) {
  if (boxes.length < 2) return null;
  const lo = axis === 'y' ? (b) => b.y0 : (b) => b.x0;
  const hi = axis === 'y' ? (b) => b.y1 : (b) => b.x1;
  const min = Math.min(...boxes.map(lo)), max = Math.max(...boxes.map(hi));
  const span = max - min;
  if (span < 4) return null;
  const y0 = Math.min(...boxes.map((b) => b.y0)), y1 = Math.max(...boxes.map((b) => b.y1));
  const x0 = Math.min(...boxes.map((b) => b.x0)), x1 = Math.max(...boxes.map((b) => b.x1));
  const crossed = (p) => {
    let n = 0;
    if (axis === 'y') { for (let x = x0; x <= x1; x++) if (ink[p * W + x]) n++; }
    else { for (let y = y0; y <= y1; y++) if (ink[y * W + p]) n++; }
    return n;
  };
  let peak = 1;
  for (let p = min; p <= max; p++) peak = Math.max(peak, crossed(p));
  const bundles = bundle(boxes, axis);
  const from = Math.max(min + 1, Math.round(min + span * window[0]));
  const to = Math.min(max - 1, Math.round(min + span * window[1]));
  let best = null, bestScore = -Infinity;
  for (let p = from; p <= to; p++) {
    const A = [], B = [];
    for (const g of bundles) {
      const c = (Math.min(...g.map(lo)) + Math.max(...g.map(hi))) / 2;
      (c < p ? A : B).push(...g);
    }
    if (!A.length || !B.length) continue;
    // A wide vowel is two uprights and must not be left holding one. Scoring
    // cannot decide this: the cut between the vowel's own strokes crosses less
    // ink than the one beside the consonant, so ink always wins and 넷 loses
    // half its ㅔ. Say outright how many pieces the far side needs.
    if (rightGroups(bundles, lo, hi, p) < minRight) continue;
    const score = -2 * (crossed(p) / peak) - Math.abs((p - min) / span - expect);
    if (score > bestScore) { bestScore = score; best = { top: A, bot: B, at: p }; }
  }
  return best;
}

// Split one blob that holds two jamo, along the path through it that crosses
// the least ink.
function carve(ink, W, box, axis, expect, slack, parts, owner) {
  const { x0, y0, x1, y1 } = box;
  const along0 = axis === 'h' ? x0 : y0, along1 = axis === 'h' ? x1 : y1;
  const cross0 = axis === 'h' ? y0 : x0, cross1 = axis === 'h' ? y1 : x1;
  const n = along1 - along0 + 1, m = cross1 - cross0 + 1;
  if (n < 3 || m < 3) return null;
  const target = cross0 + Math.round((cross1 - cross0) * expect);
  const lo = Math.max(cross0 + 1, target - Math.round(m * slack));
  const hi = Math.min(cross1 - 1, target + Math.round(m * slack));
  if (hi <= lo) return null;
  const span = hi - lo + 1;
  const at = (a, c) => (axis === 'h' ? ink[c * W + a] : ink[a * W + c]);
  const INK = 1000, PULL = 2;
  const cost = new Float64Array(n * span), back = new Int32Array(n * span).fill(-1);
  for (let j = 0; j < span; j++) cost[j] = (at(along0, lo + j) ? INK : 0) + PULL * Math.abs(lo + j - target);
  for (let i = 1; i < n; i++) {
    const base = i * span, prev = base - span, a = along0 + i;
    for (let j = 0; j < span; j++) {
      let bestC = Infinity, from = -1;
      for (let d = -1; d <= 1; d++) {
        const k = j + d;
        if (k < 0 || k >= span) continue;
        if (cost[prev + k] < bestC) { bestC = cost[prev + k]; from = k; }
      }
      cost[base + j] = bestC + (at(a, lo + j) ? INK : 0) + PULL * Math.abs(lo + j - target);
      back[base + j] = from;
    }
  }
  let bj = 0, bc = Infinity;
  for (let j = 0; j < span; j++) if (cost[(n - 1) * span + j] < bc) { bc = cost[(n - 1) * span + j]; bj = j; }
  const path = new Int32Array(n);
  let j = bj;
  for (let i = n - 1; i >= 0; i--) { path[i] = lo + j; const q = back[i * span + j]; if (q >= 0) j = q; }
  const A = [], B = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const p = y * W + x;
    if (!ink[p] || parts.labels[p] !== owner) continue;
    const i = Math.max(0, Math.min(n - 1, (axis === 'h' ? x : y) - along0));
    ((axis === 'h' ? y : x) < path[i] ? A : B).push(p);
  }
  return { A, B };
}

const boxGap = (b, boxes) => {
  let best = Infinity;
  for (const o of boxes) {
    const dx = Math.max(0, Math.max(o.x0 - b.x1, b.x0 - o.x1));
    const dy = Math.max(0, Math.max(o.y0 - b.y1, b.y0 - o.y1));
    best = Math.min(best, dx * dx + dy * dy);
  }
  return best;
};

// A mark that belongs to ㅎ or ㅊ, sitting in a jamo that has no such mark.
function reclaimStrayMarks(groups, jamo) {
  for (const from of groups) {
    if (DOTTED.has(jamo[from.role]) || from.boxes.length < 2) continue;
    const biggest = Math.max(...from.boxes.map((b) => b.area));
    for (const b of [...from.boxes]) {
      if (b.area > biggest * 0.25) continue;
      const near = groups
        .filter((g) => g !== from && g.boxes.length && DOTTED.has(jamo[g.role]))
        .sort((p, q) => boxGap(b, p.boxes) - boxGap(b, q.boxes))[0];
      if (!near || boxGap(b, near.boxes) > b.area) continue;
      from.boxes = from.boxes.filter((x) => x !== b);
      near.boxes.push(b);
    }
  }
}

function pixelsOf(ink, W, boxes, parts) {
  const want = new Set(boxes.map((b) => b.id));
  const out = [];
  for (const b of boxes) for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
    const p = y * W + x;
    if (ink[p] && want.has(parts.labels[p])) out.push(p);
  }
  return out;
}

// Split one cell into its jamo. Returns { key -> pixel indices } plus how much
// of the syllable each one filled.
function splitCell(ink, cs, ch) {
  const syl = partsOf(ch);
  const { parts, boxes } = componentsIn(ink, cs);
  if (!boxes.length) return null;
  if (!syl) {
    return { parts, boxes, groups: [{ key: componentKey('X', ch), pixels: pixelsOf(ink, cs, boxes, parts) }] };
  }
  const layout = layoutOf(syl.vowel);
  let tBoxes = [], body = boxes;
  if (syl.final) {
    const cut = cutInto(boxes, 'y', ink, cs, 0.72, [0.58, 0.88]);
    if (cut) { tBoxes = cut.bot; body = cut.top; }
  }
  let vRight = [];
  if (layout === 'compound') {
    const cut = cutInto(body, 'x', ink, cs, 0.62, [0.45, 0.85]);
    if (cut) { vRight = cut.bot; body = cut.top; }
  }
  const axis = layout === 'vertical' ? 'x' : 'y';
  // ㅐ ㅒ ㅔ ㅖ are two uprights, not one, so they take up more of the block and
  // the lead ends further left. Left at the middle the cut lands between the
  // vowel's own two strokes and hands the first of them to the consonant - 넷
  // gave up half its ㅔ, and every 제 in the font then read as 지.
  const wideVowel = 'ㅐㅒㅔㅖ'.includes(syl.vowel);
  const expect = layout === 'vertical' ? 0.5 : 0.45;
  const win = layout === 'vertical' ? [0.3, 0.75] : [0.25, 0.7];
  // only demand it when there is enough to go round; a wide vowel written as
  // one connected stroke is a single group and perfectly fine
  const needRight = wideVowel && layout === 'vertical' && bundle(body, 'x').length > 2 ? 2 : 1;
  const cut = cutInto(body, axis, ink, cs, expect, win, needRight);
  let leadPx = [], vowelPx = [], tPixels = [], carved = false;
  // A wide vowel left holding one piece, in a cell with only two pieces, means
  // its first upright was written into the consonant: 예 arrives as one blob of
  // ㅇ-and-ㅕ plus a bare ㅣ, and the ㅕ is then thrown away with the duplicate
  // ㅇ, so every 예 and 계 reads as 어 and 기. Carve the consonant instead and
  // give the far side back to the vowel.
  let rescued = [];
  const bare = cut && cut.bot.length
    ? (Math.max(...cut.bot.map((b) => b.x1)) - Math.min(...cut.bot.map((b) => b.x0)))
      < 0.4 * (Math.max(...cut.bot.map((b) => b.y1)) - Math.min(...cut.bot.map((b) => b.y0)))
    : false;
  // `bare` is the tell: what is left of the vowel is a lone upright. A ㅐ that
  // came through whole is already half as wide as it is tall, and must not be
  // handed a slice of the consonant beside it.
  if (cut && wideVowel && layout === 'vertical' && bare
      && bundle(cut.bot, 'x').length === 1 && bundle(cut.top, 'x').length === 1) {
    const lead = [...cut.top].sort((a, b) => b.area - a.area)[0];
    const wide = lead && (lead.x1 - lead.x0) > (lead.y1 - lead.y0) * 0.9;
    const split = wide && carve(ink, cs, lead, 'v', 0.6, 0.25, parts, lead.id);
    if (split && split.A.length && split.B.length) {
      rescued = split.B;
      cut.top = cut.top.filter((b) => b !== lead);
      cut.leadKept = split.A;
    }
  }
  if (cut) {
    const g = [
      { role: 'L', boxes: [...cut.top] },
      { role: 'V', boxes: [...cut.bot, ...vRight] },
      { role: 'T', boxes: [...tBoxes] },
    ];
    reclaimStrayMarks(g, { L: syl.lead, V: syl.vowel, T: syl.final });
    leadPx = [...pixelsOf(ink, cs, g[0].boxes, parts), ...(cut.leadKept || [])];
    vowelPx = [...pixelsOf(ink, cs, g[1].boxes, parts), ...rescued];
    tPixels = pixelsOf(ink, cs, g[2].boxes, parts);
  } else {
    const big = [...body].sort((a, b) => b.area - a.area)[0];
    const split = big && carve(ink, cs, big, layout === 'vertical' ? 'v' : 'h', 0.55, 0.28, parts, big.id);
    if (split) {
      const rest = body.filter((b) => b !== big);
      const before = (b) => (layout === 'vertical' ? b.x1 < big.x1 : b.y1 < big.y1);
      leadPx = [...split.A, ...pixelsOf(ink, cs, rest.filter(before), parts)];
      vowelPx = [...split.B, ...pixelsOf(ink, cs, rest.filter((b) => !before(b)), parts)];
      carved = true;
    }
    if (vRight.length) vowelPx = [...vowelPx, ...pixelsOf(ink, cs, vRight, parts)];
    tPixels = pixelsOf(ink, cs, tBoxes, parts);
  }
  const groups = [];
  if (leadPx.length && vowelPx.length) {
    groups.push({ key: componentKey('L', syl.lead), pixels: leadPx });
    groups.push({ key: componentKey('V', syl.vowel), pixels: vowelPx });
  }
  if (syl.final && tPixels.length) groups.push({ key: componentKey('T', syl.final), pixels: tPixels });
  return { parts, boxes, groups, carved, incomplete: !(leadPx.length && vowelPx.length) };
}



function renderPixels(pixels, W, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pixels) {
    const x = p % W, y = (p / W) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const cw = w + 2 * pad, ch = h + 2 * pad;
  const gray = new Uint8Array(cw * ch).fill(255);
  for (const p of pixels) {
    const x = p % W, y = (p / W) | 0;
    gray[(y - y0 + pad) * cw + (x - x0 + pad)] = 0;
  }
  return { gray, box: { x0, y0, x1, y1 }, cropSize: { width: cw, height: ch } };
}


module.exports = { splitCell, renderPixels, pixelsOf, partsOf };
