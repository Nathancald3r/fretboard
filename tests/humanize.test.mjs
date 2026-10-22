// Run: node tests/humanize.test.mjs
import assert from 'node:assert/strict';
import { humanize, liftCymbals, NOTE_ON, NOTE_OFF, PROGRAM, TEMPO } from '../js/humanize.js';

const on = (tick, ch, key, vel = 100) => ({ type: NOTE_ON, tick, channel: ch, noteKey: key, noteVelocity: vel });
const off = (tick, ch, key) => ({ type: NOTE_OFF, tick, channel: ch, noteKey: key, noteVelocity: 0 });
const chord = (tick, ch, keys, len) => keys.flatMap((k) => [on(tick, ch, k), off(tick + len, ch, k)]);
const E = [40, 47, 52, 56, 59, 64]; // E major, low to high

// Channel 0 guitar, channel 1 piano, 120 bpm.
let ev = [
  { type: TEMPO, tick: 0, beatsPerMinute: 120 },
  { type: PROGRAM, tick: 0, channel: 0, program: 25 },
  { type: PROGRAM, tick: 0, channel: 1, program: 0 },
  ...chord(0, 0, E, 960), // on the beat, a quarter: downstroke
  ...chord(1440, 0, E, 480), // the "and" of beat 2: upstroke
  ...chord(0, 1, E, 960), // piano: untouched
];
assert.equal(humanize(ev, { barStarts: [0] }), 2);
const ons = (ch, from, to) => ev.filter((e) => e.type === NOTE_ON && e.channel === ch && e.tick >= from && e.tick < to);

// Downstroke: low string first, high string last, spread over ~30 ms (= 57.6 ticks at 120 bpm).
let down = ons(0, 0, 200).sort((a, b) => a.tick - b.tick);
assert.deepEqual(down.map((e) => e.noteKey), E);
assert.equal(down[0].tick, 0);
assert.ok(down[5].tick >= 50 && down[5].tick <= 60, `downstroke length ${down[5].tick}`);

// Upstroke: high string first, quicker, softer.
let up = ons(0, 1400, 1700).sort((a, b) => a.tick - b.tick || b.noteKey - a.noteKey);
assert.deepEqual(up.map((e) => e.noteKey), [...E].reverse());
assert.equal(up[0].tick, 1440);
assert.ok(up[5].tick - 1440 < down[5].tick, 'upstroke quicker');
const avg = (a) => a.reduce((s, e) => s + e.noteVelocity, 0) / a.length;
assert.ok(avg(up) < avg(down) - 8, 'upstroke softer');

// The piano chord is left exactly as it was.
assert.ok(ons(1, 0, 10000).every((e) => e.tick === 0 && e.noteVelocity === 100));

// Every note still starts before it ends, and velocities stay in range.
for (const e of ev) if (e.type === NOTE_ON) {
  const end = ev.find((o) => o.type === NOTE_OFF && o.channel === e.channel && o.noteKey === e.noteKey && o.tick > e.tick);
  assert.ok(end, 'note-off after note-on');
  assert.ok(e.noteVelocity >= 1 && e.noteVelocity <= 127);
}

// A very short chord (32nd) is spread over at most 30% of its length.
ev = [{ type: PROGRAM, tick: 0, channel: 0, program: 29 }, ...chord(960, 0, E, 120)];
humanize(ev);
const last = Math.max(...ev.filter((e) => e.type === NOTE_ON).map((e) => e.tick));
assert.ok(last - 960 <= 36, `short chord spread ${last - 960}`);

// Same input, same result (repeatable).
const make = () => [{ type: PROGRAM, tick: 0, channel: 0, program: 27 }, ...chord(0, 0, E, 960), on(960, 0, 64), off(1920, 0, 64)];
const a = make(), b = make();
humanize(a); humanize(b);
assert.deepEqual(a, b);

// Single notes keep their timing; only their touch varies a little.
const single = a.find((e) => e.type === NOTE_ON && e.tick === 960);
assert.ok(Math.abs(single.noteVelocity - 100) <= 4);

// Hi-hats and cymbals on the drum channel play louder; the snare and other channels don't.
const drums = [{ type: NOTE_ON, tick: 0, channel: 9, noteKey: 42, noteVelocity: 80 }, { type: NOTE_ON, tick: 0, channel: 9, noteKey: 38, noteVelocity: 80 },
  { type: NOTE_ON, tick: 0, channel: 0, noteKey: 42, noteVelocity: 80 }, { type: NOTE_ON, tick: 0, channel: 9, noteKey: 49, noteVelocity: 120 }];
assert.equal(liftCymbals(drums), 2);
assert.deepEqual(drums.map((e) => e.noteVelocity), [114, 80, 80, 127]);

console.log('humanize tests passed');

