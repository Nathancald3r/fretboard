// Run: node tests/amp.test.mjs
import assert from 'node:assert/strict';
import {
  CHARACTERS, CABINETS, BUILT_IN_PRESETS, PARAMS, DEFAULTS,
  makeCurve, driveGains, makeCabinetIR, makeReverbIR, normalizeSettings,
} from '../js/ampdsp.js';

// Curves: monotonic, odd-ish, end at ±1, near-linear around zero.
for (const name of Object.keys(CHARACTERS)) {
  const c = makeCurve(name, 1025);
  assert.ok(Math.abs(c[0] + 1) < 1e-6 && Math.abs(c[1024] - 1) < 1e-6, `${name} ends at ±1`);
  assert.ok(Math.abs(c[512]) < 1e-6, `${name} passes through 0`);
  for (let i = 1; i < c.length; i++) assert.ok(c[i] >= c[i - 1], `${name} monotonic`);
}
// Higher gain characters saturate more at the same input.
const at = (name, x) => makeCurve(name, 2001)[Math.round((x + 1) * 1000)];
assert.ok(at('highgain', 0.2) > at('crunch', 0.2) && at('crunch', 0.2) > at('clean', 0.2));

// More drive: more pre-gain, less make-up gain.
const lo = driveGains('crunch', 2), hi = driveGains('crunch', 8);
assert.ok(hi.pre > lo.pre && hi.post < lo.post);
assert.equal(driveGains('clean', 0).pre, 1);

// Cabinet IRs: finite, unit energy, and they cut the fizz (more energy below 5 kHz than above).
for (const name of Object.keys(CABINETS)) {
  const ir = makeCabinetIR(name, 48000);
  if (name === 'off') { assert.equal(ir, null); continue; }
  assert.ok(ir.every(Number.isFinite), `${name} finite`);
  let e = 0; for (const v of ir) e += v * v;
  assert.ok(Math.abs(e - 1) < 0.25, `${name} energy ${e}`);
  // Crude band check: DFT magnitude at 1 kHz vs 9 kHz.
  const mag = (f) => { let re = 0, im = 0; ir.forEach((v, i) => { re += v * Math.cos(2 * Math.PI * f * i / 48000); im -= v * Math.sin(2 * Math.PI * f * i / 48000); }); return Math.hypot(re, im); };
  assert.ok(mag(1000) > mag(9000) * 4, `${name} rolls off highs`);
  assert.ok(mag(1000) > mag(30) * 2, `${name} rolls off sub-bass`);
}
assert.deepEqual(makeCabinetIR('4x12', 44100), makeCabinetIR('4x12', 44100), 'deterministic');

const [l, r] = makeReverbIR(44100, 1);
assert.equal(l.length, 44100);
assert.ok(l.every(Number.isFinite) && r.some((v, i) => v !== l[i]), 'stereo reverb');

// Settings: defaults, clamping, junk ignored.
assert.deepEqual(normalizeSettings({}), DEFAULTS);
const n = normalizeSettings({ drive: 99, bass: -50, character: 'nope', cabinet: '2x12', master: 'x', gate: null });
assert.equal(n.drive, 10);
assert.equal(n.bass, -12);
assert.equal(n.character, DEFAULTS.character);
assert.equal(n.cabinet, '2x12');
assert.equal(n.master, DEFAULTS.master);
assert.equal(n.gate, DEFAULTS.gate);

// Built-in presets: the six tones, unique ids, all settings in range.
assert.deepEqual(BUILT_IN_PRESETS.map((p) => p.name), ['Clean', 'Edge of breakup', 'Classic rock crunch', '80s lead', 'Modern high gain', 'Blues']);
assert.equal(new Set(BUILT_IN_PRESETS.map((p) => p.id)).size, BUILT_IN_PRESETS.length);
for (const p of BUILT_IN_PRESETS) {
  for (const k of PARAMS) assert.ok(p.settings[k.key] >= k.min && p.settings[k.key] <= k.max, `${p.name} ${k.key}`);
}

console.log('amp tests passed');
