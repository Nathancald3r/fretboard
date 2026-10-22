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
