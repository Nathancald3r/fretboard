// Run: node tests/ytapi.test.mjs
import assert from 'node:assert/strict';
import { clock, nextRate, barFraction } from '../js/ytapi.js';

/* ---------- the time shown beside the seek bar ---------- */
assert.equal(clock(0), '0:00');
assert.equal(clock(5.9), '0:05', 'whole seconds, rounded down');
assert.equal(clock(83.4), '1:23');
assert.equal(clock(600), '10:00');
assert.equal(clock(3725), '1:02:05');
assert.equal(clock(-4), '0:00');
assert.equal(clock(NaN), '0:00');
assert.equal(clock(undefined), '0:00');

/* ---------- the speed button: normal → slower → … → normal ---------- */
assert.equal(nextRate(1, [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]), 0.75);
assert.equal(nextRate(0.75, [0.25, 0.5, 0.75, 1, 1.25]), 0.5);
assert.equal(nextRate(0.5, [0.25, 0.5, 0.75, 1]), 0.25);
assert.equal(nextRate(0.25, [0.25, 0.5, 0.75, 1]), 1, 'back to normal');
assert.equal(nextRate(1, [0.5, 1, 2]), 0.5, 'a speed YouTube does not offer is skipped');
assert.equal(nextRate(0.5, [0.5, 1, 2]), 1);
assert.equal(nextRate(1, undefined), 0.75, 'no list: the usual steps');
assert.equal(nextRate(1, []), 0.75);
assert.equal(nextRate(1, [2]), 1, 'nothing slower on offer: stay');
assert.equal(nextRate(1.25, [0.5, 1]), 1, 'an odd current speed lands on a step');

/* ---------- where a tap landed on the bar ---------- */
assert.equal(barFraction(150, 100, 200), 0.25);
assert.equal(barFraction(50, 100, 200), 0, 'left of the bar');
assert.equal(barFraction(900, 100, 200), 1, 'right of the bar');
assert.equal(barFraction(10, 0, 0), 0, 'a bar with no width');

console.log('ok ytapi');
