// Strum timing: the patterns, when each strum is due, finding strums in the mic signal,
// and scoring how early or late each one was. No DOM or audio here, so it can be tested.

/** Worship strum patterns. `slots` is one bar: D down, U up, - no strum. `sub` slots per beat. */
export const PATTERNS = [
  { id: 'quarters', name: 'Quarter downs', beats: 4, sub: 1, slots: 'DDDD' },
  { id: 'eighths', name: 'Straight eighths', beats: 4, sub: 2, slots: 'DUDUDUDU' },
  { id: 'island', name: 'Worship strum (D - D U - U D U)', beats: 4, sub: 2, slots: 'D-DU-UDU' },
  { id: 'push', name: 'Driving downs with an up push', beats: 4, sub: 2, slots: 'D-D-D-DU' },
  { id: 'halftime', name: 'Half-time ballad (D - - U D U)', beats: 4, sub: 2, slots: 'D--UD-DU' },
  { id: 'sixteenths', name: 'Sixteenth groove (D - D U each beat)', beats: 4, sub: 4, slots: 'D-DUD-DUD-DUD-DU' },
  { id: 'waltz', name: '3/4 (D - D U D U)', beats: 3, sub: 2, slots: 'D-DUDU' },
  { id: 'six8', name: '6/8 (D D U D D U)', beats: 6, sub: 1, slots: 'DDUDDU' },
];

/** Every strum due in `bars` bars from `start` (seconds): [{ t, stroke, bar, slot }]. */
export function expectedStrums(pattern, bpm, start, bars) {
  const slotSec = 60 / bpm / pattern.sub;
  const out = [];
  for (let bar = 0; bar < bars; bar++) {
    [...pattern.slots].forEach((stroke, slot) => {
      if (stroke === '-') return;
      out.push({ t: start + (bar * pattern.slots.length + slot) * slotSec, stroke, bar, slot });
    });
  }
  return out;
}

/** Bar length in seconds. */
export const barSeconds = (pattern, bpm) => (60 / bpm) * pattern.beats;

/**
 * Finds strum starts in a stream of short-window energies (one per `hop` seconds, in dB).
 * A strum is a quick rise (`rise` dB within `look` hops) above both the room's noise floor
 * plus `gate` dB and `minDb` (set above the click's own loudness so the speaker click is not a strum).
 */
export function createOnsetDetector({ hop, rise = 9, look = 6, gate = 14, minDb = -70, refractory = 0.07 } = {}) {
  const back = new Float64Array(look + 1).fill(-120);
  let i = 0;
  let floor = -90;
  let last = -Infinity;
  return {
    get floor() { return floor; },
    set minDb(v) { minDb = v; },
    /** One energy value (dB) for the window starting at `time` s. Returns that strum's time, or null. */
    push(db, time) {
      const old = back[i % (look + 1)];
      // the oldest of the last few windows, and the lowest: the rise is measured from the quiet before it
      let low = Infinity;
      for (const v of back) low = Math.min(low, v);
      back[i % (look + 1)] = db;
      i++;
      // noise floor: falls fast, climbs slowly (a ringing chord isn't the floor)
      floor = db < floor ? floor + (db - floor) * 0.3 : floor + (db - floor) * 0.002;
      if (i <= look) return null;
      if (time - last < refractory) return null;
      if (db < floor + gate || db < minDb) return null;
      if (db - Math.min(low, old) < rise) return null;
      last = time;
      return time;
    },
  };
}

/** Energy in dB of one block, after a first difference that brings out pick and strum attacks. */
export function blockDb(samples, prev = 0) {
  let sum = 0;
  let p = prev;
  for (let k = 0; k < samples.length; k++) {
    const d = samples[k] - p;
    p = samples[k];
    sum += d * d;
  }
  return 10 * Math.log10(sum / Math.max(1, samples.length) + 1e-12);
}

/**
 * Matches strums to the strums due. Each heard strum goes to the nearest due strum within `win`
 * seconds (default: under half a slot, at most 0.15 s). Offsets are in ms, plus is late.
 */
export function scoreStrums(expected, heard, { win = 0.15, latency = 0 } = {}) {
  const times = heard.map((t) => t - latency).sort((a, b) => a - b);
  const result = expected.map((e) => ({ ...e, offset: null }));
  const used = new Set();
  let extras = 0;
  for (const t of times) {
    let best = -1;
    let bestD = Infinity;
    result.forEach((e, k) => {
      const d = Math.abs(t - e.t);
      if (d < bestD && d <= win && !used.has(k)) { best = k; bestD = d; }
    });
    if (best < 0) { extras++; continue; }
    used.add(best);
    result[best].offset = Math.round((t - result[best].t) * 1000);
  }
  return { strums: result, extras, ...summary(result, extras) };
}

/** mean (rushing/dragging), spread (steadiness), share within ±30 ms, missed and extra strums. */
export function summary(strums, extras = 0) {
  const offs = strums.map((s) => s.offset).filter((o) => o !== null);
  const n = offs.length;
  const mean = n ? offs.reduce((a, b) => a + b, 0) / n : 0;
  const spread = n > 1 ? Math.sqrt(offs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const tight = offs.filter((o) => Math.abs(o) <= 30).length;
  const total = strums.length;
  return {
    mean: Math.round(mean),
    spread: Math.round(spread),
    onTime: total ? Math.round((100 * tight) / total) : 0,
    missed: total - n,
    extras,
    total,
  };
}

/** How the round went, in a few words. */
export function verdict({ mean, spread, onTime, missed, total = 0 }) {
  if (onTime >= 85) return 'Locked in. Try 5 BPM faster.';
  if (missed > total / 4) return 'Some strums weren’t heard. Strum harder or move closer to the mic.';
  if (Math.abs(mean) > 25 && spread < 30) return mean > 0 ? 'Steady, but behind the beat. Strum a little earlier.' : 'Steady, but ahead of the beat (rushing). Relax and wait for the click.';
  if (spread >= 30) return 'Uneven timing. Slow down until it feels easy.';
  return 'Close. Keep your hand moving down and up even on the gaps.';
}

/** Round latency from a speaker loopback: median of (heard − click) for heards 0–0.4 s after a click. */
export function loopbackLatency(clicks, heard) {
  const lags = [];
  for (const c of clicks) {
    const h = heard.find((t) => t - c >= 0 && t - c <= 0.4);
    if (h !== undefined) lags.push(h - c);
  }
  if (lags.length < Math.ceil(clicks.length / 2)) return null;
  lags.sort((a, b) => a - b);
  return lags[Math.floor(lags.length / 2)];
}

/** Next round's tempo: up `step` after a clean round (≥ 85% on time), down `step` after a messy one (< 50%). */
export function nextBpm(bpm, onTime, { step = 5, min = 40, max = 220 } = {}) {
  if (onTime >= 85) return Math.min(max, bpm + step);
  if (onTime < 50) return Math.max(min, bpm - step);
  return bpm;
}
