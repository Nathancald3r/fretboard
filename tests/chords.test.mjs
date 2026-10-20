// Run: node tests/chords.test.mjs
import assert from 'node:assert/strict';
import { detectChord, chordName, guessChords } from '../js/chords.js';

const notes = (...midis) => midis.map((midi) => ({ midi, weight: 1 }));
const name = (n, flats) => { const c = detectChord(n); return c && chordName(c, flats); };

assert.equal(name(notes(45, 52, 57, 60, 64)), 'Am'); // open Am shape
assert.equal(name(notes(43, 47, 50, 55, 59, 67)), 'G'); // open G
assert.equal(name(notes(40, 47, 52)), 'E5'); // power chord
assert.equal(name(notes(38, 45, 50, 54, 60)), 'D7'); // D7 with A in the bass is still D7/A
assert.equal(name(notes(48, 52, 55, 59)), 'Cmaj7');
assert.equal(name(notes(40, 48, 52, 55)), 'C/E'); // first inversion
assert.equal(name(notes(46, 53, 58, 62), true), 'Bb'); // flats in flat keys
assert.equal(name(notes(50, 55, 57)), 'Dsus4');
// Single notes and scale runs are not chords.
assert.equal(detectChord(notes(57)), null);
assert.equal(detectChord(notes(57, 60, 62, 64, 67, 69, 72, 74)), null);
assert.equal(detectChord([]), null);

// A tiny fake score: 2 bars of 4/4, bar 1 = C, bar 2 = first half G, second half Am.
const beat = (start, dur, ...midis) => ({ playbackStart: start, playbackDuration: dur, isRest: false, notes: midis.map((m) => ({ realValue: m })) });
const score = {
  masterBars: [0, 1].map(() => ({ timeSignatureNumerator: 4, keySignature: 0, calculateDuration: () => 3840 })),
  tracks: [{
    staves: [{
      isPercussion: false,
      bars: [
        { voices: [{ beats: [beat(0, 3840, 48, 52, 55, 60)] }] },
        { voices: [{ beats: [beat(0, 1920, 43, 47, 50, 55), beat(1920, 1920, 45, 52, 57, 60)] }] },
      ],
    }],
  }, { staves: [{ isPercussion: true, bars: [{ voices: [{ beats: [beat(0, 3840, 30, 31, 35)] }] }] }] }],
};
const g = guessChords(score);
assert.deepEqual(g.map((b) => b.all.map((c) => `${c.offset}:${c.name}`)), [['0:C'], ['0:G', '1920:Am']]);

console.log('chords tests passed');
