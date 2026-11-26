'use strict';
// Placed glyphs -> font binaries. We author the SVG-font XML ourselves so
// glyph placement and metrics are exactly what metrics.js computed -
// no icon-font "normalize" scaling anywhere in the chain.
// Local MIT-licensed svg2ttf patch supports a separate ASCII PostScript name.
const svg2ttf = require('../vendor/svg2ttf');
const { UPM, ASCENT, DESCENT, XH, CAP } = require('./metrics');

const esc = (ch) => '&#x' + ch.codePointAt(0).toString(16).toUpperCase() + ';';
const escAttr = (s) => s.replace(/[&<>"']/g, (c) => `&#x${c.codePointAt(0).toString(16).toUpperCase()};`);

/**
 * @param {string} name font family name
 * @param {Array<{char:string,d:string,advance:number}>} glyphs
 * @param {{wordSpace?:number,ascent?:number,descent?:number,xHeight?:number,capHeight?:number}} opts
 * @returns {Buffer} TTF
 */
function buildTTF(name, glyphs, { wordSpace = 300, ascent = ASCENT, descent = DESCENT, xHeight = XH, capHeight = CAP } = {}) {
  // Keep a stable ASCII PostScript ID even for a Korean-only family name.
  // Different Korean names must not all collapse to the same DrawYourFont ID.
  let hash = 2166136261;
  for (const ch of name) { hash ^= ch.codePointAt(0); hash = Math.imul(hash, 16777619); }
  const stem = name.replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 30) || 'Geulmoa';
  const id = `${stem}-${(hash >>> 0).toString(16)}`;
  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><defs>`,
    `<font id="${id}" horiz-adv-x="${wordSpace}">`,
    `<font-face font-family="${escAttr(name)}" units-per-em="${UPM}" ascent="${ascent}" descent="${descent}" x-height="${xHeight}" cap-height="${capHeight}"/>`,
    `<missing-glyph horiz-adv-x="${Math.round(UPM / 2)}"/>`,
    `<glyph glyph-name="space" unicode="${esc(' ')}" horiz-adv-x="${wordSpace}" d=""/>`,
  ];
  for (const g of glyphs) {
    if (g.char === ' ') continue;
    const gname = 'uni' + g.char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    parts.push(`<glyph glyph-name="${gname}" unicode="${esc(g.char)}" horiz-adv-x="${g.advance}" d="${g.d}"/>`);
  }
  parts.push(`</font></defs></svg>`);
  const ttf = svg2ttf(parts.join('\n'), { fullname: name, postscriptname: id,
    description: 'Made with Geulmoa, based on kor-your-font', url: 'https://github.com/maxi08aidot/kor-your-font' });
  return Buffer.from(ttf.buffer);
}


module.exports = { buildTTF };
