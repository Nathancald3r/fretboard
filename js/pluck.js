// A small plucked-string synth (Karplus–Strong) for hearing chords and notes in the
// Chords & keys view. Strings are rendered once per pitch and cached.
import { STANDARD } from './theory.js';

let ctx = null;
let out = null;
const cache = new Map();

function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    // Soften the top end so it sounds like a nylon/clean steel string, not a buzz.
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 3800;
    lowpass.Q.value = 0.5;
    out = ctx.createGain();
    out.gain.value = 0.6;
    out.connect(lowpass).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// The delay line is a whole number of samples; playbackRate corrects the pitch exactly.
function render(midi) {
  if (cache.has(midi)) return cache.get(midi);
  const sr = ctx.sampleRate;
  const freq = 440 * 2 ** ((midi - 69) / 12);
  const n = Math.max(2, Math.round(sr / freq));
  const length = Math.round(sr * 2.6);
  const buffer = ctx.createBuffer(1, length, sr);
  const data = buffer.getChannelData(0);
  const ring = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) { prev = prev * 0.5 + (Math.random() * 2 - 1) * 0.5; ring[i] = prev; } // pre-smoothed pick noise
  const decay = 0.996 - Math.max(0, midi - 60) * 0.0004; // high notes die away faster
  for (let i = 0; i < length; i++) {
    const j = i % n;
    data[i] = ring[j];
    ring[j] = decay * 0.5 * (ring[j] + ring[(j + 1) % n]);
  }
  const entry = { buffer, rate: (freq * n) / sr };
  cache.set(midi, entry);
  return entry;
}

function play(midi, when, gain = 0.5) {
  const { buffer, rate } = render(midi);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(out);
  src.start(when);
}

/** Strums a voicing (frets low E → high e, -1 = muted). delay: seconds from now. */
export function strum(frets, { delay = 0, down = true, spread = 0.028 } = {}) {
  const c = audio();
  const strings = frets.map((f, s) => [f, s]).filter(([f]) => f >= 0);
  if (!down) strings.reverse();
  strings.forEach(([f, s], i) => play(STANDARD[s] + f, c.currentTime + delay + i * spread, 0.32));
}

export function pluckNote(string, fret) {
  const c = audio();
  play(STANDARD[string] + fret, c.currentTime, 0.6);
}

/** Short beep for timers. */
export function beep(freq = 880, length = 0.12) {
  const c = audio();
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.25, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + length);
  osc.connect(g).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + length);
}

export const now = () => audio().currentTime;
