// Checks that rhythm read from a Tab Pro staff turns into alphaTex that alphaTab accepts.
// Run: node tests/ugtab.test.mjs
import assert from 'node:assert/strict';
import * as alphaTab from '@coderline/alphatab';
import { ugToAlphaTex } from '../js/ugtab.js';

const col = (cx, len, ...notes) => ({ cx, len, beamed: len < 4, notes: notes.map(([s, t]) => ({ s, t })) });
const bar = (x0, x1, cols) => ({ x0, x1, cols });
const eighths = (x0) => [0, 1, 2, 3, 4, 5].map((i) => col(x0 + 30 + i * 32, 2, [2, String(7 + i)]));

const strips = [
  { heading: true, bars: [{ ...bar(0, 220, eighths(0)), heading: true }, bar(220, 440, eighths(220)), bar(440, 660, eighths(440))] },
  {
    heading: true,
    bars: [
      { ...bar(0, 220, [col(30, 6, [2, '10'], [1, '11']), col(130, 3, [0, 'X'])]), heading: true }, // dotted quarter, then a dotted eighth: the last note rings on
      bar(220, 440, []), // nothing played
      bar(440, 660, eighths(440)),
    ],
  },
];

const made = ugToAlphaTex(strips, { title: 'Test', artist: 'Me', tempo: 72 });
assert.ok(made, 'a bar length is found');
assert.equal(made.bars, 6);
assert.match(made.tex, /\\ts 6 8/);
assert.equal((made.tex.match(/\\section/g) || []).length, 2);

const importer = new alphaTab.importer.AlphaTexImporter();
importer.initFromString(made.tex, new alphaTab.Settings());
const score = importer.readScore();
assert.equal(score.masterBars.length, 6);
const bars = score.tracks[0].staves[0].bars;
assert.equal(bars[0].voices[0].beats.length, 6);
assert.equal(bars[3].voices[0].beats[0].notes.length, 2); // the chord
assert.ok(bars[4].voices[0].beats[0].isRest, 'an empty bar is a rest');
const length = (b) => b.voices[0].beats.reduce((a, x) => a + x.playbackDuration, 0);
assert.ok(bars.every((b) => length(b) === length(bars[0])), 'every bar is the same length');
console.log('ugtab ok');
