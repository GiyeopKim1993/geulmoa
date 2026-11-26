'use strict';
// Jamo this hand never wrote, built out of jamo it did.
//
// The 67 component slots hold only 51 distinct shapes. 19 are irreducible.
// 23 are ink the writer already made, placed twice or side by side - ㅆ is two
// ㅅ, ㄳ is ㄱ then ㅅ, ㅢ is ㅡ then ㅣ. The remaining 9 add a single stroke to
// a shape that is already there - ㅋ is ㄱ with a bar across it.
//
// Deriving those 32 is what takes the amount a person has to write from 56
// syllables down to 13, and it is what lets a photograph that simply never
// contained ㅒ still produce a complete font.
//
// The tables below decide *where* the parts go. How wide each one ends up is
// taken from the writer, not from here: a part keeps its own aspect ratio, so
// a hand with a thick ㅣ gets a thick ㅣ inside ㅢ and a hand with a hairline
// one gets a hairline. This matters. Printed fonts agree with each other
// closely about these proportions (ㅚ ㅟ ㅢ split 0.82/0.12 in every face
// measured) and disagree with real handwriting, which split the same three
// 0.55/0.21 - so not one printed number is copied here.
//
// Nothing in this file invents a curve. The only mark it draws that was not
// traced from paper is a straight bar, and even that takes its thickness from
// the writer's own ㅣ.

const svgpath = require('svgpath');
const { componentKey, pathBox, LEADS, VOWELS, FINALS } = require('./hangul');
const { fixWinding } = require('./winding');

// The same ink twice. 된소리 are written as a doubled consonant and that is
// exactly what they are.
const DOUBLE = { ㄲ: 'ㄱ', ㄸ: 'ㄷ', ㅃ: 'ㅂ', ㅆ: 'ㅅ', ㅉ: 'ㅈ' };

// Two different jamo sharing one slot. Only ever finals.
const CLUSTER = {
  ㄳ: 'ㄱㅅ', ㄵ: 'ㄴㅈ', ㄶ: 'ㄴㅎ', ㄺ: 'ㄹㄱ', ㄻ: 'ㄹㅁ', ㄼ: 'ㄹㅂ',
  ㄽ: 'ㄹㅅ', ㄾ: 'ㄹㅌ', ㄿ: 'ㄹㅍ', ㅀ: 'ㄹㅎ', ㅄ: 'ㅂㅅ',
};

// A horizontal vowel with a vertical one beside it. Written left to right in
// that order, which is also the order the two parts are listed here.
const COMPOUND = {
  ㅘ: 'ㅗㅏ', ㅙ: 'ㅗㅐ', ㅚ: 'ㅗㅣ', ㅝ: 'ㅜㅓ', ㅞ: 'ㅜㅔ', ㅟ: 'ㅜㅣ', ㅢ: 'ㅡㅣ',
};

// 가획 - one stroke added to a shape that is already on the paper. `at` and
// `span` are fractions of the base jamo's own bounding box, measured from its
// top-left. These nine are the only derivations that draw a mark the writer
// did not make; everything above only moves ink around.
const ADDSTROKE = {
  ㅋ: { from: 'ㄱ', kind: 'bar-h', at: 0.58, span: [0.00, 0.62] },
  ㅌ: { from: 'ㄷ', kind: 'bar-h', at: 0.50, span: [0.00, 0.92] },
  ㅊ: { from: 'ㅈ', kind: 'hat', at: 0.06, span: [0.30, 0.70] },
  ㅑ: { from: 'ㅏ', kind: 'bar-h', at: 0.72, span: [0.00, 1.00] },
  ㅒ: { from: 'ㅐ', kind: 'bar-h', at: 0.72, span: [0.00, 0.62] },
  ㅕ: { from: 'ㅓ', kind: 'bar-h', at: 0.72, span: [0.00, 1.00] },
  ㅖ: { from: 'ㅔ', kind: 'bar-h', at: 0.72, span: [0.00, 0.62] },
  ㅛ: { from: 'ㅗ', kind: 'bar-v', at: 0.74, span: [0.00, 0.62] },
  ㅠ: { from: 'ㅜ', kind: 'bar-v', at: 0.74, span: [0.38, 1.00] },
};

// A component's placed outline lives in a 1000 x 1000 design cell with y
// pointing up, so `y1` is the top of the shape and `y0` the bottom.
function boxOf(d) {
  const b = pathBox(d);
  return { ...b, w: Math.max(1, b.x1 - b.x0), h: Math.max(1, b.y1 - b.y0) };
}

