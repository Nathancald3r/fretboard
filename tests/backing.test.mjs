// Run: node tests/backing.test.mjs
import assert from 'node:assert/strict';
import { backingTex, bassRoot, STYLES } from '../js/backing.js';
import { progressionChords, PROGRESSIONS } from '../js/chordshapes.js';

// Bass roots stay low: E string up to G#, then the A string.
assert.deepEqual(bassRoot(4), { string: 4, fret: 0 }); // E
assert.deepEqual(bassRoot(7), { string: 4, fret: 3 }); // G
assert.deepEqual(bassRoot(9), { string: 3, fret: 0 }); // A
assert.deepEqual(bassRoot(2), { string: 3, fret: 5 }); // D

// Every style and progression loads in alphaTab with full 4/4 bars on all three tracks.
const alphaTab = await import('@coderline/alphatab');
for (const style of Object.keys(STYLES)) {
  for (const prog of PROGRESSIONS) {
    const key = prog.major ? 'G' : 'Em';
    const chords = progressionChords(prog, key);
    const repeats = 2;
    const tex = backingTex({ title: `${key} ${prog.name}`, chords, style, tempo: 100, repeats });
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(tex, new alphaTab.Settings());
    const score = importer.readScore();
    assert.equal(score.tracks.length, 3, `${style} ${prog.name}`);
    assert.equal(score.masterBars.length, chords.length * repeats, `${style} ${prog.name}: bar count`);
    assert.equal(score.tempo, 100);
    for (const track of score.tracks) {
      for (const bar of track.staves[0].bars) {
        const ticks = bar.voices[0].beats.reduce((t, b) => t + b.playbackDuration, 0);
        assert.equal(ticks, 3840, `${style} ${prog.name} ${track.name} bar ${bar.index + 1}: ${ticks} ticks`);
      }
    }
  }
}

console.log('backing tracks: all load in alphaTab');
