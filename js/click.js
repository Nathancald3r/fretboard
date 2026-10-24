// Click track and count-in.
// - The click is written into the song's MIDI (on a channel of its own), so it stays
//   sample-exact with the music at any speed, with any subdivision and accents.
// - The count-in plays before the song starts, from a small Web Audio synth. The delay
//   between asking alphaTab to play and hearing it is measured on every start and used
//   to line the first note up with the end of the count-in.
// The pure parts (settings, event lists) have tests in tests/click.test.mjs.

const KEY = 'fretboard-click';

// Click sounds through the song's synth: a General MIDI program and the notes for the
// accent (beat 1), the other beats and the subdivisions. 'classic' is alphaTab's own
// metronome (quarter notes only).
export const CLICK_SOUNDS = {
  woodblock: { label: 'Woodblock', program: 115, keys: [79, 72, 72] },
  beep: { label: 'Beep', program: 80, keys: [96, 84, 84], short: true },
  cowbell: { label: 'Cowbell', program: 113, keys: [76, 69, 69] },
  bell: { label: 'Bell', program: 112, keys: [88, 81, 81] },
  tom: { label: 'Synth tom', program: 118, keys: [62, 55, 55] },
  classic: { label: 'Classic metronome', program: -1 },
};

// Count-in sounds (Web Audio).
export const COUNT_SOUNDS = {
  woodblock: 'Woodblock', sticks: 'Drum sticks', beep: 'Beep', cowbell: 'Cowbell', voice: 'Voice (1, 2, 3, 4)',
  classic: 'Classic (alphaTab, 1 bar)',
};

export const SUBDIVISIONS = { 1: 'Quarter notes', 2: '8th notes', 3: 'Triplets', 4: '16th notes' };
export const COUNT_LENGTHS = { 0.5: 'Half a bar', 1: '1 bar', 2: '2 bars' };

export const DEFAULTS = {
  sound: 'woodblock', volume: 0.8, sub: 1, accent: true,
  countSound: 'sticks', countVolume: 0.8, countBars: 1, countSub: 1,
};

export function loadClickSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    return sanitize({ ...DEFAULTS, ...saved });
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveClickSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function sanitize(s) {
  const out = { ...DEFAULTS, ...s };
  if (!CLICK_SOUNDS[out.sound]) out.sound = DEFAULTS.sound;
  if (!COUNT_SOUNDS[out.countSound]) out.countSound = DEFAULTS.countSound;
  if (!SUBDIVISIONS[out.sub]) out.sub = 1;
  if (!SUBDIVISIONS[out.countSub]) out.countSub = 1;
  if (!COUNT_LENGTHS[out.countBars]) out.countBars = 1;
  out.volume = Math.max(0, Math.min(1.5, Number(out.volume) || 0));
  out.countVolume = Math.max(0, Math.min(1.5, Number(out.countVolume) || 0));
  out.sub = Number(out.sub); out.countSub = Number(out.countSub); out.countBars = Number(out.countBars);
  return out;
}

/** The built-in count-in can do exactly one bar of quarter notes. */
export const usesClassicCountIn = (s) => s.countSound === 'classic';
export const usesClassicClick = (s) => s.sound === 'classic';

/**
 * Click notes for bars in playback order.
 * bars: [{ start, end, num, den }] in MIDI ticks (960 per quarter note).
 * Returns [{ tick, level }] where level is 0 = accent, 1 = beat, 2 = subdivision.
 */
export function clickEvents(bars, { sub = 1, accent = true } = {}) {
  const out = [];
  for (const b of bars) {
    const beatTicks = (960 * 4) / (b.den || 4);
    const step = beatTicks / sub;
    for (let t = b.start, i = 0; t < b.end - 1; t += step, i++) {
      const onBeat = i % sub === 0;
      const level = onBeat ? (i === 0 && accent ? 0 : 1) : 2;
      out.push({ tick: Math.round(t), level });
    }
  }
  return out;
}

/**
 * Count-in clicks before the song: [{ at (seconds from the first click), level, count }]
 * plus the total length. beatSeconds is one beat (the time signature's denominator) at
 * the playing speed. count = the spoken number for beats, 0 for subdivisions.
 */
export function countInPlan({ num = 4, den = 4, beatSeconds, bars = 1, sub = 1 }) {
  // Fast 6/8, 9/8, 12/8: count the dotted-quarter pulse, like a drummer would. Slower (an eighth
  // of more than 0.25 s), two counts a bar leave too long a gap, so every eighth is counted: 1 to 6.
  const compound = den === 8 && num % 3 === 0 && num > 3 && beatSeconds <= 0.25;
  const pulse = compound ? 3 : 1;
  const beats = Math.max(1, Math.round((num / pulse) * bars));
  const pulseSeconds = beatSeconds * pulse;
  const step = pulseSeconds / sub;
  const clicks = [];
  for (let i = 0; i < beats * sub; i++) {
    const onBeat = i % sub === 0;
    const beatNo = Math.floor(i / sub);
    clicks.push({ at: i * step, level: onBeat ? (beatNo % (num / pulse) === 0 ? 0 : 1) : 2, count: onBeat ? (beatNo % (num / pulse)) + 1 : 0 });
  }
  return { clicks, length: beats * pulseSeconds };
}

/* ---------- Web Audio count-in ---------- */

