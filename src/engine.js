'use strict';
// Screen-only font pipeline. The pure capture/composer pieces are adapted from
// the MIT-licensed kor-your-font project; guided capture and context selection
// are experimental extensions.
const ImageTracer = require('imagetracerjs');
const { renderPixels, partsOf } = require('./screen-capture');
const { componentKey, requiredComponents, extraCharacters, placeComponent,
  buildHangulGlyphs, buildHangulGlyphsCooperatively, buildJamoGlyphs } = require('./hangul');
const { deriveComponents, missingSlots, suggestSyllables } = require('./derive');
const { placeGlyph } = require('./metrics');
const { buildTTF } = require('./assemble');
const { selectVariation } = require('./jamo-context');
const { applyFontDesign } = require('./font-design');
const { VectorCorrection } = require('./vector-correction');
const { frameFor } = require('./vector-strokes');

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
 * The user writes whole syllables, then manually paints pixels as L, V or T.
 * @param {Array<{char:string,size:number,roles:Record<string,ArrayBuffer|Uint8Array>}>} samples
 */
async function buildScreenFont(samples, name = 'My Hand', progress = () => {}, options = {}) {
  const yieldControl = options.cooperative ? () => new Promise((resolve) => setTimeout(resolve, 0)) : null;
  if (yieldControl) await yieldControl();
  const required = new Set(requiredComponents().map((p) => p.key));
  const extras = new Set(extraCharacters().map((p) => p.char));
  const parts = {};
  const variations = {};
  const originals = {};
  const originalSources = {};
  const literals = {};
  const incomplete = [];
  const correction = new VectorCorrection({ enabled: options.vectorCorrection !== false, traceGray });
  let contextCount = 0;
  let reviewed = 0;

  for (const sample of samples) {
    const char = String(sample.char || '');
    const size = Number(sample.size);
    if ([...char].length !== 1 || !Number.isInteger(size) || size < 64 || size > 1024) continue;
    const parsed = partsOf(char);
    if (!parsed && !extras.has(char)) continue;
    progress(`글자를 분석하고 있어요 ${++reviewed}/${samples.length}`);
    if (yieldControl) await yieldControl();
    const requested = parsed
      ? [['L', parsed.lead], ['V', parsed.vowel], ...(parsed.final ? [['T', parsed.final]] : [])]
      : [['X', char]];
    const masks = {};
    const groups = requested.map(([role, jamo]) => {
      const value = sample.roles && sample.roles[role];
      const mask = value instanceof Uint8Array ? value : value ? new Uint8Array(value) : new Uint8Array(0);
      masks[role] = mask;
      return { role, key: componentKey(role, jamo), pixels: maskPixels(mask, size) };
    });
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
    let vectorSource = null;
    if (parsed && !missingRoles.length) {
      originals[char] = { char, d: placeComponent(whole.d, whole.cropSize, PAD, { inset: 90 }), advance: 1000 };
      vectorSource = correction.prepare({ strokes: sample.strokes, masks, union: combined, size,
        roles: requested.map(([role]) => role), wholeBox: whole.box });
      originalSources[char] = vectorSource;
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
      (variations[group.key] ||= []).push({ d, ...parsed, source: char,
        frame: frameFor(crop.box, { share }), size, fit: vectorSource?.wholeUsable ? (vectorSource.fits?.[group.role] || null) : null,
        sourceReason: vectorSource?.reason || (vectorSource ? '' : '완성된 획 경로가 없음') });
      contextCount++;
    }
  }

  progress('빠진 자모 모양을 추정하고 있어요');
  const derivedCount = deriveComponents(parts).length;
  const missing = missingSlots(parts);
  const suggest = missing.length ? suggestSyllables(missing).syllables : [];
  correction.setTarget(Object.values(originalSources));
  const counts = () => ({ total: 0, adjusted: 0, partial: 0, kept: 0, same: 0, off: 0 });
  const strokeCorrection = { enabled: correction.enabled, available: correction.available,
    target: correction.target, referenceCount: correction.targetSamples || 0,
    original: counts(), composed: counts(), jamo: counts(), reasons: {}, byChar: {}, extrasKept: Object.keys(literals).length };
  function record(kind, char, info, withDetail = true) {
    const status = info.status, reasons = info.reasons || (info.reason ? [info.reason] : []);
    const group = strokeCorrection[kind]; group.total++; group[status]++;
    for (const reason of new Set(reasons)) strokeCorrection.reasons[reason] = (strokeCorrection.reasons[reason] || 0) + 1;
    if (withDetail) strokeCorrection.byChar[char] = { status, reasons };
  }
  progress('크기를 맞춘 획의 굵기를 확인하고 있어요');
  if (yieldControl) await yieldControl();
  for (const [char, glyph] of Object.entries(originals)) {
    const adjusted = correction.original(glyph.d, originalSources[char]);
    glyph.d = adjusted.d; record('original', char, adjusted);
    if (yieldControl) await yieldControl();
  }
  const canComposeVectors = correction.enabled && correction.available && correction.target > 0;
  const defaultInfo = correction.enabled
    ? { status: 'kept', reasons: [correction.available ? '기준 획 굵기를 정할 수 없음' : '이 브라우저에서 경로 보정을 사용할 수 없음'] }
    : { status: 'off', reasons: [] };
  const opts = { preserve: false, variations };
  if (canComposeVectors) opts.composer = (components, target) => {
    // A fully handwritten syllable always wins over a composition.
    if (originals[target.char]) return originals[target.char].d;
    const adjusted = correction.compose(components);
    record('composed', target.char, adjusted);
    return adjusted.d;
  };
  progress('문맥에 맞는 자모를 골라 글자를 조합하고 있어요');
  // Build only combinations supported by actual or derivable components.
  const generated = yieldControl
    ? await buildHangulGlyphsCooperatively(parts, opts, yieldControl)
    : buildHangulGlyphs(parts, opts);
  // Expose which written syllable supplied each selected outline, so the UI
  // can explain its choices instead of presenting estimates as original ink.
  const sources = {};
  let explained = 0;
  for (const glyph of generated) {
    if (yieldControl && ++explained % 256 === 0) await yieldControl();
    if (originals[glyph.char]) continue;
    if (!canComposeVectors) record('composed', glyph.char, defaultInfo);
    const target = partsOf(glyph.char);
    const picked = (role, ch) => selectVariation(variations, componentKey(role, ch), role, target)?.source || null;
    sources[glyph.char] = [picked('L', target.lead), picked('V', target.vowel), target.final ? picked('T', target.final) : null];
  }
  const glyphMap = new Map(generated.map((g) => [g.char, g]));
  for (const [char, glyph] of Object.entries(originals)) glyphMap.set(char, glyph);
  const hangulCount = glyphMap.size;
  const jamoOptions = canComposeVectors ? { renderJamo: ({ char, key, part, base }) => {
    const adjusted = correction.component({ key, part, variant: variations[key]?.[0] || null, alone: true, baseAlone: base });
    record('jamo', char, adjusted, false); return adjusted.d;
  } } : {};
  const jamoGlyphs = buildJamoGlyphs(parts, jamoOptions);
  if (!canComposeVectors) for (const glyph of jamoGlyphs) record('jamo', glyph.char, defaultInfo, false);
  for (const g of jamoGlyphs) glyphMap.set(g.char, g);
  for (const [char, glyph] of Object.entries(literals)) glyphMap.set(char, glyph);
  if (!glyphMap.size) throw new Error('유효한 획을 찾지 못했어요. 테두리 안에 글자를 크게 써 주세요.');
  progress('글자 간격과 높이를 맞추고 있어요');
  if (yieldControl) await yieldControl();
  const fitted = applyFontDesign([...glyphMap.values()], options);
  const glyphs = fitted.glyphs;
  progress('TTF 폰트 파일을 만들고 있어요');
  if (yieldControl) await yieldControl(); // the final binary encoder is synchronous
  const ttf = buildTTF(String(name || 'My Hand').slice(0, 40), glyphs,
    { wordSpace: fitted.wordSpace, ascent: fitted.ascent, descent: fitted.descent, xHeight: fitted.xHeight, capHeight: fitted.capHeight });
  return {
    design: fitted.design, spacingClamped: fitted.spacingClamped,
    fontAscent: fitted.ascent, fontDescent: fitted.descent,
    ttf: new Uint8Array(ttf),
    glyphCount: glyphs.length,
    hangulCount,
    originalCount: Object.keys(originals).length,
    originalChars: Object.keys(originals).join(''),
    extraCount: Object.keys(literals).length,
    contextCount,
    derivedCount,
    strokeCorrection,
    incomplete: [...new Set(incomplete)],
    missing,
    suggest,
    sources,
    chars: glyphs.map((g) => g.char).join('') + ' ',
  };
}
module.exports = { buildScreenFont, traceGray, tracePixels };
