// Singing mode, the browser-free part: pitch detection (YIN), cents math, the vocal
// melody timeline from an alphaTab score, and scoring. Tested in tests/sing.test.mjs.

export const TOLERANCE = 50; // cents either side that count as "in tune"

export const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);
export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiName = (midi) => {
  const m = Math.round(midi);
  return NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
};

// YIN pitch detector (de Cheveigné & Kawahara 2002). Returns { hz, clarity, rms } or null
// when the frame is too quiet or has no clear pitch. clarity is 1 - the normalized
// difference at the chosen period (1 = perfectly periodic).
export function detectPitch(buf, sampleRate, { minHz = 70, maxHz = 1100, threshold = 0.15, minRms = 0.01 } = {}) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  if (rms < minRms) return null;

  const W = Math.floor(buf.length / 2);
  const maxTau = Math.min(W - 1, Math.ceil(sampleRate / minHz));
  const minTau = Math.max(2, Math.floor(sampleRate / maxHz));
  if (maxTau <= minTau) return null;

  // Difference function, then the cumulative mean normalized difference.
  const d = new Float32Array(maxTau + 2);
  for (let tau = 1; tau <= maxTau + 1; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const diff = buf[i] - buf[i + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }
  d[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau + 1; tau++) {
    running += d[tau];
    d[tau] = running ? (d[tau] * tau) / running : 1;
  }

  // First dip under the threshold (walked down to its bottom); otherwise the deepest dip.
  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) {
    if (d[t] < threshold) {
      while (t + 1 <= maxTau && d[t + 1] < d[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau === -1) {
    let best = minTau;
    for (let t = minTau; t <= maxTau; t++) if (d[t] < d[best]) best = t;
    if (d[best] > 0.35) return null; // noise, breath or a chord: no single pitch
    tau = best;
  }

  // Parabolic interpolation around the dip for sub-sample accuracy.
  const a = d[tau - 1], b = d[tau], c = d[tau + 1];
  const den = a - 2 * b + c;
  const shift = den > 0 ? Math.max(-1, Math.min(1, (a - c) / (2 * den))) : 0;
  return { hz: sampleRate / (tau + shift), clarity: Math.max(0, 1 - b), rms };
}

// How far a sung pitch is from the target, in cents. Octave errors are folded away: a
// singer an octave (or two) below or above the written note is singing the right note
// (men singing a part written for a high voice, or the detector locking on a harmonic),
// so `cents` is the distance to the nearest octave of the target and `octaves` says how
// many octaves off it was.
export function compare(sungMidi, targetMidi) {
  const raw = (sungMidi - targetMidi) * 100;
  const octaves = Math.round(raw / 1200);
  const cents = raw - octaves * 1200;
  return { cents, octaves, raw };
}

export function judge(sungMidi, targetMidi, tolerance = TOLERANCE) {
  const c = compare(sungMidi, targetMidi);
  const status = Math.abs(c.cents) <= tolerance ? 'in' : c.cents < 0 ? 'flat' : 'sharp';
  return { ...c, status };
}

// Pitch trainer: the scales you can practise in (Chromatic = every semitone counts).
export const CHROMATIC = 'Chromatic';

// The note of the key/scale nearest to a sung pitch: { midi, degree } where degree is the
// scale step (0-based). `intervals` are semitones above the tonic (pitch class 0–11).
export function nearestScaleNote(sungMidi, tonic, intervals) {
  const steps = intervals?.length ? intervals : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  let best = null;
  const base = Math.floor(sungMidi / 12) * 12;
  for (const octave of [base - 12, base, base + 12]) {
    steps.forEach((iv, degree) => {
      const midi = octave + ((tonic + iv) % 12);
      const d = Math.abs(sungMidi - midi);
      if (!best || d < best.d) best = { midi, degree, d };
    });
  }
  return { midi: best.midi, degree: best.degree };
}

// Collects in-tune time while singing freely against a key (no song): what share of the
// time you were singing you were within the tolerance of a note of the scale.
export function createFreeScorer({ tolerance = TOLERANCE } = {}) {
  let t = { voiced: 0, inTune: 0, flat: 0, sharp: 0 };
  return {
    add({ cents, dt }) {
      if (cents == null || !(dt > 0)) return;
      t.voiced += dt;
      const status = Math.abs(cents) <= tolerance ? 'inTune' : cents < 0 ? 'flat' : 'sharp';
      t[status] += dt;
    },
    summary() {
      const pct = (x) => (t.voiced ? Math.round((x / t.voiced) * 100) : 0);
      return { seconds: t.voiced / 1000, inTune: pct(t.inTune), flat: pct(t.flat), sharp: pct(t.sharp) };
    },
    reset() { t = { voiced: 0, inTune: 0, flat: 0, sharp: 0 }; },
  };
}

// The vocal line of one track in playback order (repeats included): [{ start, end, midi }]
// in absolute MIDI ticks. `bars` is alphaTab's tickCache.masterBars ({ start, masterBar }).
// Chords take their top note (the melody); tied notes extend the note before them.
export function buildMelody(score, trackIndex, bars) {
  const track = score?.tracks?.[trackIndex];
  const staff = track?.staves?.find((s) => !s.isPercussion);
  if (!staff) return [];
  const list = [];
  for (const b of bars || []) {
    const bar = staff.bars[b.masterBar.index];
    const voice = bar?.voices?.[0];
    for (const beat of voice?.beats || []) {
      if (beat.isRest || !beat.notes?.length) continue;
      const notes = beat.notes.filter((n) => !n.isDead);
      if (!notes.length) continue;
      const top = notes.reduce((x, y) => (y.realValue > x.realValue ? y : x));
      const start = b.start + beat.playbackStart;
      const end = start + beat.playbackDuration;
      const prev = list[list.length - 1];
      if (top.isTieDestination && prev && prev.midi === top.realValue && start - prev.end <= 1) {
        prev.end = end;
        continue;
      }
      list.push({ start, end, midi: top.realValue });
    }
  }
  list.forEach((n, i) => { n.index = i; });
  return list;
}

// The note sounding at `tick` (or null between notes). Binary search on start ticks.
export function noteAt(list, tick) {
  let lo = 0, hi = list.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= tick) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const n = list[found];
  return n && tick < n.end ? n : null;
}

// Collects how the singer did over a song or a loop. Each add() is one slice of time
// while a note is written: dt in ms, sung = MIDI pitch (fractional) or null for silence.
// The first moments of every note (onsetMs, at most a third of the note) are left out:
// every singer needs a little time to land on a new note, and the analysis lags too.
export function createScorer({ tolerance = TOLERANCE, onsetMs = 120 } = {}) {
  let t = { total: 0, inTune: 0, flat: 0, sharp: 0, silent: 0, octave: 0, centsSum: 0, voiced: 0 };
  let notes = new Map();

  return {
    add({ note, sung, dt, sinceOnsetMs = Infinity, noteMs = Infinity }) {
      if (!note || !(dt > 0)) return null;
      if (sinceOnsetMs < Math.min(onsetMs, noteMs / 3)) return null;
      const per = notes.get(note.index) || { midi: note.midi, time: 0, inTune: 0 };
      notes.set(note.index, per);
      per.time += dt;
      t.total += dt;
      if (sung == null) { t.silent += dt; return 'silent'; }
      const j = judge(sung, note.midi, tolerance);
      t.voiced += dt;
      t.centsSum += j.cents * dt;
      if (j.status === 'in') {
        t.inTune += dt;
        per.inTune += dt;
        if (j.octaves) t.octave += dt;
      } else t[j.status] += dt;
      return j.status;
    },
    summary() {
      const pct = (x) => (t.total ? Math.round((x / t.total) * 100) : 0);
      const list = [...notes.values()];
      return {
        score: pct(t.inTune),
        inTune: pct(t.inTune),
        flat: pct(t.flat),
        sharp: pct(t.sharp),
        silent: pct(t.silent),
        octave: pct(t.octave),
        notes: list.length,
        notesHit: list.filter((n) => n.inTune >= n.time / 2).length,
        avgCents: t.voiced ? Math.round(t.centsSum / t.voiced) : 0,
        seconds: t.total / 1000,
      };
    },
    reset() {
      t = { total: 0, inTune: 0, flat: 0, sharp: 0, silent: 0, octave: 0, centsSum: 0, voiced: 0 };
      notes = new Map();
    },
  };
}

// One line about how it went, for under the score.
export function describe(s) {
  if (!s.notes) return 'No notes were sung against yet.';
  const parts = [`${s.notesHit} of ${s.notes} notes hit`];
  if (s.flat) parts.push(`${s.flat}% flat`);
  if (s.sharp) parts.push(`${s.sharp}% sharp`);
  if (s.silent) parts.push(`${s.silent}% not sung`);
  if (s.octave) parts.push(`${s.octave}% sung in another octave (counted as in tune)`);
  if (Math.abs(s.avgCents) >= 10) parts.push(`on average ${Math.abs(s.avgCents)}¢ ${s.avgCents < 0 ? 'flat' : 'sharp'}`);
  return parts.join(' · ');
}
