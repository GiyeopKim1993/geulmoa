'use strict';

// Modern Hangul is algorithmic: 19 leading consonants × 21 vowels ×
// (no final + 27 final consonants) = 11,172 precomposed Unicode syllables.
// We deliberately emit those precomposed codepoints. This works in ordinary
// Korean text fields and browsers without depending on optional GSUB shaping.
const svgpath = require('svgpath');
const { fixWinding } = require('./winding');
const { selectVariation } = require('./jamo-context');

const LEADS = [...'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'];
const VOWELS = [...'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'];
const FINALS = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'];
const VERTICAL_VOWELS = new Set([...'ㅏㅐㅑㅒㅓㅔㅕㅖㅣ']);
const HANGUL_START = 0xac00;
const HANGUL_COUNT = LEADS.length * VOWELS.length * FINALS.length;
const A4 = { w: 595.28, h: 841.89 };
const TEMPLATE = { margin: 40, header: 70, cols: 6, rows: 7, pad: 8 };

function componentKey(role, char) {
  return `${role}:${char}`;
}

// A Hangul-only font cannot set a date. The worksheet composes 11,172
// syllables from 67 jamo, which leaves 17 of its 84 cells empty - exactly
// enough for the digits and the punctuation that ordinary Korean prose needs.
// These are written once and used as themselves; nothing composes them.
const EXTRAS = [...'0123456789.,?!-()'];

function extraCharacters() {
  return EXTRAS.map((char) => ({ role: 'X', char, key: componentKey('X', char) }));
}

// Everything the printed worksheet asks for, in cell order.
function worksheetItems() {
  return [...requiredComponents(), ...extraCharacters()];
}

function requiredComponents() {
  return [
    ...LEADS.map((char) => ({ role: 'L', char, key: componentKey('L', char) })),
    ...VOWELS.map((char) => ({ role: 'V', char, key: componentKey('V', char) })),
    ...FINALS.slice(1).map((char) => ({ role: 'T', char, key: componentKey('T', char) })),
  ];
}

function decomposeSyllable(codepoint) {
  const n = codepoint - HANGUL_START;
  if (n < 0 || n >= HANGUL_COUNT) throw new Error('Not a modern Hangul syllable');
  const lead = Math.floor(n / (VOWELS.length * FINALS.length));
  const vowel = Math.floor((n % (VOWELS.length * FINALS.length)) / FINALS.length);
  const final = n % FINALS.length;
  return { lead: LEADS[lead], vowel: VOWELS[vowel], final: FINALS[final] };
}

// Fit one handwritten jamo into a neutral 1000 × 1000 design cell. The layout
// engine below then places that cell into its syllable slot.
// `share` is how much of its own syllable this jamo filled when it was written.
// Without it every component is blown up to the same square and the writer's
// own proportions are gone: a small ㅎ and a long ㅏ arrive the same size, and
// the slot then decides everything. With it, a jamo keeps the size the hand
// gave it. Only the syllable worksheet can supply this - a jamo written alone
// in a box has no syllable to be a fraction of.
function placeComponent(d, cropSize, pad, { inset = 60, share } = {}) {
  const inkW = cropSize.width - 2 * pad;
  const inkH = cropSize.height - 2 * pad;
  if (inkW <= 0 || inkH <= 0) throw new Error('Invalid component crop');
  const size = (1000 - 2 * inset) * (share ? Math.max(0.15, Math.min(1, share)) : 1);
  const scale = Math.min(size / inkW, size / inkH);
  const x = (1000 - inkW * scale) / 2;
  const y = (1000 - inkH * scale) / 2;
  return fixWinding(svgpath(d).translate(-pad, -pad).scale(scale, -scale).translate(x, 1000 - y).round(1).toString());
}

// Bounding box of a placed component. Control points can sit slightly outside
// the drawn curve, so this is a hair generous - which is the safe direction:
// it can only leave a component a little smaller than its slot.
function pathBox(d) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let cx = 0, cy = 0;
  const see = (x, y) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  svgpath(d).abs().unarc().iterate((seg) => {
    const cmd = seg[0];
    if (cmd === 'H') { cx = seg[1]; see(cx, cy); return; }
    if (cmd === 'V') { cy = seg[1]; see(cx, cy); return; }
    if (cmd === 'Z') return;
    for (let i = 1; i + 1 < seg.length + 1; i += 2) {
      if (typeof seg[i + 1] !== 'number') break;
      cx = seg[i]; cy = seg[i + 1];
      see(cx, cy);
    }
  });
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 1000, y1: 1000 };
  return { x0, y0, x1, y1 };
}

