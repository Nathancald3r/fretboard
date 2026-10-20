// Run: node tests/judge.test.mjs
import assert from 'node:assert/strict';
import { buildTargets, targetLabel, chromaFromSpectrum, matchFrame, createJudge, describeJudge } from '../js/judgecore.js';
import { midiToHz } from '../js/singcore.js';

const alphaTab = await import('@coderline/alphatab');
const load = (tex) => {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, new alphaTab.Settings());
  return importer.readScore();
};
const straight = (score) => score.masterBars.map((masterBar, i) => ({ start: i * 3840, masterBar }));

// Targets: chords as one moment, tied notes not struck again, rests skipped.
const score = load(`\\title "t" .
(0.5 2.4 2.3 1.2 0.1).4 0.6.4 0.6.4 r.4 | 3.6.2 -.6.2 |`);
const ev = buildTargets(score, 0, straight(score));
assert.equal(ev.length, 4);
assert.deepEqual(ev[0].midis, [45, 52, 57, 60, 64], 'Am chord, low to high');
assert.equal(targetLabel(ev[0]), 'Am');
assert.equal(targetLabel(ev[1]), 'E2');
assert.equal(ev[3].start, 3840);
assert.equal(ev[3].midis[0], 43, 'G on the low E');
assert.equal(ev[3].end - ev[3].start, 1920, 'the tied half note is not a second strike');

// Chroma from a spectrum: peaks at each note's harmonics.
const SR = 48000, BINS = 4096;
function spectrum(midis, harmonics = 4) {
  const db = new Float32Array(BINS).fill(-120);
  const binHz = SR / (BINS * 2);
  for (const m of midis) {
    for (let h = 1; h <= harmonics; h++) {
      const k = Math.round((midiToHz(m) * h) / binHz);
      if (k + 1 >= BINS) continue;
      const level = -20 - 8 * (h - 1);
      db[k] = Math.max(db[k], level);
      db[k - 1] = Math.max(db[k - 1], level - 12);
      db[k + 1] = Math.max(db[k + 1], level - 14);
    }
  }
  return db;
}
const am = chromaFromSpectrum(spectrum([45, 52, 57, 60, 64]), SR);
const top3 = am.chroma.map((v, i) => [v, i]).sort((x, y) => y[0] - x[0]).slice(0, 3).map(([, i]) => i).sort((x, y) => x - y);
assert.deepEqual(top3, [0, 4, 9], 'A, C and E are the strongest');
assert.equal(chromaFromSpectrum(new Float32Array(BINS).fill(-140), SR), null, 'silence');

const heard = (midis, midi = null) => ({ loud: true, midi, chroma: chromaFromSpectrum(spectrum(midis), SR).chroma });
assert.equal(matchFrame(heard([45, 52, 57, 60, 64]), ev[0]), 'hit', 'Am played');
assert.equal(matchFrame(heard([48, 52, 55, 60, 64]), ev[0]), 'wrong', 'C major instead');
assert.equal(matchFrame(heard([40, 47, 52, 55, 59, 64]), ev[0]), 'wrong', 'Em instead');
assert.equal(matchFrame({ loud: false }, ev[0]), 'quiet');
assert.equal(matchFrame(heard([40], 40.2), ev[1]), 'hit', 'E2, 20 cents sharp');
assert.equal(matchFrame(heard([52], 52), ev[1]), 'hit', 'E an octave up counts');
assert.equal(matchFrame(heard([41], 41), ev[1]), 'wrong', 'F instead of E');
assert.equal(matchFrame(heard([40]), ev[1]), 'hit', 'no single pitch found: the chroma decides');

// Judging over time: 1 tick = 1 ms here. Moment 0 hit, moment 1 wrong, moment 2 missed.
const j = createJudge();
const moments = [
  { start: 1000, end: 1500, midis: [60], index: 0 },
  { start: 2000, end: 2500, midis: [62], index: 1 },
  { start: 3000, end: 3500, midis: [64], index: 2 },
];
j.setEvents(moments);
const plays = (t) => (t >= 1020 && t < 1400 ? 60 : t >= 2020 && t < 2400 ? 63 : null);
const verdicts = [];
for (let t = 900; t <= 4000; t += 20) {
  const midi = plays(t);
  const out = j.frame(t, 1, (e) => matchFrame(midi === null ? { loud: false } : { loud: true, midi }, e));
  verdicts.push(...out.map((o) => o.verdict));
}
assert.deepEqual(verdicts, ['hit', 'wrong', 'missed']);
let s = j.summary();
assert.equal(s.score, 33);
assert.equal(s.best, 1);
assert.match(describeJudge(s), /1 of 3 notes\/chords hit · 1 wrong · 1 missed/);

// A jump back (a loop) forgets the open moment instead of judging it.
j.reset();
j.setEvents(moments);
j.frame(1000, 1, () => 'quiet');
j.frame(1100, 1, () => 'quiet');
assert.deepEqual(j.frame(200, 1, () => 'quiet'), []);
assert.equal(j.flush().length, 0);
assert.equal(j.summary().total, 0);

// A fast run: playing the next note early doesn't make the previous one wrong.
j.reset();
j.setEvents([{ start: 0, end: 100, midis: [60], index: 0 }, { start: 100, end: 200, midis: [62], index: 1 }]);
const run = [];
for (let t = 0; t <= 800; t += 20) {
  const midi = t < 100 ? 60 : 62;
  run.push(...j.frame(t, 1, (e) => matchFrame({ loud: true, midi }, e)).map((o) => o.verdict));
}
assert.deepEqual(run, ['hit', 'hit']);
assert.equal(j.summary().best, 2);

console.log('judge: all tests passed');