// Map a path's bounding box exactly onto a rectangle. Non-uniform on purpose:
// squeezing two ㅅ into the width of one is what a doubled consonant *is*, in
// print and by hand alike.
function place(d, { x, y, w, h }) {
  const b = boxOf(d);
  return svgpath(d)
    .translate(-b.x0, -b.y0)
    .scale(w / b.w, h / b.h)
    .translate(x, y)
    .round(1)
    .toString();
}

// The width this shape wants at a given height, if it is not to be distorted.
function widthAt(d, h) {
  const b = boxOf(d);
  return (b.w / b.h) * h;
}

function bar(x, y, w, h) {
  const x1 = x + w, y1 = y + h;
  return `M${x.toFixed(1)} ${y.toFixed(1)}L${x1.toFixed(1)} ${y.toFixed(1)}` +
         `L${x1.toFixed(1)} ${y1.toFixed(1)}L${x.toFixed(1)} ${y1.toFixed(1)}Z`;
}

// How thick this hand draws a single stroke, as a fraction of that stroke's
// length. A ㅣ is one stroke and nothing else, so its own bounding box is the
// measurement: width over height. ㅡ is the same stroke lying down. Reading it
// as a ratio rather than a size keeps it usable on a base jamo of any scale.
function strokeRatio(parts, outline = (v) => v.d) {
  const ratios = [];
  const vertical = parts[componentKey('V', 'ㅣ')];
  if (vertical) { const b = boxOf(outline(vertical)); ratios.push(b.w / b.h); }
  const horizontal = parts[componentKey('V', 'ㅡ')];
  if (horizontal) { const b = boxOf(outline(horizontal)); ratios.push(b.h / b.w); }
  if (!ratios.length) return 0.13;
  const r = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  // A hand that writes ㅣ with a taper can measure very thin, and a bar one
  // pixel wide disappears at text sizes. A brush can measure very thick and
  // would swallow the shape it is added to.
  return Math.min(0.30, Math.max(0.07, r));
}

// Two parts side by side inside one slot. `weights` is how much of the pair's
// width each takes; the gap is what is left over.
function beside(a, b, weights, widen) {
  const ba = boxOf(a), bb = boxOf(b);
  const y0 = Math.min(ba.y0, bb.y0), y1 = Math.max(ba.y1, bb.y1);
  const h = Math.max(1, y1 - y0);
  const width = Math.min(880, Math.max(ba.w, bb.w) * widen);
  const mid = (Math.min(ba.x0, bb.x0) + Math.max(ba.x1, bb.x1)) / 2;
  const x0 = Math.min(940 - width, Math.max(60, mid - width / 2));
  return fixWinding([
    place(a, { x: x0, y: y0, w: width * weights[0], h }),
    place(b, { x: x0 + width * (1 - weights[1]), y: y0, w: width * weights[1], h }),
  ].join(' '));
}

// A horizontal vowel with a vertical one to its right. The vertical part keeps
// its own proportions - that is the whole point, and it is why this comes out
// different for different hands - and the horizontal one takes the rest.
function compound(flat, upright) {
  const bf = boxOf(flat), bu = boxOf(upright);
  const y0 = Math.min(bf.y0, bu.y0), y1 = Math.max(bf.y1, bu.y1);
  const h = Math.max(1, y1 - y0);
  const width = Math.min(880, Math.max(bf.w, bu.w) * 1.12);
  const mid = (Math.min(bf.x0, bu.x0) + Math.max(bf.x1, bu.x1)) / 2;
  const x0 = Math.min(940 - width, Math.max(60, mid - width / 2));
  // The upright is the tall one and spans the whole slot; whatever width its
  // own shape asks for at that height is the width it gets, capped so a very
  // thick stroke cannot crowd the vowel it stands beside out of existence.
  const uw = Math.min(width * 0.34, Math.max(width * 0.06, widthAt(upright, h)));
  const gap = width * 0.04;
  const fw = width - uw - gap;
  return fixWinding([
    // The flat part keeps its own height rather than being stretched to the
    // upright's - a ㅡ pulled to full height is not a ㅡ any more - and sits
    // centred in the slot.
    place(flat, { x: x0, y: y0 + (h - bf.h) / 2, w: fw, h: bf.h }),
    place(upright, { x: x0 + fw + gap, y: y0, w: uw, h }),
  ].join(' '));
}