// Fit a component into its slot.
//
// Two things this must get right, both of which were wrong before:
//
// Scale uniformly. `placeComponent` normalises every component into a square
// preserving its aspect, so scaling by the slot's sx and sy separately
// stretches the letterform by whatever the slot's aspect happens to be - 2x
// flatter for a lead consonant over a horizontal vowel, 4x for a final. That
// turns jamo into bars and is why syllables with a final were unreadable.
//
// Read the slot's y as measuring downward. The slot table is written that way
// - lead 55, vowel 400, final 715 descending down the block - but placed
// components are in font coordinates, where y grows upward. Applied directly,
// every syllable came out vertically mirrored: finals on top, horizontal
// vowels above their lead.
function transform(d, { x, y, sx, sy }, preserve) {
  const box = pathBox(d);
  const w = Math.max(1, box.x1 - box.x0), h = Math.max(1, box.y1 - box.y0);
  const slotW = 1000 * sx, slotH = 1000 * sy;
  const fit = Math.min(slotW / w, slotH / h);
  // Hangul type does stretch a jamo to suit its position - a final is drawn
  // wider and flatter than the same shape used as a lead. So fitting strictly
  // uniformly leaves finals tiny: a squarish one fills a quarter of the width
  // of its slot, and 할 reads as 하. Let a component grow into the roomy
  // direction, but cap how far, well short of the 4x that turned finals into
  // lines.
  const MAX_STRETCH = 1.5;
  let kx, ky;
  if (preserve) {
    // The component already carries the size the hand gave it, so the slot only
    // says where it goes. Resizing it to fill the slot is exactly what flattened
    // every jamo to the same size no matter how it was written; shrink only if
    // it would not otherwise fit, and never stretch one axis against the other.
    const k = Math.min(1, slotW / w, slotH / h);
    kx = k; ky = k;
  } else {
    kx = Math.min(slotW / w, fit * MAX_STRETCH);
    ky = Math.min(slotH / h, fit * MAX_STRETCH);
  }
  const left = x + (slotW - w * kx) / 2;
  const top = y + (slotH - h * ky) / 2;
  const bottom = 1000 - top - h * ky;
  return svgpath(d)
    .scale(kx, ky)
    .translate(left - box.x0 * kx, bottom - box.y0 * ky)
    .round(1)
    .toString();
}

// A compound vowel is not a horizontal one. ㅘ is ㅗ under the lead plus ㅏ
// down the right side, so it needs the right and lower part of the block, not
// the full-width strip a plain ㅗ gets. Treated as horizontal it was scaled to
// the strip's height and came out as a small mark beside the consonant - 7 of
// the 21 vowels, which is a third of every syllable.
const COMPOUND_VOWELS = new Set([...'ㅘㅙㅚㅝㅞㅟㅢ']);

// Two jamo share the final's slot in a cluster like ㄺ or ㅄ, so each gets half
// the width and the pair traces to something too small to read. Give clusters a
// deeper slot; single finals keep the shallow one that already works.
const CLUSTER_FINALS = new Set([...'ㄳㄵㄶㄺㄻㄼㄽㄾㄿㅀㅄ']);

function slots(vowel, final) {
  // Vertical vowels (ㅏ, ㅓ, ㅣ ...) split a syllable left/right. Horizontal
  // vowels (ㅗ, ㅜ, ㅡ ...) split it top/bottom. A final consonant reserves the
  // lower part of the block. These are deliberately conservative slots so
  // freehand strokes do not collide as often as with a uniform 1/3 grid.
  const hasFinal = Boolean(final);
  const deep = CLUSTER_FINALS.has(final);
  const T = deep
    ? { x: 70, y: 655, sx: 0.86, sy: 0.29 }
    : { x: 95, y: 700, sx: 0.81, sy: 0.22 };
  if (COMPOUND_VOWELS.has(vowel)) {
    if (!hasFinal) return { L: { x: 60, y: 70, sx: 0.40, sy: 0.40 }, V: { x: 140, y: 130, sx: 0.82, sy: 0.76 } };
    return { L: { x: 60, y: 55, sx: 0.38, sy: 0.32 }, V: { x: 140, y: 110, sx: 0.82, sy: 0.52 }, T };
  }
  const vertical = VERTICAL_VOWELS.has(vowel);
  if (vertical && !hasFinal) return { L: { x: 65, y: 75, sx: 0.46, sy: 0.85 }, V: { x: 545, y: 75, sx: 0.39, sy: 0.85 } };
  if (vertical) return { L: { x: 65, y: 60, sx: 0.46, sy: 0.56 }, V: { x: 545, y: 60, sx: 0.39, sy: 0.56 }, T };
  if (!hasFinal) return { L: { x: 75, y: 60, sx: 0.85, sy: 0.43 }, V: { x: 75, y: 535, sx: 0.85, sy: 0.38 } };
  return { L: { x: 75, y: 55, sx: 0.85, sy: 0.29 }, V: { x: 75, y: 375, sx: 0.85, sy: 0.25 }, T };
}

