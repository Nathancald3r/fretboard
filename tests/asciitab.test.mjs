// Checks that converted ASCII tabs parse in alphaTab and produce the expected notes.
// Run: node tests/asciitab.test.mjs
import assert from 'node:assert/strict';
import * as alphaTab from '@coderline/alphatab';
import { asciiTabToAlphaTex } from '../js/asciitab.js';

function load(tex) {
  const settings = new alphaTab.Settings();
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, settings);
  return importer.readScore();
}

function notesOf(score) {
  const out = [];
  for (const bar of score.tracks[0].staves[0].bars)
    for (const beat of bar.voices[0].beats)
      out.push(beat.isRest ? 'r' : beat.notes.map((n) => (n.isDead ? 'x' : n.fret) + '.' + n.string).join('+'));
  return out;
}

const cases = {
  'simple riff with bars': {
    text: `[Intro]
e|-------------|-------------|
B|-------------|-------------|
G|-------------|-------------|
D|-----2---0---|-------------|
A|---3-----3---|-0-2-3-------|
E|-0-----------|-------------|`,
    expect: (n) => { assert.equal(n.filter((x) => x !== 'r').length, 7); },
  },
  'chords, two-digit frets, techniques': {
    text: `e|--0-----12h14p12---|
B|--1-----------------|
G|--0--------------5/7|
D|--2-----------------|
A|--3--------x--------|
E|-------------------~|`,
    expect: (n, score) => {
      assert.ok(n.some((x) => x.split('+').length >= 4), 'C chord present: ' + n);
      assert.ok(n.some((x) => x.startsWith('12.')), 'two-digit fret');
      const notes = score.tracks[0].staves[0].bars.flatMap((b) => b.voices[0].beats.flatMap((bt) => bt.notes));
      assert.ok(notes.some((x) => x.isHammerPullOrigin), 'hammer-on');
      assert.ok(notes.some((x) => x.slideOutType > 0), 'slide');
      assert.ok(notes.some((x) => x.isDead), 'dead note');
    },
  },
  'drop D labels, no inner bars': {
    text: `e---------------------------
B---------------------------
G---------------------------
D---------------------------
A---------------------------
D-0-0-0-3-0-0-5-0-0-3-------`,
    expect: (n, score) => {
      assert.equal(score.tracks[0].staves[0].tuning.at(-1), 38, 'low D tuning');
      assert.equal(n.filter((x) => x !== 'r').length, 10);
    },
  },
  'real-world sheet: lyrics, chords, repeat marks, two systems': {
    text: `Song Title - Artist
Tuning: Standard

[Verse]
   Em                 G
e|-------------------|-------------------|  x2
B|-------------------|-------------------|
G|-------------------|-------------------|
D|-------2-----2-----|-------0-----0-----|
A|---2-------2-------|---2-------2-------|
E|-0-----------------|-3-----------------|
Some lyrics go here and they mention the A and E chords

e|-----------------|
B|-----------------|
G|-----------------|
D|-----------------|
A|-0-2-3-----------|
E|-----------------|`,
    expect: (n) => {
      assert.ok(!n.some((x) => x.startsWith('x')), 'repeat mark is not a dead note: ' + n);
      assert.equal(n.filter((x) => x !== 'r').length, 13);
    },
  },
  'bass tab (4 strings)': {
    text: `G|----------------|
D|----------------|
A|--------3--5----|
E|--0--0----------|`,
    expect: (n, score) => assert.equal(score.tracks[0].staves[0].tuning.length, 4),
  },
  'header: tempo, capo, tuning as it sounds with the capo': {
    text: `Candlelight - Relient K - 1st Electric Guitar
Symbols Used:
2222 : 16th notes / One note trill

Tuning: Capo on the 1st fret (F, Bb, Eb, Ab, C, f)
Tempo: 196 (98)

e|-------------|
B|-------------|
G|-------------|
D|-----2---0---|
A|---3-----3---|
E|-0-----------|`,
    expect: (n, score) => {
      assert.equal(score.tempo, 196);
      assert.equal(score.tracks[0].staves[0].capo, 1);
      assert.deepEqual(score.tracks[0].staves[0].tuning, [64, 59, 55, 50, 45, 40]);
    },
  },
  'Candlelight intro: each column a slot, string names as they sound with the capo': {
    text: `Tuning: Capo on the 1st fret (F, Bb, Eb, Ab, C, f)
Tempo: 196 (98)

f |---0----|---2----|---12-----|
C |-2---2--|-2---2--|-----2----|
Ab|--------|--------|----------|
Eb|--------|--------|----------|
Bb|0-0-----|0-0-----|0h2-------|
F |--------|--------|----------|`,
    expect: (n, score) => {
      const bars = score.tracks[0].staves[0].bars;
      assert.deepEqual(score.tracks[0].staves[0].tuning, [64, 59, 55, 50, 45, 40]);
      assert.equal(score.tracks[0].staves[0].capo, 1);
      const beats = (b) => b.voices[0].beats.map((x) => (x.isRest ? 'r' : x.notes.map((m) => m.fret).join('+')) + '/' + x.duration + (x.dots ? '.' : ''));
      // 0 2 0 then f0 a quarter (the gap before C2), C2 a dotted quarter: 8 eighths, 4/4
      assert.deepEqual(beats(bars[0]), ['0/8', '2/8', '0/8', '0/4', '2/4.']);
      // 12 is one slot and the h of 0h2 is none: 0 2 12 2(5 slots) → 8 slots
      assert.deepEqual(beats(bars[2]), ['0/8', '2/8', '12/8', '2/2', 'r/8']);
      for (const b of bars) assert.equal(b.masterBar.timeSignatureNumerator + '/' + b.masterBar.timeSignatureDenominator, '4/4');
    },
  },
  'strums side by side: 22 beside 00 is two strums of fret 2, each column one 8th': {
    text: `f |0-00-000|0-00-000|
C |2-22-222|2-22-222|
Ab|2-22-222|2-22-222|
Eb|2-22-222|2-22-222|
Bb|0-00-000|0-00-000|
F |0-00-000|0-00-000|`,
    expect: (n, score) => {
      const bar = score.tracks[0].staves[0].bars[0];
      const beats = bar.voices[0].beats.map((x) => x.notes.map((m) => m.fret).sort().join('') + '/' + x.duration);
      assert.deepEqual(beats, ['000222/4', '000222/8', '000222/4', '000222/8', '000222/8', '000222/8']);
      assert.equal(bar.masterBar.timeSignatureNumerator + '/' + bar.masterBar.timeSignatureDenominator, '4/4');
    },
  },
  '22 in a chord of 2s and 0s is 2 twice, not fret 22': {
    text: `f |0--0----|
C |22---2--|
Ab|2-------|
Eb|2-------|
Bb|0-------|
F |0-------|`,
    expect: (n, score) => {
      const bar = score.tracks[0].staves[0].bars[0];
      assert.ok(bar.voices[0].beats.every((b) => b.notes.every((m) => m.fret < 10)));
      assert.equal(bar.masterBar.timeSignatureNumerator + '/' + bar.masterBar.timeSignatureDenominator, '4/4');
    },
  },
  'header: drop D, half-step-down list': {
    text: `Tuning: Drop D
Tempo: 140

e|---------|
B|---------|
G|---------|
D|---------|
A|---------|
D|-0-0-0-0-|`,
    expect: (n, score) => {
      assert.equal(score.tempo, 140);
      assert.deepEqual(score.tracks[0].staves[0].tuning, [64, 59, 55, 50, 45, 38]);
    },
  },
  'header: tuning list low to high': {
    text: `Tuning: Eb Ab Db Gb Bb Eb

e|-0---1---|
B|---------|
G|---------|
D|---------|
A|---------|
E|-0-------|`,
    expect: (n, score) => assert.deepEqual(score.tracks[0].staves[0].tuning, [63, 58, 54, 49, 44, 39]),
  },
};

let failed = 0;
for (const [name, c] of Object.entries(cases)) {
  try {
    const res = asciiTabToAlphaTex(c.text, { title: name });
    assert.ok(res, 'no tab found');
    const score = load(res.tex);
    c.expect(notesOf(score), score);
    console.log('ok  ', name, '→', notesOf(score).join(' '));
  } catch (e) {
    failed++;
    console.log('FAIL', name, '\n', e.message);
    const res = asciiTabToAlphaTex(c.text, { title: name });
    if (res) console.log(res.tex);
  }
}
assert.equal(asciiTabToAlphaTex('Am C G\nJust lyrics'), null, 'chord sheet has no tab');
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
