// Run: node tests/transpose.test.mjs
import assert from 'node:assert/strict';
import { shiftChordName, shiftKeySignature, transposeScore } from '../js/transpose.js';

assert.equal(shiftChordName('G', 2), 'A');
assert.equal(shiftChordName('G/B', 2), 'A/C#');
assert.equal(shiftChordName('Em7', -2, true), 'Dm7');
assert.equal(shiftChordName('C', -1, true), 'B');
assert.equal(shiftChordName('Bbmaj7', 1), 'Bmaj7');
assert.equal(shiftChordName('N.C.', 3), 'N.C.');
assert.equal(shiftChordName('A', 0), 'A');

assert.equal(shiftKeySignature(1, 2), 3); // G → A
assert.equal(shiftKeySignature(0, 5), -1); // C → F
assert.equal(shiftKeySignature(-2, 2), 0); // Bb → C
assert.equal(shiftKeySignature(0, -2), -2); // C → Bb
assert.equal(shiftKeySignature(3, 0), 3);

const alphaTab = await import('@coderline/alphatab');
const load = (tex) => {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, new alphaTab.Settings());
  return importer.readScore();
};
const pitches = (score, t = 0) => score.tracks[t].staves[0].bars.flatMap((b) => b.voices[0].beats.flatMap((bt) => bt.notes.map((n) => n.realValue)));
const frets = (score) => score.tracks[0].staves[0].bars.flatMap((b) => b.voices[0].beats.map((bt) => bt.notes.map((n) => `${n.fret}.${n.string}`).join(' ')));

// Open G chord, a riff with open strings, and a high note.
const tex = `\\title "t" \\ks G .
\\track "Guitar" \\staff {tabs}
(3.6 2.5 0.4 0.3 0.2 3.1).4 0.6.4 2.5.4 22.1.4 |
\\track "Voice" \\instrument 53 \\staff {score}
G4.4 A4.4 B4.4 C5.4`;

// A song in A (G shapes two frets up): capo 2 keeps every pitch and turns it into open G shapes.
let score = load(`\\title "a" \\ks A .
\\track "Guitar" \\staff {tabs}
(5.6 4.5 2.4 2.3 2.2 5.1).4 2.6.4 4.5.4 7.1.4 |`);
const before = pitches(score);
transposeScore(score, { capo: 2, capoTrack: 0 });
assert.deepEqual(pitches(score), before, 'capo keeps pitches');
assert.equal(score.tracks[0].staves[0].capo, 2);
assert.deepEqual(frets(score), ['3.1 2.2 0.3 0.4 0.5 3.6', '0.1', '2.2', '5.6']);

// Notes below the capo can't keep their pitch: the open low E goes up an octave.
score = load(tex);
const open = pitches(score);
transposeScore(score, { capo: 2, capoTrack: 0 });
assert.equal(score.tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0].realValue, open[6] + 12);
assert.ok(frets(score).every((beat) => beat.split(' ').every((n) => Number(n.split('.')[0]) >= 0)), 'no negative frets');

// Transpose +2: every note 2 semitones up, key G → A.
score = load(tex);
const g = pitches(score);
const v = pitches(score, 1);
transposeScore(score, { semitones: 2 });
assert.deepEqual(pitches(score), g.map((p) => p + 2));
assert.deepEqual(pitches(score, 1), v.map((p) => p + 2));
assert.equal(score.tracks[0].staves[0].bars[0].keySignature, 3);

// Transpose −3: open strings can't go down on the same string; they move to lower strings or an octave.
score = load(tex);
transposeScore(score, { semitones: -3 });
const low = pitches(score);
for (let i = 0; i < g.length; i++) assert.ok(low[i] === g[i] - 3 || low[i] === g[i] + 9, `note ${i}: ${g[i]} → ${low[i]}`);
// A chord keeps one note per string.
for (const beat of score.tracks[0].staves[0].bars[0].voices[0].beats) {
  const strings = beat.notes.map((n) => n.string);
  assert.equal(new Set(strings).size, strings.length);
}

// Transpose and capo together: the pitch moves by the transpose only.
score = load(tex);
transposeScore(score, { semitones: 1, capo: 1, capoTrack: 0 });
assert.deepEqual(pitches(score), g.map((p) => p + 1));
assert.equal(frets(score)[0], frets(load(tex))[0], 'up 1 with capo 1 = same shapes');

console.log('transpose: all tests passed');
