// Run: node tests/uglyrics.test.mjs
import assert from 'node:assert/strict';
import { syllables } from '../js/uglyrics.js';

// A Tesseract word: each character gets a 20px-wide box, words placed left to right.
let x = 0;
const word = (text, confidence = 90) => {
  const symbols = [...text].map((c) => { const s = { text: c, bbox: { x0: x, x1: x + 18, y0: 35, y1: 90 } }; x += 20; return s; });
  const w = { text, confidence, bbox: { x0: symbols[0].bbox.x0, x1: x, y0: 35, y1: 90 }, symbols };
  x += 60;
  return w;
};
const line = (...ws) => { x = 0; return syllables(ws).map((s) => s.text).join(' '); };

// Lone hyphens between syllables join them; a single letter starting a word stays ("E-very").
assert.equal(line(word('Un-de-fe'), word('-', 73), word('a-ted'), word('E-very'), word('ba'), word('—', 50), word('t-tle', 45)),
  'Un- de- fe- a- ted E- very ba- t- tle');
// Unsure but word-like syllables are kept; long dashes split them.
assert.equal(line(word('vic—-to—-ry', 28), word('You'), word('are'), word('my')), 'vic- to- ry You are my');
// "I" misread as "1" or "[I"; a stray capital in front of a word.
assert.equal(line(word('When'), word('1'), word('lift'), word('my'), word('[I', 68), word('have'), word('KE-very', 50)),
  'When I lift my I have E- very');
// "O" read as a zero ("dark-ness O-pened").
assert.equal(line(word('dark'), word('-ness'), word('0', 63), word('-', 70), word('pened'), word('my')), 'dark- ness O- pened my');
// A strip without lyrics (bar numbers, beams, staff bits) gives nothing.
assert.equal(line(word('5', 56), word('LF]', 28), word('1', 87), word('|', 44), word('28', 84), word('xT', 91), word('1', 34),
  word('i1', 62), word('A', 84), word('hl', 32), word('a1', 26), word('i', 91), word('1', 96), word('xT', 90), word('a', 64)), '');

console.log('uglyrics tests passed');
