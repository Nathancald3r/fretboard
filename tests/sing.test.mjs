// Run: node tests/sing.test.mjs
import assert from 'node:assert/strict';
import {
  detectPitch, hzToMidi, midiToHz, midiName, compare, judge, buildMelody, noteAt, createScorer, describe,
  nearestScaleNote, createFreeScorer,
} from '../js/singcore.js';

const SR = 48000;
const N = 2048;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} not within ${tol} of ${b}`);
const cents = (hz, ref) => 1200 * Math.log2(hz / ref);

// A voice-like tone: fundamental plus decaying harmonics, a bit of noise.
function tone(hz, { harmonics = 1, amp = 0.3, noise = 0, phase = 0.3 } = {}) {
  const buf = new Float32Array(N);
  let seed = 7;
  for (let i = 0; i < N; i++) {
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * hz * h * (i / SR) + phase * h) / h;
    seed = (seed * 16807) % 2147483647;
    buf[i] = amp * v + noise * ((seed / 2147483647) * 2 - 1);
  }
  return buf;
}

// Pitch detection across the singing range, within 5 cents.
for (const hz of [82.41, 110, 196, 261.63, 440, 659.25, 987.77]) {
  const p = detectPitch(tone(hz), SR);
  assert.ok(p, `no pitch for ${hz} Hz`);
  near(cents(p.hz, hz), 0, 5, `sine ${hz} Hz`);
  const rich = detectPitch(tone(hz, { harmonics: 8, noise: 0.02 }), SR);
  assert.ok(rich, `no pitch for rich ${hz} Hz`);
  near(cents(rich.hz, hz), 0, 5, `harmonic tone ${hz} Hz (no octave error)`);
}
// Quiet frames and noise give no pitch.
assert.equal(detectPitch(new Float32Array(N), SR), null);
assert.equal(detectPitch(tone(220, { amp: 0.003 }), SR), null);
assert.equal(detectPitch(tone(220, { amp: 0, noise: 0.3 }), SR), null);

// Cents math.
assert.equal(hzToMidi(440), 69);
near(midiToHz(60), 261.6256, 0.001, 'middle C');
near(hzToMidi(midiToHz(64.25)), 64.25, 1e-9, 'round trip');
assert.equal(midiName(60), 'C4');
assert.equal(midiName(69), 'A4');
assert.equal(midiName(70.4), 'A#4');
near(compare(69.3, 69).cents, 30, 1e-9, '30 cents sharp');
assert.deepEqual([compare(57.2, 69).octaves, Math.round(compare(57.2, 69).cents)], [-1, 20]); // an octave low, 20¢ sharp
assert.equal(judge(68.4, 69).status, 'flat');
assert.equal(judge(69.6, 69).status, 'sharp');
assert.equal(judge(69.49, 69).status, 'in');
assert.equal(judge(81.1, 69).status, 'in'); // octave up counts as the right note
assert.equal(judge(81.1, 69).octaves, 1);
assert.equal(judge(63.4, 69).status, 'flat'); // 5.6 semitones low is nearer this octave than the one below

// Melody timeline from a fake alphaTab score: bar 1 = C4 E4 (E4 tied into bar 2), bar 2 =
// rest then G4 with a chord under it; bar 2 is repeated, so it plays twice.
const n = (realValue, extra = {}) => ({ realValue, isDead: false, isTieDestination: false, ...extra });
const beat = (playbackStart, playbackDuration, notes, isRest = false) => ({ playbackStart, playbackDuration, notes, isRest });
const score = {
  tracks: [
    { staves: [{ isPercussion: true, bars: [] }] },
    {
      staves: [{
        isPercussion: false,
        bars: [
          { voices: [{ beats: [beat(0, 1920, [n(60)]), beat(1920, 1920, [n(64)])] }] },
          { voices: [{ beats: [beat(0, 960, [n(64, { isTieDestination: true })]), beat(960, 960, [], true), beat(1920, 1920, [n(55), n(67), n(59)])] }] },
        ],
      }],
    },
  ],
};
const bars = [
  { start: 0, masterBar: { index: 0 } },
  { start: 3840, masterBar: { index: 1 } },
  { start: 7680, masterBar: { index: 1 } },
];
const melody = buildMelody(score, 1, bars);
assert.deepEqual(melody.map((x) => [x.start, x.end, x.midi]), [
  [0, 1920, 60],
  [1920, 4800, 64], // tied across the bar line
  [5760, 7680, 67], // top note of the chord
  [7680, 8640, 64], // the repeat: tie destination with no matching note before stays a note
  [9600, 11520, 67],
]);
assert.deepEqual(buildMelody(score, 0, bars), []); // drums have no melody
assert.equal(noteAt(melody, 0).midi, 60);
assert.equal(noteAt(melody, 4799).midi, 64);
assert.equal(noteAt(melody, 5000), null); // the rest
assert.equal(noteAt(melody, 9700).midi, 67);
assert.equal(noteAt(melody, 20000), null);
assert.equal(noteAt([], 0), null);

// Scoring: one 1 s note sung in tune, one sung flat for half and silent for half, one an
// octave low in tune. Onsets (first 120 ms) are not scored.
const sc = createScorer();
const sing = (note, sung, ms) => {
  for (let t = 0; t < ms; t += 10) sc.add({ note, sung: typeof sung === 'function' ? sung(t) : sung, dt: 10, sinceOnsetMs: t, noteMs: ms });
};
const [a, b, c] = [{ index: 0, midi: 60 }, { index: 1, midi: 62 }, { index: 2, midi: 64 }];
sing(a, () => 60.1, 1000);
sing(b, (t) => (t < 500 ? 61.2 : null), 1000);
sing(c, 52.05, 1000);
const s = sc.summary();
near(s.seconds, 2.64, 0.001, 'scored time excludes onsets');
assert.equal(s.notes, 3);
assert.equal(s.notesHit, 2);
assert.equal(s.score, 67);
assert.equal(s.flat, 14); // 380 ms of 2640
assert.equal(s.silent, 19);
assert.equal(s.sharp, 0);
assert.equal(s.octave, 33);
assert.match(describe(s), /2 of 3 notes hit/);
assert.match(describe(s), /another octave/);
sc.reset();
assert.equal(sc.summary().notes, 0);
assert.equal(sc.add({ note: null, sung: 60, dt: 10 }), null); // between notes: not scored

// Pitch trainer: the nearest note of a key/scale.
const major = [0, 2, 4, 5, 7, 9, 11];
assert.deepEqual(nearestScaleNote(60.3, 0, major), { midi: 60, degree: 0 }); // C major, a bit sharp of C
assert.equal(nearestScaleNote(61.4, 0, major).midi, 62, 'C#+40 is nearer D in C major');
assert.equal(nearestScaleNote(61.4, 0, []).midi, 61, 'chromatic: every semitone');
assert.equal(nearestScaleNote(70.2, 9, [0, 3, 5, 7, 10]).midi, 69, 'A minor pentatonic: Bb-ish → A');
assert.equal(nearestScaleNote(59.4, 0, major).midi, 59, 'B, an octave below the tonic');
const fs = createFreeScorer();
fs.add({ cents: 10, dt: 300 }); fs.add({ cents: -80, dt: 100 }); fs.add({ cents: null, dt: 500 });
assert.deepEqual(fs.summary(), { seconds: 0.4, inTune: 75, flat: 25, sharp: 0 });

console.log('sing tests passed');
