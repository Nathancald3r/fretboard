// Run: node tests/foundations.test.mjs
import assert from 'node:assert/strict';
import { EXERCISES, FOUNDATIONS, ROUTINE, routineMinutes, stepsDone, nextStep, stepKey, dayKey } from '../js/foundations.js';
import { DEMOS } from '../js/demos.js';
import { chartType } from '../js/songmeta.js';

const alphaTab = await import('@coderline/alphatab');
const read = (text) => {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(text, new alphaTab.Settings());
  return importer.readScore();
};

// Every exercise parses, is in 4/4 with full bars, and only uses frets and strings a guitar has.
const parsed = {};
for (const [id, e] of Object.entries(EXERCISES)) {
  const text = e.tex();
  const score = read(text);
  parsed[id] = score;
  assert.equal(score.title, e.title, `${id}: title`);
  assert.equal(score.tempo, e.tempo, `${id}: tempo`);
  assert.equal(score.tracks.length, 1, `${id}: one track`);
  assert.ok(score.masterBars.length >= 3, `${id}: too short`);
  for (const bar of score.tracks[0].staves[0].bars) {
    const ticks = bar.voices[0].beats.reduce((t, b) => t + b.playbackDuration, 0);
    assert.equal(ticks, 3840, `${id} bar ${bar.index + 1}: ${ticks} ticks`);
    for (const beat of bar.voices[0].beats) for (const n of beat.notes) {
      assert.ok(n.fret >= 0 && n.fret <= 24, `${id} bar ${bar.index + 1}: fret ${n.fret}`);
      assert.ok(n.string >= 1 && n.string <= 6, `${id} bar ${bar.index + 1}: string ${n.string}`);
    }
  }
  assert.ok(['Beginner', 'Intermediate'].includes(e.level), `${id}: level`);
  assert.ok(e.tip && e.tip.length > 20, `${id}: tip`);
  assert.equal(e.id, id);
}
assert.equal(new Set(Object.values(EXERCISES).map((e) => e.title)).size, Object.keys(EXERCISES).length, 'titles are unique');
// A saved exercise is an exercise, never a song in the library.
for (const e of Object.values(EXERCISES)) assert.equal(chartType({ kind: 'tex', title: e.title, artist: e.artist, data: e.tex() }), 'exercise');

const notesOf = (score) => score.tracks[0].staves[0].bars.flatMap((b) => b.voices[0].beats.flatMap((beat) => beat.notes.map((n) => n.isPlayed !== false && `${n.fret}.${n.string}`)));
const all = (id, f) => parsed[id].tracks[0].staves[0].bars.flatMap((b) => b.voices[0].beats.flatMap((beat) => beat.notes.filter(f)));

// The chromatic warm-up is the one the first launch seeds, note for note, so it is not saved twice.
assert.equal(EXERCISES.chromatic.title, DEMOS[0].title);
assert.deepEqual(notesOf(parsed.chromatic), notesOf(read(DEMOS[0].data)));

// The warm-ups and techniques carry what they teach.
assert.equal(parsed.spider.masterBars.length, 9);
assert.ok(all('legato', (n) => n.isHammerPullOrigin).length >= 36, 'hammer-ons and pull-offs');
assert.ok(all('slides', (n) => n.slideOutType !== 0).length >= 12, 'slides');
assert.ok(all('bends', (n) => n.bendPoints && n.bendPoints.length > 1).length >= 4, 'bends');
assert.ok(all('vibrato', (n) => n.vibrato !== 0).length >= 4, 'vibrato');
// The open chords are the real shapes: G has six strings, C five, and each chord is four strums a bar.
const chord = (id, bar) => parsed[id].tracks[0].staves[0].bars[bar].voices[0].beats[0].notes.map((n) => `${n.fret}.${n.string}`).sort();
assert.equal(chord('open1', 0).length, 6);
assert.equal(chord('open1', 1).length, 5);
assert.deepEqual(parsed.open1.tracks[0].staves[0].bars.map((b) => b.voices[0].beats.length), [4, 4, 4, 4]);

// The page: every item points at something that exists, and every exercise is on it once.
const shown = [];
for (const cat of FOUNDATIONS) {
  assert.ok(cat.title && cat.blurb && cat.items.length, cat.id);
  for (const it of cat.items) {
    if (typeof it === 'string') { assert.ok(EXERCISES[it], `${cat.id}: ${it}`); shown.push(it); }
    else assert.ok(it.drill || (it.href && it.title && it.blurb), `${cat.id}: item`);
  }
}
assert.deepEqual([...shown].sort(), Object.keys(EXERCISES).sort(), 'every exercise is on the page, once');
assert.deepEqual(FOUNDATIONS.map((c) => c.id), ['warmup', 'scales', 'chords', 'rhythm', 'technique', 'ear']);

// The routine: about ten minutes, in order, and it knows what was done today.
assert.equal(routineMinutes(), 10);
for (const s of ROUTINE) assert.ok(s.drill || EXERCISES[s.ex], 'routine step');
const noon = new Date(2026, 9, 27, 12).getTime();
const day = 86400000;
assert.equal(dayKey(noon), '2026-10-27');
assert.equal(stepsDone({ now: noon }).size, 0);
assert.equal(nextStep(new Set()).ex, 'chromatic');
// A session today for the exercise (by title) or the drill (by id) counts; yesterday's does not.
const done = stepsDone({ now: noon, sessions: [
  { songId: 7, title: EXERCISES.chromatic.title, start: noon - 3600000 },
  { songId: 'drill:keys', title: 'Chord changes', start: noon - 7200000 },
  { songId: 8, title: EXERCISES.spider.title, start: noon - day },
] });
assert.deepEqual([...done].sort(), ['chromatic', 'drill:keys']);
assert.equal(nextStep(done).ex, 'spider');
// Ticked by hand: counts today, not tomorrow.
assert.ok(stepsDone({ now: noon, ticks: { day: '2026-10-27', keys: ['picking'] } }).has('picking'));
assert.ok(!stepsDone({ now: noon + day, ticks: { day: '2026-10-27', keys: ['picking'] } }).has('picking'));
assert.equal(nextStep(new Set(ROUTINE.map(stepKey))), null);

console.log('foundations: every exercise loads in alphaTab, the page and the routine are consistent');
