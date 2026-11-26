'use strict';
// Screen-only font pipeline. The pure capture/composer pieces are adapted from
// the MIT-licensed kor-your-font project; guided capture and context selection
// are experimental extensions.
const ImageTracer = require('imagetracerjs');
const { renderPixels, partsOf } = require('./screen-capture');
const { componentKey, requiredComponents, extraCharacters, placeComponent,
  buildHangulGlyphs, buildJamoGlyphs } = require('./hangul');
const { deriveComponents, missingSlots, suggestSyllables } = require('./derive');
const { placeGlyph } = require('./metrics');
const { buildTTF } = require('./assemble');
const { selectVariation } = require('./jamo-context');

const PAD = 8;
const TRACE_OPTIONS = {
  colorsampling: 0, colorquantcycles: 1, numberofcolors: 2,
  pal: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }],
  pathomit: 0, ltres: 1, qtres: 1, roundcoords: 1,
  strokewidth: 0, blurradius: 0, scale: 1,
};

// Preserve every black contour and the counters (holes) in handwritten ㅇ/ㅎ.
function traceGray(gray, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gray.length; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = gray[i];
    data[i * 4 + 3] = 255;
  }
  const svg = ImageTracer.imagedataToSVG({ width, height, data }, TRACE_OPTIONS);
  const ds = [];
  for (const m of svg.matchAll(/<path\b([^>]*)\/>/g)) {
    const attributes = m[1];
    if (!/fill="rgb\(0,0,0\)"/.test(attributes)) continue;
    const d = /\sd="([^"]+)"/.exec(attributes);
    if (d) ds.push(d[1]);
  }
  return ds.join(' ');
}
function tracePixels(pixels, size) {
  if (!pixels || !pixels.length) return null;
  const img = renderPixels(pixels, size, PAD);
  const d = traceGray(img.gray, img.cropSize.width, img.cropSize.height);
  return d ? { d, ...img } : null;
}
function maskPixels(value, size) {
  if (!value) return [];
  const ink = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (ink.length !== size * size) return [];
  const out = [];
  for (let i = 0; i < ink.length; i++) if (ink[i]) out.push(i);
  return out;
}

/**
 * Each stroke is tagged as L, V, T or X while the user writes. Consequently,
 * touching components do not need to be guessed apart or cut destructively.
 * @param {Array<{char:string,size:number,roles:Record<string,ArrayBuffer|Uint8Array>}>} samples
 */
async function buildScreenFont(samples, name = 'My Hand', progress = () => {}) {
  const required = new Set(requiredComponents().map((p) => p.key));
  const extras = new Set(extraCharacters().map((p) => p.char));
  const parts = {};
  const variations = {};
  const originals = {};
  const literals = {};
  const incomplete = [];
  let contextCount = 0;
  let reviewed = 0;

  for (const sample of samples) {
    const char = String(sample.char || '');
    const size = Number(sample.size);
    if ([...char].length !== 1 || !Number.isInteger(size) || size < 64 || size > 1024) continue;
    const parsed = partsOf(char);
    if (!parsed && !extras.has(char)) continue;
    progress(`글자를 분석하고 있어요 ${++reviewed}/${samples.length}`);
    const requested = parsed
      ? [['L', parsed.lead], ['V', parsed.vowel], ...(parsed.final ? [['T', parsed.final]] : [])]
      : [['X', char]];
    const groups = requested.map(([role, jamo]) => ({
      role, key: componentKey(role, jamo), pixels: maskPixels(sample.roles && sample.roles[role], size),
    }));
    const missingRoles = groups.filter((g) => !g.pixels.length).map((g) => g.role);
    if (missingRoles.length) incomplete.push(char);
    const combined = new Uint8Array(size * size);
    for (const g of groups) for (const p of g.pixels) combined[p] = 1;
    const all = [];
    for (let p = 0; p < combined.length; p++) if (combined[p]) all.push(p);
    const whole = tracePixels(all, size);
    if (!whole) continue;

    // Only a fully written sample is eligible to override a composed syllable.
    // The original whole form is retained even if some strokes cross.
    if (parsed && !missingRoles.length) {
      originals[char] = { char, d: placeComponent(whole.d, whole.cropSize, PAD, { inset: 90 }), advance: 1000 };
    } else if (!parsed && !missingRoles.length) {
      const placed = placeGlyph(whole.d, whole.cropSize, PAD, char);
      literals[char] = { char, d: placed.d, advance: placed.advance };
    }
    if (!parsed) continue;
    const sylW = whole.box.x1 - whole.box.x0 + 1;
    const sylH = whole.box.y1 - whole.box.y0 + 1;
    for (const group of groups) {
      if (!required.has(group.key) || !group.pixels.length) continue;
      const crop = tracePixels(group.pixels, size);
      if (!crop) continue;
      const share = Math.max(crop.box.x1 - crop.box.x0 + 1, crop.box.y1 - crop.box.y0 + 1)
        / Math.max(sylW, sylH);
      const d = placeComponent(crop.d, crop.cropSize, PAD, { share });
      if (!parts[group.key]) parts[group.key] = d;
      (variations[group.key] ||= []).push({ d, ...parsed, source: char });
      contextCount++;
    }
  }

  progress('빠진 자모 모양을 추정하고 있어요');
  const derivedCount = deriveComponents(parts).length;
  const missing = missingSlots(parts);
  const suggest = missing.length ? suggestSyllables(missing).syllables : [];
  progress('문맥에 맞는 자모를 골라 글자를 조합하고 있어요');
  // Build only combinations supported by actual or derivable components.
  const generated = buildHangulGlyphs(parts, { preserve: false, variations });
  // Expose which written syllable supplied each selected outline, so the UI
  // can explain its choices instead of presenting estimates as original ink.
  const sources = {};
  for (const glyph of generated) {
    if (originals[glyph.char]) continue;
    const target = partsOf(glyph.char);
    const picked = (role, ch) => selectVariation(variations, componentKey(role, ch), role, target)?.source || null;
    sources[glyph.char] = [picked('L', target.lead), picked('V', target.vowel), target.final ? picked('T', target.final) : null];
  }
  const glyphMap = new Map(generated.map((g) => [g.char, g]));
  for (const [char, glyph] of Object.entries(originals)) glyphMap.set(char, glyph);
  const hangulCount = glyphMap.size;
  for (const g of buildJamoGlyphs(parts)) glyphMap.set(g.char, g);
  for (const [char, glyph] of Object.entries(literals)) glyphMap.set(char, glyph);
  if (!glyphMap.size) throw new Error('유효한 획을 찾지 못했어요. 테두리 안에 글자를 크게 써 주세요.');
  progress('TTF 폰트 파일을 만들고 있어요');
  const glyphs = [...glyphMap.values()];
  const ttf = buildTTF(String(name || 'My Hand').slice(0, 40), glyphs, { wordSpace: 500 });
  return {
    ttf: new Uint8Array(ttf),
    glyphCount: glyphs.length,
    hangulCount,
    originalCount: Object.keys(originals).length,
    originalChars: Object.keys(originals).join(''),
    extraCount: Object.keys(literals).length,
    contextCount,
    derivedCount,
    incomplete: [...new Set(incomplete)],
    missing,
    suggest,
    sources,
    chars: glyphs.map((g) => g.char).join('') + ' ',
  };
}
module.exports = { buildScreenFont, traceGray, tracePixels };