function addStroke(base, rule, ratio) {
  const b = boxOf(base);
  if (rule.kind === 'hat') {
    // ㅊ is ㅈ with a mark above it. Room has to be made, or the mark leaves
    // the cell and the syllable it lands in loses it.
    const t = Math.max(12, ratio * b.w);
    const body = place(base, { x: b.x0, y: b.y0, w: b.w, h: b.h * 0.74 });
    const x = b.x0 + b.w * rule.span[0];
    const w = b.w * (rule.span[1] - rule.span[0]);
    return fixWinding([body, bar(x, b.y1 - t, w, t)].join(' '));
  }
  if (rule.kind === 'bar-h') {
    // Room has to be made for the bar, not just space found for it. This hand
    // draws a stroke 27% as thick as it is long, so a bar dropped into ㄷ at
    // its natural weight closes both gaps and ㅌ arrives as a filled blob -
    // 튼튼 read as 든든. The writer's own answer is visible on the sheet: their
    // ㅌ is 1.6x the height of their ㄷ. So grow the shape by exactly the bar
    // it is about to gain. The horizontals thicken slightly with it, which is
    // a far smaller lie than a letter that reads as a different letter.
    const t = Math.max(12, ratio * b.w);
    const h = b.h + t;
    const body = place(base, { x: b.x0, y: b.y0, w: b.w, h });
    const x = b.x0 + b.w * rule.span[0];
    const w = b.w * (rule.span[1] - rule.span[0]);
    return fixWinding([body, bar(x, b.y0 + h - h * rule.at - t / 2, w, t)].join(' '));
  }
  const t = Math.max(12, ratio * b.h);
  const y = b.y1 - b.h * rule.span[1];
  const h = b.h * (rule.span[1] - rule.span[0]);
  return fixWinding([base, bar(b.x0 + b.w * rule.at - t / 2, y, t, h)].join(' '));
}

// How tall each kind of vowel ends up, from the slot table in hangul.js that
// composeSyllable already uses (the no-final case, which is the roomier one;
// a syllable with a final shrinks it again on the way in).
//
// This is needed because a component keeps the size it was captured at, and a
// derived one has no capture. Worse, the base it is built from carries an
// accident: a ㅣ cut out of a syllable that had a final was only ever 45% as
// tall as the block, so ㅢ built from it arrived at half size and - since
// `transform` only ever shrinks a preserved component, never grows it - stayed
// there. Measured against the writer's own ㅢ, which fills 91% of its slot, the
// derived one filled 52%.
const VOWEL_SLOT_H = { compound: 760, vertical: 850, horizontal: 380 };

function vowelClass(char) {
  if (COMPOUND[char]) return 'compound';
  return 'ㅛㅠ'.includes(char) ? 'horizontal' : 'vertical';
}

// Scale about the cell's centre. Where a component sits in its 1000-cell does
// not survive composition - `transform` re-centres it in its slot - so only the
// size here matters.
function scaleToHeight(d, target) {
  const b = boxOf(d);
  const k = target / b.h;
  if (!isFinite(k) || k <= 0) return d;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  return svgpath(d).translate(-cx, -cy).scale(k, k).translate(500, 500).round(1).toString();
}

// Fill in every component that can be built from the ones already present.
// Runs in dependency order: ㄾ is ㄹ followed by ㅌ, and ㅌ is itself derived.
//
// Returns the keys it added, so a caller can say what was written and what was
// worked out - and so the A/B check can throw exactly these away and rebuild
// them beside the real thing.
// Two callers hold their components in two shapes - `build-korean` keeps bare
// outline strings, `loadComponents` keeps { d, blob } - and a derived component
// has to go back in whichever shape it came out of.
function outlineOf(v) { return typeof v === 'string' ? v : (v && v.d); }

