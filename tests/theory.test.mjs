// Run: node tests/theory.test.mjs
import assert from 'node:assert/strict';
import { detectKey, toNashville, toRoman, keyLabel, scalePosition, SCALES, sequence, pitchClass } from '../js/theory.js';

const frets = (pos) => pos.notes.map((n) => `${n.string}:${n.fret}`).join(' ');

// A minor pentatonic box 1 at the 5th fret.
assert.equal(frets(scalePosition(9, SCALES['Minor pentatonic'], 0)), '0:5 0:8 1:5 1:7 2:5 2:7 3:5 3:7 4:5 4:8 5:5 5:8');
// G major, position starting on the root at fret 3: three notes per string except the B string.
const g = scalePosition(7, SCALES['Major (Ionian)'], 0);
assert.equal(frets(g), '0:3 0:5 0:7 1:3 1:5 1:7 2:4 2:5 2:7 3:4 3:5 3:7 4:5 4:7 5:3 5:5 5:7');
assert.ok(g.notes.every((n, i) => !i || n.midi > g.notes[i - 1].midi), 'ascending');
// Every position of every scale climbs without gaps in the scale.
for (const [name, iv] of Object.entries(SCALES)) {
  for (let p = 0; p < iv.length; p++) {
    const { notes } = scalePosition(0, iv, p);
    assert.ok(notes.length >= iv.length * 2, `${name} pos ${p + 1} too short`);
    for (let i = 1; i < notes.length; i++) {
      const between = [];
      for (let m = notes[i - 1].midi + 1; m < notes[i].midi; m++) if (iv.includes(m % 12)) between.push(m);
      assert.equal(between.length, 0, `${name} pos ${p + 1} skips a note`);
    }
  }
}

assert.equal(keyLabel(detectKey(['G', 'C', 'D', 'Em', 'G'])), 'G');
assert.equal(keyLabel(detectKey(['Am', 'F', 'C', 'G', 'Am'])), 'Am');
assert.equal(keyLabel(detectKey(['Am', 'G', 'F', 'E', 'Am'])), 'Am');
assert.equal(keyLabel(detectKey(['Bb', 'Eb', 'F', 'Gm'])), 'Bb');
const G = { tonic: 7, minor: false };
assert.equal(toNashville('Em7/B', G), '6m7/3');
assert.equal(toNashville('Cmaj7', G), '4maj7');
assert.equal(toNashville('F', G), 'b7');
assert.equal(toNashville('Dsus4', G), '5sus4');
assert.equal(toNashville('Am', { tonic: 9, minor: true }), '1m');
assert.equal(toRoman('Em7', G), 'vi7');
assert.equal(toRoman('C/G', G), 'IV/1');
assert.equal(toRoman('D', G), 'V');
assert.equal(toRoman('F#dim', G), 'vii°');
assert.equal(toRoman('F#m7b5', G), 'viiø7');
assert.equal(toRoman('F', G), 'bVII');
assert.equal(toRoman('Cmaj7', G), 'IVmaj7');
assert.equal(toRoman('C', { tonic: 9, minor: true }), 'III');
assert.equal(toRoman('Am', { tonic: 9, minor: true }), 'i');
assert.equal(pitchClass('Bb'), 10);

assert.deepEqual(sequence([1, 2, 3, 4], 'straight'), [1, 2, 3, 4, 3, 2, 1]);
assert.deepEqual(sequence([1, 2, 3, 4], 'threes'), [1, 2, 3, 2, 3, 4, 4, 3, 2, 3, 2, 1]);
console.log('theory: all passed');

// Generated scale exercises must load in alphaTab.
const alphaTab = await import('@coderline/alphatab');
const { scaleTex } = await import('../js/theory.js');
for (const scale of Object.keys(SCALES)) {
  for (const pattern of ['straight', 'threes', 'fours']) {
    for (const noteValue of [4, 8, 16]) {
      const tex = scaleTex({ root: 4, scale, position: 2, pattern, noteValue });
      const importer = new alphaTab.importer.AlphaTexImporter();
      importer.initFromString(tex, new alphaTab.Settings());
      const score = importer.readScore();
      assert.ok(score.tracks[0].staves[0].bars.length >= 2, `${scale} ${pattern} ${noteValue}`);
    }
  }
}
console.log('scale exercises: all load in alphaTab');

// Numbers count from the shapes' key: the page's Key: minus its capo, not a guess from the chords.
{
  const { shapesKey } = await import('../js/theory.js');
  const chords = ['G', 'C/G', 'Em7', 'C/G', 'G'];
  assert.deepEqual(shapesKey('G', 0, ['C/G', 'G', 'Em7']), { tonic: 7, minor: false, from: 'page' }, 'G sheet read as C before');
  assert.deepEqual(shapesKey('Bb', 3, chords), { tonic: 7, minor: false, from: 'page' }, 'Key Bb, capo 3: G shapes');
  assert.deepEqual(shapesKey('C#m', 4, []), { tonic: 9, minor: true, from: 'page' }, 'C#m capo 4: Am shapes');
  assert.equal(shapesKey('', 0, chords).from, 'chords', 'no key line: guessed');
  assert.equal(shapesKey('', 0, chords).tonic, 7);
  assert.equal(toRoman('G', shapesKey('G', 0, ['C/G', 'G'])), 'I');
  console.log('shapes key: from the page minus the capo');
}
