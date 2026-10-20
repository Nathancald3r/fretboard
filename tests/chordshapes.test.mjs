// Run: node tests/chordshapes.test.mjs
import assert from 'node:assert/strict';
import {
  CHORD_TYPES, chordVoicings, voicingNotes, splitChord, spellScale, keySignature,
  diatonicChords, progressionChords, PROGRESSIONS, CIRCLE_MAJOR, CIRCLE_MINOR, noteAt,
} from '../js/chordshapes.js';

// Every voicing of every chord: root in the bass, only chord tones, nothing missing
// except (optionally) the 5th, frets in range, a reachable stretch.
for (let root = 0; root < 12; root++) {
  for (const [type, { intervals }] of Object.entries(CHORD_TYPES)) {
    const voicings = chordVoicings(root, type);
    assert.ok(voicings.length >= 1, `no voicing for ${root} ${type}`);
    for (const v of voicings) {
      const label = `${root}${type} ${v.name} ${v.frets}`;
      const notes = voicingNotes(v.frets);
      const pcs = new Set(notes.map((m) => (m - root + 120) % 12));
      assert.equal(Math.min(...notes) % 12, root, `${label}: root not in bass`);
      for (const pc of pcs) assert.ok(intervals.includes(pc), `${label}: wrong note ${pc}`);
      for (const iv of intervals) if (iv !== 7) assert.ok(pcs.has(iv), `${label}: missing ${iv}`);
      const played = v.frets.filter((f) => f > 0);
      assert.ok(v.frets.every((f) => f >= -1 && f <= 15), `${label}: fret out of range`);
      assert.ok(!played.length || Math.max(...played) - Math.min(...played) <= 4, `${label}: stretch too wide`);
    }
  }
}
assert.deepEqual(chordVoicings(0, '')[0].frets, [-1, 3, 2, 0, 1, 0], 'C open first');
assert.equal(chordVoicings(5, '')[0].name, 'Open', 'F open first');
assert.ok(chordVoicings(11, 'm').some((v) => v.barre === 2), 'Bm barre at 2');
assert.deepEqual(splitChord('F#m7'), { root: 6, type: 'm7' });
assert.equal(splitChord('Cmaj13'), null);

assert.equal(spellScale('F#').join(' '), 'F# G# A# B C# D# E#');
assert.equal(spellScale('Bb').join(' '), 'Bb C D Eb F G A');
assert.equal(spellScale('E', true).join(' '), 'E F# G A B C D');
assert.deepEqual(keySignature('A'), { sharps: ['F#', 'C#', 'G#'], flats: [] });
assert.deepEqual(keySignature('Gm'), { sharps: [], flats: ['Bb', 'Eb'] });
assert.deepEqual(keySignature('C'), { sharps: [], flats: [] });
// Relative minors share the major key's signature.
CIRCLE_MAJOR.forEach((k, i) => assert.deepEqual(keySignature(k), keySignature(CIRCLE_MINOR[i])));

assert.equal(diatonicChords('G').map((c) => c.name).join(' '), 'G Am Bm C D Em F#dim');
assert.equal(diatonicChords('G').map((c) => c.roman).join(' '), 'I ii iii IV V vi vii°');
assert.equal(diatonicChords('C', true).map((c) => c.name).join(' '), 'Cmaj7 Dm7 Em7 Fmaj7 G7 Am7 Bm7b5');
assert.equal(diatonicChords('Am').map((c) => c.roman).join(' '), 'i ii° III iv v VI VII');
assert.equal(diatonicChords('G').map((c) => c.number).join(' '), '1 2m 3m 4 5 6m 7°');
const prog = (name, key) => progressionChords(PROGRESSIONS.find((p) => p.name.startsWith(name)), key)?.map((c) => c.name).join(' ');
assert.equal(prog('I – V – vi', 'C'), 'C G Am F');
assert.equal(prog('i – iv – V', 'Am'), 'Am Dm E Am');
assert.equal(prog('I – V – vi', 'Am'), undefined);
assert.equal(noteAt(0, 5), 9); // A on the low E string
assert.equal(noteAt(4, 1), 0); // C on the B string
console.log('chord shapes: all passed');
