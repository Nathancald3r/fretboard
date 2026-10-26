import assert from 'node:assert/strict';
import { trainerStep, recordClean, rangeKey } from '../js/cleanspeed.js';

const opts = { start: 60, target: 100, step: 5, every: 2 };
let s = { speed: 60, run: 0, loops: 0 };

// Note check off: the old rule, +5 every 2 loops.
s = trainerStep(s, null, opts); assert.equal(s.speed, 60);
s = trainerStep(s, null, opts); assert.equal(s.speed, 65); assert.equal(s.change, 'up');

// Three clean loops in a row before speeding up.
s = { speed: 70, run: 0, loops: 0 };
s = trainerStep(s, 95, opts); s = trainerStep(s, 92, opts); assert.equal(s.speed, 70);
s = trainerStep(s, 90, opts); assert.equal(s.speed, 75); assert.equal(s.run, 0);

// A middling loop resets the run.
s = trainerStep(s, 95, opts); s = trainerStep(s, 95, opts); s = trainerStep(s, 80, opts);
assert.equal(s.run, 0); s = trainerStep(s, 95, opts); assert.equal(s.speed, 75);

// A messy loop drops 5%.
s = trainerStep({ speed: 80, run: 2, loops: 4 }, 50, opts);
assert.equal(s.speed, 76); assert.equal(s.change, 'down'); assert.equal(s.run, 0);
// Never below 25%.
assert.equal(trainerStep({ speed: 25, run: 0, loops: 0 }, 10, opts).speed, 25);

// Reaching the target ends the trainer.
s = { speed: 95, run: 2, loops: 9 };
s = trainerStep(s, 100, opts); assert.equal(s.speed, 100); assert.ok(s.done);

// Best clean tempo per range.
const k = rangeKey({ startTick: 960, endTick: 7680 });
assert.equal(k, '960-7680');
let best = recordClean(undefined, k, 70, 95); assert.deepEqual(best, { [k]: 70 });
assert.equal(recordClean(best, k, 80, 85), best);          // not clean
assert.equal(recordClean(best, k, 65, 99), best);          // slower than best
assert.deepEqual(recordClean(best, k, 80, 91), { [k]: 80 });

console.log('cleanspeed tests passed');
