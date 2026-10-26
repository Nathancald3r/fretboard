// Run: node tests/strumcore.test.mjs
import assert from 'node:assert/strict';
import { PATTERNS, expectedStrums, barSeconds, createOnsetDetector, blockDb, scoreStrums, summary, verdict, loopbackLatency, nextBpm } from '../js/strumcore.js';

const island = PATTERNS.find((p) => p.id === 'island');

// When strums are due: D - D U - U D U at 120 BPM, eighths are 0.25 s.
const ex = expectedStrums(island, 120, 1, 2);
assert.equal(ex.length, 12, '6 strums a bar');
assert.deepEqual(ex.slice(0, 6).map((e) => e.t), [1, 1.5, 1.75, 2.25, 2.5, 2.75]);
assert.deepEqual(ex.slice(0, 6).map((e) => e.stroke).join(''), 'DDUUDU');
assert.equal(ex[6].t, 3, 'bar 2 starts 2 s later');
assert.equal(barSeconds(island, 120), 2);
for (const p of PATTERNS) assert.equal(p.slots.length, p.beats * p.sub, p.id);

// A made-up recording: room noise, a quiet click on every beat, and strums (a loud burst
// that rings and fades) at known times, some a little off the beat.
const SR = 48000;
const HOP = 64;
function render(len, strums, clicks) {
  const x = new Float32Array(Math.round(len * SR));
  let seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  for (let k = 0; k < x.length; k++) x[k] = rnd() * 0.002;
  for (const c of clicks) { // 1.1 kHz blip, 50 ms
    const s = Math.round(c * SR);
    for (let k = 0; k < 0.05 * SR && s + k < x.length; k++) x[s + k] += 0.1 * Math.sin((2 * Math.PI * 1100 * k) / SR) * Math.exp(-k / (0.01 * SR));
  }
  for (const t of strums) { // six strings 4 ms apart, each a noisy pluck ringing at its pitch
    [82, 110, 147, 196, 247, 330].forEach((hz, n) => {
      const s = Math.round((t + n * 0.004) * SR);
      for (let k = 0; k < 0.6 * SR && s + k < x.length; k++) {
        const env = Math.exp(-k / (0.15 * SR));
        const attack = k < 0.003 * SR ? rnd() * 0.3 : 0;
        x[s + k] += env * (0.08 * Math.sin((2 * Math.PI * hz * k) / SR) + attack);
      }
    });
  }
  return x;
}
function detect(x, minDb) {
  const det = createOnsetDetector({ hop: HOP / SR, minDb });
  const found = [];
  let prev = 0;
  for (let k = 0; k + HOP <= x.length; k += HOP) {
    const block = x.subarray(k, k + HOP);
    const t = det.push(blockDb(block, prev), k / SR);
    prev = block[HOP - 1];
    if (t !== null) found.push(t);
  }
  return found;
}

const strumAt = ex.map((e, k) => e.t + [0, 0.012, -0.02, 0.03, 0.005, -0.008][k % 6]);
const clicks = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5];
const x = render(5.5, strumAt, clicks);

// The click alone is heard as onsets (that's why there's a level gate set above it).
const clickOnly = detect(render(5.5, [], clicks), -120);
assert.ok(clickOnly.length >= 6, `click heard without the gate: ${clickOnly.length}`);
// Measure the click's level, then gate above it: only strums remain.
let clickDb = -120;
{ const c = render(5.5, [], clicks); let prev = 0; for (let k = 0; k + HOP <= c.length; k += HOP) { clickDb = Math.max(clickDb, blockDb(c.subarray(k, k + HOP), prev)); prev = c[k + HOP - 1]; } }
const heard = detect(x, clickDb + 6);
assert.equal(heard.length, strumAt.length, `every strum once: heard ${heard.length}`);
heard.forEach((t, k) => assert.ok(Math.abs(t - strumAt[k]) < 0.004, `strum ${k} at ${t.toFixed(4)}, played ${strumAt[k].toFixed(4)}`));

// Scoring: offsets in ms, plus is late.
const sc = scoreStrums(ex, heard);
assert.equal(sc.missed, 0);
assert.equal(sc.extras, 0);
const offs = sc.strums.map((s) => s.offset);
offs.forEach((o, k) => assert.ok(Math.abs(o - [0, 12, -20, 30, 5, -8][k % 6] * 1) <= 4, `offset ${k}: ${o}`));
assert.ok(sc.onTime >= 80, `on time ${sc.onTime}`);

// Latency is taken off before scoring.
const late = scoreStrums(ex, heard.map((t) => t + 0.12), { latency: 0.12 });
assert.deepEqual(late.strums.map((s) => s.offset), offs);

// Missed and extra strums.
const gappy = scoreStrums(ex, [...heard.slice(2), 3.4]);
assert.equal(gappy.missed, 2);
assert.equal(gappy.extras, 1, 'a strum far from any due strum is an extra');

// Summary numbers.
const s = summary([{ offset: 40 }, { offset: 50 }, { offset: 45 }, { offset: null }]);
assert.equal(s.mean, 45);
assert.equal(s.missed, 1);
assert.equal(s.onTime, 0);
assert.match(verdict(s), /behind/);
assert.match(verdict({ mean: -40, spread: 10, onTime: 20, missed: 0 }), /rushing/);
assert.match(verdict({ mean: 2, spread: 8, onTime: 95, missed: 0 }), /faster/);

// Loopback latency: median lag from click to what the mic heard.
assert.ok(Math.abs(loopbackLatency([1, 2, 3, 4], [1.1, 2.12, 3.1, 4.09]) - 0.1) < 1e-9);
assert.equal(loopbackLatency([1, 2, 3, 4], [9]), null, 'speaker not heard: no answer');

// Tempo steps.
assert.equal(nextBpm(80, 90), 85);
assert.equal(nextBpm(80, 70), 80);
assert.equal(nextBpm(80, 30), 75);
assert.equal(nextBpm(218, 99), 220);

console.log('strumcore tests passed');
