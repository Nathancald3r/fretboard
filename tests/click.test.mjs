// Run: node tests/click.test.mjs
import assert from 'node:assert/strict';
import { clickEvents, countInPlan, sanitize, DEFAULTS } from '../js/click.js';

// One bar of 4/4 (3840 ticks): quarter notes, accent on 1.
let ev = clickEvents([{ start: 0, end: 3840, num: 4, den: 4 }]);
assert.deepEqual(ev.map((e) => e.tick), [0, 960, 1920, 2880]);
assert.deepEqual(ev.map((e) => e.level), [0, 1, 1, 1]);

// 8th notes: subdivisions get level 2.
ev = clickEvents([{ start: 0, end: 3840, num: 4, den: 4 }], { sub: 2 });
assert.equal(ev.length, 8);
assert.deepEqual(ev.slice(0, 3).map((e) => [e.tick, e.level]), [[0, 0], [480, 2], [960, 1]]);

// Triplets in a second bar that starts later; no accent.
ev = clickEvents([{ start: 3840, end: 7680, num: 4, den: 4 }], { sub: 3, accent: false });
assert.equal(ev.length, 12);
assert.equal(ev[0].tick, 3840);
assert.equal(ev[0].level, 1);
assert.equal(ev[1].tick, 3840 + 320);

// 6/8: six 8th-note beats per bar.
ev = clickEvents([{ start: 0, end: 2880, num: 6, den: 8 }]);
assert.equal(ev.length, 6);
assert.equal(ev[1].tick, 480);

// Count-in: one bar of 4/4 at 120 BPM → four clicks, 2 seconds.
let plan = countInPlan({ num: 4, den: 4, beatSeconds: 0.5 });
assert.equal(plan.clicks.length, 4);
assert.equal(plan.length, 2);
assert.deepEqual(plan.clicks.map((c) => c.count), [1, 2, 3, 4]);
assert.equal(plan.clicks[0].level, 0);

// Two bars of 8ths: 16 clicks, counts restart on bar 2.
plan = countInPlan({ num: 4, den: 4, beatSeconds: 0.5, bars: 2, sub: 2 });
assert.equal(plan.clicks.length, 16);
assert.equal(plan.length, 4);
assert.deepEqual(plan.clicks.filter((c) => c.count).map((c) => c.count), [1, 2, 3, 4, 1, 2, 3, 4]);

// Half a bar.
plan = countInPlan({ num: 4, den: 4, beatSeconds: 0.5, bars: 0.5 });
assert.equal(plan.clicks.length, 2);

// Compound 6/8 counts the dotted-quarter pulse: 2 clicks per bar.
plan = countInPlan({ num: 6, den: 8, beatSeconds: 0.25 });
assert.equal(plan.clicks.length, 2);
assert.equal(plan.length, 1.5);

// Settings: bad values fall back to defaults and volumes are clamped.
const s = sanitize({ sound: 'nope', sub: 7, volume: 9, countBars: '2', countSound: 'x' });
assert.equal(s.sound, DEFAULTS.sound);
assert.equal(s.sub, 1);
assert.equal(s.volume, 1.5);
assert.equal(s.countBars, 2);
assert.equal(s.countSound, DEFAULTS.countSound);

console.log('click: all tests passed');