function composeSyllable(parts, lead, vowel, final, { preserve = false, variations = null, composer = null, targetChar = '' } = {}) {
  const s = slots(vowel, final);
  const target = { lead, vowel, final, char: targetChar };
  const partFor = (role, char) => {
    const key = componentKey(role, char);
    const variant = selectVariation(variations, key, role, target);
    return { key, role, part: variant && variant.d ? variant.d : parts[key], variant, slot: s[role] };
  };
  const components = [partFor('L', lead), partFor('V', vowel)];
  if (final) components.push(partFor('T', final));
  // The correction hook works only on the already selected, manually colored
  // variants; the normal composer is kept byte-compatible when no hook is set.
  if (composer && !preserve) return composer(components, target);
  return fixWinding(components.map((c) => transform(c.part, c.slot, preserve)).join(' '));
}

// Every syllable the components on hand can spell.
//
// This used to refuse outright unless all 67 were present, which meant one
// absent ㄽ cost the writer all 11,172 characters. A photograph of ordinary
// writing is *always* short of something, so for the freeform flow that
// refusal is the normal case, not the edge case. Build what can be built; the
// caller says what is missing and which syllables would close the gap.
function appendHangulGlyph(glyphs, parts, opts, i) {
  const char = String.fromCodePoint(HANGUL_START + i);
  const { lead, vowel, final } = decomposeSyllable(HANGUL_START + i);
  if (!parts[componentKey('L', lead)] || !parts[componentKey('V', vowel)]) return;
  if (final && !parts[componentKey('T', final)]) return;
  glyphs.push({ char, d: composeSyllable(parts, lead, vowel, final, { ...opts, targetChar: char }), advance: 1000 });
}
function buildHangulGlyphs(parts, opts) {
  const glyphs = [];
  for (let i = 0; i < HANGUL_COUNT; i++) appendHangulGlyph(glyphs, parts, opts, i);
  return glyphs;
}
// Used only when worker startup is blocked and the main thread must build the
// font. Yield between short batches so ordinary interaction can still render.
async function buildHangulGlyphsCooperatively(parts, opts, yieldControl) {
  const glyphs = [];
  for (let i = 0; i < HANGUL_COUNT; i++) {
    appendHangulGlyph(glyphs, parts, opts, i);
    if ((i + 1) % 128 === 0) await yieldControl();
  }
  return glyphs;
}

// The letters people type on their own: ㅋㅋㅋ, ㅎㅎ, ㅠㅠ, ㅜㅜ, ㅇㅇ.
//
// These are the compatibility jamo, U+3131-U+3163, and they are not syllables -
// nothing above composes them. Without them a Hangul font is silently
// incomplete in the most everyday way there is: the browser lends another
// face for the laugh at the end of a sentence, and the writer sees a stranger's
// hand in the middle of their own without being told.
//
// The shapes are already here. A standalone consonant is written like a lead,
// so the lead form is preferred; the cluster finals (ㄳ ㄵ ㄶ …) only ever exist
// as finals and use those.
const COMPAT_FIRST = 0x3131;
const COMPAT_LAST = 0x3163;

// Alone in the em rather than squeezed into a syllable slot. A jamo is captured
// at whatever fraction of its syllable the hand gave it, which is right when it
// is going back into a syllable and much too small when it is the whole
// character - so fit it to the block, keeping its own proportions.
function placeAlone(d) {
  const box = pathBox(d);
  const w = Math.max(1, box.x1 - box.x0), h = Math.max(1, box.y1 - box.y0);
  const k = Math.min(620 / w, 720 / h);
  const x = (1000 - w * k) / 2, y = (1000 - h * k) / 2;
  return svgpath(d).scale(k, k).translate(x - box.x0 * k, y - box.y0 * k).round(1).toString();
}

function buildJamoGlyphs(parts, { renderJamo = null } = {}) {
  const vowels = new Set(VOWELS);
  const glyphs = [];
  for (let code = COMPAT_FIRST; code <= COMPAT_LAST; code++) {
    const char = String.fromCodePoint(code);
    const key = vowels.has(char) ? componentKey('V', char)
      : (parts[componentKey('L', char)] ? componentKey('L', char) : componentKey('T', char));
    const part = parts[key];
    const d = typeof part === 'string' ? part : (part && part.d);
    if (!d) continue;
    const base = placeAlone(d);
    glyphs.push({ char, d: renderJamo ? renderJamo({ char, key, part: d, base }) : base, advance: 1000 });
  }
  return glyphs;
}


module.exports = { LEADS, VOWELS, FINALS, HANGUL_START, HANGUL_COUNT, componentKey, requiredComponents, extraCharacters, decomposeSyllable, placeComponent, pathBox, slots, transform, composeSyllable, buildHangulGlyphs, buildHangulGlyphsCooperatively, buildJamoGlyphs };