function deriveComponents(parts, { roles = ['L', 'V', 'T'] } = {}) {
  const bare = Object.values(parts).some((v) => typeof v === 'string');
  const ratio = strokeRatio(parts, outlineOf);
  const added = [];
  // A jamo only exists in the roles Hangul actually gives it. Without this the
  // cluster table happily builds an L:ㄳ out of L:ㄱ and L:ㅅ - a lead that
  // cannot occur, that nothing will ever ask for, and that makes the count of
  // what was derived a lie.
  const alphabet = { L: new Set(LEADS), V: new Set(VOWELS), T: new Set(FINALS.slice(1)) };
  const get = (role, char) => outlineOf(parts[componentKey(role, char)]);
  const put = (role, char, d, from) => {
    const key = componentKey(role, char);
    if (parts[key] || !d || !alphabet[role].has(char)) return;
    const out = role === 'V' ? scaleToHeight(d, VOWEL_SLOT_H[vowelClass(char)]) : d;
    parts[key] = bare ? out : { d: out, derived: from };
    added.push(key);
  };

  for (const role of roles) {
    for (const [char, rule] of Object.entries(ADDSTROKE)) {
      const base = get(role, rule.from);
      if (base) put(role, char, addStroke(base, rule, ratio), [rule.from]);
    }
    for (const [char, from] of Object.entries(DOUBLE)) {
      const base = get(role, from);
      // The two halves overlap. Squeezed to half the width each they keep
      // their shape but lose their weight - every stroke gets thinner by the
      // same factor - and the ㅆ in 있 came out a spindly mark beside the
      // writer's own chunky one. This hand draws ㅆ 1.33x the width of its ㅅ,
      // so each half stays near full width and they run into each other, which
      // is what a hand does anyway.
      if (base) put(role, char, beside(base, base, [0.58, 0.58], 1.35), [from, from]);
    }
    for (const [char, pair] of Object.entries(CLUSTER)) {
      const a = get(role, pair[0]), b = get(role, pair[1]);
      if (a && b) put(role, char, beside(a, b, [0.46, 0.50], 1.45), [pair[0], pair[1]]);
    }
    for (const [char, pair] of Object.entries(COMPOUND)) {
      const a = get(role, pair[0]), b = get(role, pair[1]);
      if (a && b) put(role, char, compound(a, b), [pair[0], pair[1]]);
    }
  }
  return added;
}

// Which of the 51 shapes can never be worked out and has to come off the paper.
function baseShapes() {
  const derived = new Set([
    ...Object.keys(DOUBLE), ...Object.keys(CLUSTER),
    ...Object.keys(COMPOUND), ...Object.keys(ADDSTROKE),
  ]);
  return derived;
}

// Every component slot that cannot be worked out and has to come off paper.
//
// The 19 irreducible shapes, plus ㅌ and ㅛ. Those two are derivable in
// principle and are held back on the evidence of the review sheet: this hand's
// stroke is 27% as thick as it is long, and at that weight the bar that turns
// ㄷ into ㅌ closes the letter up - 튼튼 read as 든든 - while the second stem of
// ㅛ merges with the first. They are also common enough to matter, 3.1% and
// 1.3% of the syllables in ordinary Korean prose. Nothing below 0.5% failed.
const HAND_ONLY = {
  L: [...'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅍㅎㅌ'],
  V: [...'ㅏㅐㅓㅔㅗㅜㅡㅣㅛ'],
  T: [...'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅍㅎㅌ'],
};

// Real syllables that between them cover every slot above. Chosen by greedy
// cover over the syllables of ordinary Korean prose, preferring the common
// ones, and every entry is a syllable that actually occurs - nonsense like 핳
// covers the same ground in 13 instead of 15, but a hand writing 핳 is not
// writing normally, which is the whole reason this project asks for syllables
// rather than lone jamo.
const COVER = [...'는성줄합복림댓에같표맞트받닿싶'];

function requiredSlots() {
  const keys = [];
  for (const [role, list] of Object.entries(HAND_ONLY)) for (const ch of list) keys.push(componentKey(role, ch));
  return keys;
}

// What is still missing once everything derivable has been derived.
function missingSlots(parts) {
  return requiredSlots().filter((key) => !parts[key]);
}

// The shortest set of real syllables that would fill the gaps - the whole point
// of flow (c): a photograph that falls short should say what to add, not just
// refuse. Greedy, which is within one of optimal on a cover this small.
function suggestSyllables(missing) {
  const want = new Set(missing);
  const cover = COVER.map((ch) => {
    const n = ch.codePointAt(0) - 0xac00;
    const lead = LEADS[Math.floor(n / (VOWELS.length * FINALS.length))];
    const vowel = VOWELS[Math.floor((n % (VOWELS.length * FINALS.length)) / FINALS.length)];
    const final = FINALS[n % FINALS.length];
    const keys = [componentKey('L', lead), componentKey('V', vowel)];
    if (final) keys.push(componentKey('T', final));
    return { ch, keys };
  });
  const pick = [];
  while (want.size) {
    let best = null, score = 0;
    for (const c of cover) {
      const n = c.keys.filter((k) => want.has(k)).length;
      if (n > score) { score = n; best = c; }
    }
    if (!best) break;
    pick.push(best.ch);
    best.keys.forEach((k) => want.delete(k));
  }
  return { syllables: pick, uncovered: [...want] };
}

module.exports = {
  deriveComponents, baseShapes, suggestSyllables, missingSlots, requiredSlots,
  COVER, HAND_ONLY, DOUBLE, CLUSTER, COMPOUND, ADDSTROKE, strokeRatio,
};
