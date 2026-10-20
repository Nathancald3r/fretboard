// Amp simulator building blocks that don't need a browser: distortion curves, cabinet
// and reverb impulse responses (generated here, no downloaded files), the built-in
// presets and settings validation. js/amp.js wires these into a Web Audio graph.

export const CHARACTERS = {
  // k: how hard the curve bends; preHP tightens the low end before the clipper;
  // preMid is a mid hump before clipping (like a Tube Screamer in front of the amp).
  clean: { label: 'Clean', k: 1.4, asym: 0, preHP: 60, preMid: 0, driveDb: 2.4 },
  crunch: { label: 'Crunch', k: 3, asym: 0.25, preHP: 90, preMid: 3, driveDb: 4 },
  highgain: { label: 'High gain', k: 6, asym: 0.1, preHP: 140, preMid: 6, driveDb: 4.6 },
};

// Cabinet voicings: [filter type, frequency, gain dB, Q] applied to an impulse.
export const CABINETS = {
  '4x12': {
    label: '4×12 closed back',
    early: [[0.00035, 0.35], [0.0009, 0.2], [0.0016, 0.1]],
    filters: [['highpass', 75, 0, 0.7], ['peaking', 110, 4, 1.2], ['peaking', 420, -2.5, 1], ['peaking', 2200, 3, 1.4], ['lowpass', 4800, 0, 0.9], ['lowpass', 6200, 0, 0.7]],
  },
  '2x12': {
    label: '2×12 open back',
    early: [[0.0004, 0.25], [0.0012, 0.12]],
    filters: [['highpass', 90, 0, 0.7], ['peaking', 140, 1.5, 1], ['peaking', 1800, 2.5, 1.2], ['peaking', 3200, 2, 1.5], ['lowpass', 5600, 0, 0.8], ['lowpass', 7600, 0, 0.7]],
  },
  '1x12': {
    label: '1×12 combo',
    early: [[0.0003, 0.3], [0.0008, 0.15]],
    filters: [['highpass', 100, 0, 0.7], ['peaking', 250, 1, 1], ['peaking', 1200, 2, 1], ['peaking', 2800, 3.5, 1.6], ['lowpass', 5000, 0, 0.9], ['lowpass', 7000, 0, 0.7]],
  },
  off: { label: 'No cabinet (direct)' },
};

export const dbToGain = (db) => 10 ** (db / 20);

// Waveshaper curve over input -1..1. Saturates by the ends, so a signal pushed past ±1
// by the drive stage just stays clipped.
export function makeCurve(character, n = 4096) {
  const c = CHARACTERS[character] || CHARACTERS.clean;
  const curve = new Float32Array(n);
  const norm = Math.tanh(c.k);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    // A little asymmetry (the negative half clips softer) adds even harmonics, like a tube.
    const k = x < 0 ? c.k * (1 - c.asym) : c.k;
    curve[i] = Math.tanh(k * x) / (x < 0 ? Math.tanh(k) : norm);
  }
  return curve;
}

// Pre-gain into the clipper (linear) and the make-up gain after it, so cranking the drive
// gets more saturated without getting much louder.
export function driveGains(character, drive) {
  const c = CHARACTERS[character] || CHARACTERS.clean;
  const preDb = drive * c.driveDb;
  return { pre: dbToGain(preDb), post: dbToGain(-0.45 * preDb) };
}

// RBJ cookbook biquad, used to shape the generated impulse responses.
function biquad(type, freq, gainDb, q, sampleRate) {
  const w = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const A = 10 ** (gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; }
  else if (type === 'highpass') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; }
  else { b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; } // peaking
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function filterInPlace(data, f) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    data[i] = y;
  }
}

// Small deterministic random generator so the impulse responses are the same every time.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Speaker cabinet impulse response: an impulse, a few early box reflections and a short
// noisy tail, then the cabinet's frequency response. Normalized to unit energy.
export function makeCabinetIR(name, sampleRate) {
  const cab = CABINETS[name];
  if (!cab?.filters) return null;
  const len = Math.round(sampleRate * 0.04);
  const data = new Float32Array(len);
  data[0] = 1;
  for (const [t, g] of cab.early) data[Math.round(t * sampleRate)] += g;
  const rand = rng(name.length * 977 + 13);
  const tail = Math.round(sampleRate * 0.006);
  for (let i = 1; i < tail; i++) data[i] += (rand() * 2 - 1) * 0.08 * Math.exp(-i / (tail / 4));
  for (const [type, freq, gain, q] of cab.filters) filterInPlace(data, biquad(type, freq, gain, q, sampleRate));
  let energy = 0;
  for (const v of data) energy += v * v;
  const scale = 1 / Math.sqrt(energy || 1);
  // Fade the last 20% so the truncation doesn't click.
  const fade = Math.round(len * 0.2);
  for (let i = 0; i < len; i++) data[i] *= scale * (i > len - fade ? (len - i) / fade : 1);
  return data;
}

