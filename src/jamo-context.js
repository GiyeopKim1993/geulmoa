'use strict';
// Context-aware selection is an experimental extension to kor-your-font.
// These groups are design heuristics, not normative Hangul rules. All variants
// are real samples of the SAME role and jamo. The generator falls back to the
// closest captured variant, then to the base/derived outline if none was seen.

const VERTICAL = new Set([...'ㅏㅐㅑㅒㅓㅔㅕㅖㅣ']);
const MIXED = new Set([...'ㅘㅙㅚㅝㅞㅟㅢ']);
const CLUSTERS = new Set([...'ㄳㄵㄶㄺㄻㄼㄽㄾㄿㅀㅄ']);

function vowelLayout(v) {
  return MIXED.has(v) ? 'mixed' : VERTICAL.has(v) ? 'vertical' : 'horizontal';
}
function vowelFamily(v) {
  if ('ㅏㅑ'.includes(v)) return 'vertical-right';
  if ('ㅐㅒ'.includes(v)) return 'vertical-right-wide';
  if ('ㅓㅕ'.includes(v)) return 'vertical-left';
  if ('ㅔㅖ'.includes(v)) return 'vertical-left-wide';
  if (v === 'ㅣ') return 'vertical-straight';
  if ('ㅗㅛ'.includes(v)) return 'horizontal-up';
  if ('ㅜㅠ'.includes(v)) return 'horizontal-down';
  if (v === 'ㅡ') return 'horizontal-flat';
  if ('ㅘㅙㅚ'.includes(v)) return 'mixed-up';
  if ('ㅝㅞㅟ'.includes(v)) return 'mixed-down';
  return 'mixed-flat'; // ㅢ
}
function finalShape(t) {
  if (!t) return 'none';
  if (CLUSTERS.has(t)) return 'cluster';
  if ('ㅇㅁ'.includes(t)) return 'enclosed';
  return 'single';
}
function leadGroup(l) {
  // A traditional broad distinction for the space left beside a vowel.
  return 'ㄱㅋ'.includes(l) ? 'open-corner' : 'other';
}

function scoreVariation(role, sample, target) {
  const sameFinalPresence = Boolean(sample.final) === Boolean(target.final);
  const sameFinal = sample.final === target.final;
  const sameFinalShape = finalShape(sample.final) === finalShape(target.final);
  const sameVowel = sample.vowel === target.vowel;
  const sameFamily = vowelFamily(sample.vowel) === vowelFamily(target.vowel);
  const sameLayout = vowelLayout(sample.vowel) === vowelLayout(target.vowel);
  const sameLead = sample.lead === target.lead;
  const sameLeadGroup = leadGroup(sample.lead) === leadGroup(target.lead);
  if (role === 'L') {
    // Avoid taking a no-final form for a final-bearing syllable if a matching
    // class exists. Exact final and directional vowel shape then break ties.
    return (sameFinalPresence ? 64 : 0)
      + (sameVowel ? 32 : sameFamily ? 24 : sameLayout ? 16 : 0)
      + (sameFinal ? 12 : sameFinalShape ? 6 : 0);
  }
  if (role === 'V') {
    return (sameFinalPresence ? 64 : 0)
      + (sameLead ? 28 : sameLeadGroup ? 12 : 0)
      + (sameFinal ? 8 : sameFinalShape ? 4 : 0);
  }
  // Finals are especially sensitive to the vowel's geometry.
  return (sameVowel ? 64 : sameFamily ? 48 : sameLayout ? 32 : 0)
    + (sameLead ? 8 : sameLeadGroup ? 4 : 0);
}

function selectVariation(variations, key, role, target) {
  const candidates = variations && variations[key];
  if (!candidates || !candidates.length) return null;
  let best = candidates[0];
  let score = scoreVariation(role, best, target);
  for (let i = 1; i < candidates.length; i++) {
    const next = scoreVariation(role, candidates[i], target);
    if (next > score) { best = candidates[i]; score = next; }
  }
  return best;
}
module.exports = { vowelLayout, vowelFamily, finalShape, leadGroup, scoreVariation, selectVariation };