let ctx = null;
function audio() {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

let noise = null;
function noiseBuffer(c) {
  if (noise) return noise;
  noise = c.createBuffer(1, c.sampleRate * 0.2, c.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

function envelope(c, t, peak, decay, dest) {
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  g.connect(dest);
  return g;
}

function tone(c, t, freq, type, peak, decay, dest) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.connect(envelope(c, t, peak, decay, dest));
  o.start(t);
  o.stop(t + decay + 0.02);
}

function hiss(c, t, filterType, freq, q, peak, decay, dest) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const f = c.createBiquadFilter();
  f.type = filterType; f.frequency.value = freq; f.Q.value = q;
  src.connect(f).connect(envelope(c, t, peak, decay, dest));
  src.start(t);
  src.stop(t + decay + 0.02);
}

const SPOKEN = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

// One count-in click at audio time t. level 0 = accent, 1 = beat, 2 = subdivision.
function playCount(c, sound, t, level, volume, count) {
  const out = c.createGain();
  out.gain.value = volume * (level === 0 ? 1 : level === 1 ? 0.75 : 0.45);
  out.connect(c.destination);
  if (sound === 'woodblock') {
    const f = level === 0 ? 1900 : level === 1 ? 1500 : 1300;
    tone(c, t, f, 'sine', 0.9, 0.06, out);
    hiss(c, t, 'bandpass', f, 6, 0.6, 0.03, out);
  } else if (sound === 'sticks') {
    hiss(c, t, 'bandpass', level === 0 ? 3200 : 2600, 3, 1.2, 0.05, out);
    tone(c, t, level === 0 ? 2100 : 1700, 'triangle', 0.25, 0.03, out);
  } else if (sound === 'beep') {
    tone(c, t, level === 0 ? 1760 : level === 1 ? 1320 : 1100, 'square', 0.18, 0.05, out);
  } else if (sound === 'cowbell') {
    const g = c.createBiquadFilter();
    g.type = 'bandpass'; g.frequency.value = 2600; g.Q.value = 1.2;
    g.connect(out);
    const decay = level === 0 ? 0.35 : 0.22;
    tone(c, t, 540, 'square', 0.35, decay, g);
    tone(c, t, 800, 'square', 0.35, decay, g);
  } else if (sound === 'voice') {
    // Spoken numbers on the beats (ticks on subdivisions). Speech can't be scheduled
    // precisely, so a soft tick keeps the exact time under it.
    tone(c, t, level === 0 ? 1500 : 1200, 'sine', level === 2 ? 0.5 : 0.35, 0.04, out);
    if (count && window.speechSynthesis) {
      const ms = Math.max(0, (t - c.currentTime) * 1000 - 60);
      setTimeout(() => {
        const u = new SpeechSynthesisUtterance(SPOKEN[count] || String(count));
        u.rate = 1.6; u.volume = Math.min(1, volume);
        speechSynthesis.speak(u);
      }, ms);
    }
  }
}

/**
 * A whole click track as one stereo AudioBuffer (for playing along with a video, where the synth
 * is silent). hits: [{ t: seconds, level }]. Each level's sound is rendered once and copied to
 * every hit, so a long song takes a few milliseconds.
 */
export async function clickTrackBuffer(ctx, hits, sound, seconds) {
  const s = COUNT_SOUNDS[sound] && sound !== 'classic' && sound !== 'voice' ? sound : 'woodblock';
  const rate = ctx.sampleRate;
  const one = await Promise.all([0, 1, 2].map(async (level) => {
    const off = new OfflineAudioContext(1, Math.round(rate * 0.4), rate);
    playCount(off, s, 0, level, 1);
    return (await off.startRendering()).getChannelData(0);
  }));
  const buf = ctx.createBuffer(2, Math.max(1, Math.round(seconds * rate)), rate);
  const L = buf.getChannelData(0);
  for (const { t, level } of hits) {
    const at = Math.round(t * rate);
    const src = one[level] || one[1];
    if (at < 0) continue;
    for (let i = 0, n = Math.min(src.length, L.length - at); i < n; i++) L[at + i] += src[i];
  }
  buf.getChannelData(1).set(L);
  return buf;
}

/** A short preview of a count-in or click sound. */
export function previewSound(sound, volume = 0.8) {
  const c = audio();
  const t = c.currentTime + 0.05;
  const s = COUNT_SOUNDS[sound] && sound !== 'classic' ? sound : 'woodblock';
  [0, 1, 1, 1].forEach((level, i) => playCount(c, s, t + i * 0.35, level, volume, i + 1));
}

/**
 * Plays the count-in and calls start() early enough (by `lag` seconds, the measured delay
 * of the player) that the song's first note lands where the next beat would be.
 * Returns a cancel function.
 */
export function runCountIn({ settings, num, den, beatSeconds, lag, start, onBeat }) {
  const c = audio();
  const plan = countInPlan({ num, den, beatSeconds, bars: settings.countBars, sub: settings.countSub });
  const t0 = c.currentTime + 0.08;
  for (const k of plan.clicks) playCount(c, settings.countSound, t0 + k.at, k.level, settings.countVolume, k.count);
  const timers = [];
  // Audio time → wall clock: schedule start() (and the beat callbacks) with setTimeout.
  const wallOf = (t) => (t - c.currentTime) * 1000;
  const startIn = Math.max(0, wallOf(t0 + plan.length) - lag * 1000);
  timers.push(setTimeout(start, startIn));
  if (onBeat) for (const k of plan.clicks) if (k.count) timers.push(setTimeout(() => onBeat(k.count), Math.max(0, wallOf(t0 + k.at))));
  return () => {
    timers.forEach(clearTimeout);
    // Silence anything already scheduled.
    c.suspend().then(() => { ctx = null; c.close(); });
  };
}
