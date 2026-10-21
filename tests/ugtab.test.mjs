// Checks that rhythm read from a Tab Pro staff turns into alphaTex that alphaTab accepts.
// Run: node tests/ugtab.test.mjs
import assert from 'node:assert/strict';
import * as alphaTab from '@coderline/alphatab';
import { ugToAlphaTex, parseTuning } from '../js/ugtab.js';

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

// lyrics ride on a rests-only track and come out in order, split at the hyphens
import { lyricsTrack, buildLyrics } from '../js/lyrics.js';
const sung = strips.map((s, i) => (i ? s : { ...s, lyr: [{ x: 40, x1: 60, text: 'Hel-' }, { x: 90, x1: 120, text: 'lo' }, { x: 300, x1: 330, text: 'my' }, { x: 500, x1: 540, text: "friend's" }] }));
const withWords = ugToAlphaTex(sung, { title: 'Test', artist: 'Me', tempo: 72 });
assert.equal(withWords.lyrics, true);
const imp2 = new alphaTab.importer.AlphaTexImporter();
imp2.initFromString(withWords.tex, new alphaTab.Settings());
const sc2 = imp2.readScore();
assert.equal(sc2.tracks.length, 2);
const vt = lyricsTrack(sc2);
assert.equal(vt, 1);
const lines = buildLyrics(sc2, vt, sc2.masterBars.map((mb, i) => ({ start: mb.start, masterIndex: mb.index })));
assert.equal(lines.flatMap((l) => l.words.map((w) => w.text + (w.joined ? '-' : ''))).join(' '), "Hel- lo my friend's");
const total = (b) => b.voices[0].beats.reduce((a, x) => a + x.playbackDuration, 0);
assert.ok(sc2.tracks[1].staves[0].bars.every((b) => total(b) === total(bars[0])), 'lyric bars are as long as the tab bars');

// another instrument's PDF becomes a track of its own, as long as the first
const multi = ugToAlphaTex(strips, { title: 'Test', tempo: 72, name: 'Lead Guitar', program: 29, extra: [{ name: 'Rhythm Guitar', program: 26, strips: [strips[0]] }] });
const imp3 = new alphaTab.importer.AlphaTexImporter();
imp3.initFromString(multi.tex, new alphaTab.Settings());
const sc3 = imp3.readScore();
assert.deepEqual(sc3.tracks.map((t) => t.name), ['Lead Guitar', 'Rhythm Guitar']);
assert.equal(sc3.tracks[1].staves[0].bars.length, 6, 'a shorter part is padded with rests');
// a misread line with more notes than the bar has beats (a notation part read as tab) must not hang
const crowded = [{ bars: [bar(0, 220, eighths(0)), bar(220, 440, eighths(220)), bar(440, 660, Array.from({ length: 30 }, (_, i) => col(450 + i * 6, 1, [0, '3'])))] }];
const over = ugToAlphaTex(crowded, {});
assert.ok(over && over.bars === 3, 'a bar with too many notes is cut to fit');
console.log('ugtab ok');

// the tuning printed under the title, lowest string first
assert.deepEqual(parseTuning('Tuning: E A D G B E'), [40, 45, 50, 55, 59, 64]);
assert.deepEqual(parseTuning('Tuning: E ♭ A♭ D♭ G♭ B♭ E♭'), [39, 44, 49, 54, 58, 63]);
assert.deepEqual(parseTuning('Tuning: D A D G'), [26, 33, 38, 43]);
assert.deepEqual(parseTuning('Tuning: B E A D G'), [23, 28, 33, 38, 43]);
assert.equal(parseTuning('Tuning: C C C C C C'), null, 'drum parts');

// a four-string bass part with a drop-D tuning
{
  const bass = [{ strings: 4, tuning: [26, 33, 38, 43], bars: [bar(0, 220, [0, 1, 2, 3].map((i) => col(30 + i * 50, 4, [3, String(i)])))] }];
  const m = ugToAlphaTex(bass, { title: 'Bass', program: 33 });
  assert.ok(m.tex.includes("tuning G2 D2 A1 D1"));
  const im = new alphaTab.importer.AlphaTexImporter();
  im.initFromString(m.tex, new alphaTab.Settings());
  const sc = im.readScore();
  assert.equal(sc.tracks[0].staves[0].tuning.length, 4);
  assert.equal(sc.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].realValue, 26, 'open low string is D1');
}
console.log('ugtab tuning ok');
