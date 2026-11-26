'use strict';
const svgpath = require('svgpath');
const { pathBox } = require('./hangul');
const { ASCENT, DESCENT, XH, CAP } = require('./metrics');

function number(value, fallback, min, max) {
  const x = Number(value); return Math.round(Math.max(min, Math.min(max, Number.isFinite(x) ? x : fallback)));
}
function normalizeDesign(raw = {}) {
  return {
    letterSpacing: number(raw.letterSpacing, 0, -100, 200),
    wordSpace: number(raw.wordSpace, 500, 200, 1000),
    verticalOffset: number(raw.verticalOffset, 0, -100, 100),
  };
}
// Apply layout into TTF glyph advances and outlines (not just CSS). Spacing is
// split between the left and right so Hangul stays centered in its em cell.
function applyFontDesign(glyphs, raw) {
  const design = normalizeDesign(raw);
  const out = [], track = design.letterSpacing, up = design.verticalOffset;
  let maxY = -Infinity, minY = Infinity, spacingClamped = 0;
  for (const glyph of glyphs) {
    const advance = Math.max(100, Math.round(glyph.advance + track));
    const actualDelta = advance - glyph.advance;
    if (actualDelta !== track) spacingClamped++;
    const dx = actualDelta / 2;
    const d = glyph.d && (dx || up) ? svgpath(glyph.d).translate(dx, up).round(1).toString() : glyph.d;
    out.push({ ...glyph, d, advance });
    if (up && d) {
      const b = pathBox(d); maxY = Math.max(maxY, b.y1); minY = Math.min(minY, b.y0);
    }
  }
  // Expand line metrics only if necessary to keep translated ink inside them.
  // This can slightly change line spacing, which the UI explains.
  const ascent = Math.max(ASCENT, Number.isFinite(maxY) ? Math.ceil(maxY) : ASCENT);
  const descent = Math.min(DESCENT, Number.isFinite(minY) ? Math.floor(minY) : DESCENT);
  // Cap and x-height references also move with the global baseline offset.
  return { glyphs: out, wordSpace: design.wordSpace, ascent, descent,
    xHeight: XH + up, capHeight: CAP + up, design, spacingClamped };
}
module.exports = { normalizeDesign, applyFontDesign };