// Stereo room reverb: decaying noise that gets darker as it fades.
export function makeReverbIR(sampleRate, seconds = 2.2) {
  const len = Math.round(sampleRate * seconds);
  const out = [new Float32Array(len), new Float32Array(len)];
  out.forEach((data, ch) => {
    const rand = rng(1234 + ch * 7919);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // One-pole lowpass whose cutoff falls over time (high frequencies die first).
      const a = 0.25 + 0.7 * t;
      lp = lp * a + (rand() * 2 - 1) * (1 - a);
      data[i] = lp * Math.exp(-t * 6) * (i < sampleRate * 0.012 ? i / (sampleRate * 0.012) : 1);
    }
    let energy = 0;
    for (const v of data) energy += v * v;
    const scale = 0.5 / Math.sqrt(energy || 1);
    for (let i = 0; i < len; i++) data[i] *= scale;
  });
  return out;
}

// Every setting, with its range. Sliders in the UI are built from this list.
export const PARAMS = [
  { key: 'input', label: 'Input', min: -24, max: 24, step: 0.5, unit: 'dB', def: 0, title: 'Input gain: aim for the meter peaking in the yellow, not red' },
  { key: 'gate', label: 'Gate', min: -100, max: -30, step: 1, unit: 'dB', def: -70, title: 'Noise gate threshold. Far left is off; raise it until the hiss between notes stops' },
  { key: 'drive', label: 'Drive', min: 0, max: 10, step: 0.1, unit: '', def: 3 },
  { key: 'bass', label: 'Bass', min: -12, max: 12, step: 0.5, unit: 'dB', def: 0 },
  { key: 'mid', label: 'Mid', min: -12, max: 12, step: 0.5, unit: 'dB', def: 0 },
  { key: 'treble', label: 'Treble', min: -12, max: 12, step: 0.5, unit: 'dB', def: 0 },
  { key: 'presence', label: 'Presence', min: -12, max: 12, step: 0.5, unit: 'dB', def: 0 },
  { key: 'delayMix', label: 'Delay', min: 0, max: 1, step: 0.01, unit: '%', def: 0 },
  { key: 'delayTime', label: 'Delay time', min: 60, max: 1000, step: 5, unit: 'ms', def: 350 },
  { key: 'delayFeedback', label: 'Repeats', min: 0, max: 0.85, step: 0.01, unit: '%', def: 0.3 },
  { key: 'reverb', label: 'Reverb', min: 0, max: 1, step: 0.01, unit: '%', def: 0.15 },
  { key: 'master', label: 'Master', min: -40, max: 6, step: 0.5, unit: 'dB', def: -6 },
];

export const DEFAULTS = {
  character: 'crunch', cabinet: '4x12',
  ...Object.fromEntries(PARAMS.map((p) => [p.key, p.def])),
};

// Fill in missing values and clamp everything into range (saved presets may come from an
// older version of the app).
export function normalizeSettings(s = {}) {
  const out = { ...DEFAULTS };
  if (CHARACTERS[s.character]) out.character = s.character;
  if (CABINETS[s.cabinet]) out.cabinet = s.cabinet;
  for (const p of PARAMS) {
    const v = Number(s[p.key]);
    if (s[p.key] !== undefined && s[p.key] !== null && Number.isFinite(v)) out[p.key] = Math.min(p.max, Math.max(p.min, v));
  }
  return out;
}

const preset = (id, name, s) => ({ id, name, builtIn: true, settings: normalizeSettings(s) });

export const BUILT_IN_PRESETS = [
  preset('b:clean', 'Clean', { character: 'clean', cabinet: '2x12', input: 0, gate: -72, drive: 2, bass: 2, mid: 0, treble: 2, presence: 1, reverb: 0.25, delayMix: 0, master: -8 }),
  preset('b:edge', 'Edge of breakup', { character: 'crunch', cabinet: '1x12', gate: -68, drive: 3.2, bass: 1, mid: 1, treble: 1, presence: 0, reverb: 0.18, delayMix: 0, master: -5 }),
  preset('b:crunch', 'Classic rock crunch', { character: 'crunch', cabinet: '4x12', gate: -62, drive: 6, bass: 1, mid: 3, treble: 2, presence: 2, reverb: 0.12, delayMix: 0, master: -6 }),
  preset('b:80s', '80s lead', { character: 'highgain', cabinet: '4x12', gate: -58, drive: 6.5, bass: 0, mid: 4, treble: 2, presence: 3, delayMix: 0.3, delayTime: 380, delayFeedback: 0.35, reverb: 0.3, master: -7 }),
  preset('b:modern', 'Modern high gain', { character: 'highgain', cabinet: '4x12', gate: -50, drive: 8.5, bass: 4, mid: -4, treble: 3, presence: 3, reverb: 0.08, delayMix: 0, master: -5 }),
  preset('b:blues', 'Blues', { character: 'crunch', cabinet: '1x12', gate: -66, drive: 4.5, bass: 1, mid: 4, treble: -1, presence: -1, reverb: 0.22, delayMix: 0.12, delayTime: 300, delayFeedback: 0.2, master: -5 }),
];