// Synth pads ring on: up to a beat past the chord, overlapping the next chord by a sixteenth.
{
  const { sustainPads } = await import('../js/humanize.js');
  const pad = [
    { type: PROGRAM, tick: 0, channel: 2, program: 89 },
    ...chord(0, 2, [52, 56, 59], 1920), // half note, then a rest
    ...chord(3840, 2, [52, 57, 61], 3600), // nearly a whole bar, then the next chord at 7680
    ...chord(7680, 2, [52, 56, 59], 960),
  ];
  assert.equal(sustainPads(pad), 9);
  const offs = (from, to) => pad.filter((e) => e.type === NOTE_OFF && e.tick >= from && e.tick < to).map((e) => e.tick);
  assert.deepEqual(offs(0, 3840), [2880, 2880, 2880], 'a beat of ring after the first chord');
  assert.ok(pad.filter((e) => e.type === NOTE_OFF && e.noteKey === 57).every((e) => e.tick === 7680 + 240), 'fades into the next chord');
  const k52 = pad.filter((e) => e.noteKey === 52).sort((a, b) => a.tick - b.tick).map((e) => e.type === NOTE_ON ? 'on' : 'off');
  assert.deepEqual(k52, ['on', 'off', 'on', 'off', 'on', 'off'], 'a repeated key stops before it is struck again');
  const guitar = [{ type: PROGRAM, tick: 0, channel: 0, program: 25 }, ...chord(0, 0, E, 960)];
  assert.equal(sustainPads(guitar), 0, 'guitars are left alone');
  console.log('pad sustain ok');
}

// Drums and a shaker: each percussion track gets its own channel, still played as drums (bank 128).
{
  const { ownDrumChannels, DRUM_CHANNEL } = await import('../js/humanize.js');
  const alphaTab = await import('@coderline/alphatab');
  const { ugToAlphaTex } = await import('../js/ugtab.js');
  const hits = (piece) => [{ drums: true, bars: [{ x0: 0, x1: 200, cols: [0, 1, 2, 3].map((i) => ({ cx: 20 + i * 45, len: 4, notes: [{ drum: piece }] })) }] }];
  const guitar = [{ bars: [{ x0: 0, x1: 200, cols: [0, 1, 2, 3].map((i) => ({ cx: 20 + i * 45, len: 4, notes: [{ s: 5, t: '0' }] })) }] }];
  // five guitars before the drums: alphaTab gives the fifth channels 8 and 9, the drum channel
  const five = [1, 2, 3, 4].map((i) => ({ name: 'Guitar ' + i, program: 25, strips: guitar }));
  const { tex } = ugToAlphaTex(guitar, { title: 'T', name: 'Guitar', program: 25, extra: [...five, { name: 'Drums', strips: hits('kick') }, { name: 'Shaker', strips: hits('shaker') }] });
  const imp = new alphaTab.importer.AlphaTexImporter();
  imp.initFromString(tex, new alphaTab.Settings());
  const score = imp.readScore();
  assert.equal(score.tracks[4].playbackInfo.secondaryChannel, DRUM_CHANNEL, 'alphaTab puts the fifth guitar on the drum channel');
  assert.equal(ownDrumChannels(score.tracks), 2);
  const infos = score.tracks.map((t) => t.playbackInfo);
  const [g, d, s] = [infos[0], infos[5], infos[6]];
  assert.ok(infos.every((p, i) => i === 5 || (p.primaryChannel !== DRUM_CHANNEL && p.secondaryChannel !== DRUM_CHANNEL)), 'only the drums use the drum channel');
  assert.equal(d.primaryChannel, DRUM_CHANNEL, 'the drums stay on the drum channel');
  assert.ok(s.primaryChannel !== DRUM_CHANNEL && s.primaryChannel === s.secondaryChannel, 'the shaker has a channel of its own');
  assert.ok(![g.primaryChannel, g.secondaryChannel].includes(s.primaryChannel), 'not one the guitar uses');
  const midi = new alphaTab.midi.MidiFile();
  new alphaTab.midi.MidiFileGenerator(score, new alphaTab.Settings(), new alphaTab.midi.AlphaSynthMidiFileHandler(midi)).generate();
  const ev = midi.tracks.flatMap((t) => t.events);
  const bank = ev.filter((e) => e.channel === s.primaryChannel && e.controller === 0).map((e) => e.value);
  assert.deepEqual(bank, [1], 'bank select 128 (coarse 1) on the shaker channel');
  assert.ok(ev.some((e) => e.channel === s.primaryChannel && e.noteKey === 82), 'shaker notes play on its channel');
  assert.ok(ev.some((e) => e.channel === DRUM_CHANNEL && e.noteKey === 36) && !ev.some((e) => e.channel === DRUM_CHANNEL && e.noteKey === 82), 'drum notes stay on 9');
  console.log('drum channels ok');
}
