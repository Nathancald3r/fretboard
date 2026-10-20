// Practice mode, the browser-free part: the notes and chords of a track in playback order,
// what was heard in one slice of audio (pitch for single notes, a 12-note "chroma" profile
// for chords), and judging each written note as hit, wrong or missed. Tested in
// tests/judge.test.mjs.
import { compare, hzToMidi, midiName } from './singcore.js';
import { detectChord, chordName } from './chords.js';
import { noteName } from './theory.js';

const pc = (midi) => ((Math.round(midi) % 12) + 12) % 12;

// Every struck note of one track in playback order (repeats included), one event per
// moment: [{ start, end, midis, index }] in absolute MIDI ticks. Tied (held-over) and dead
// notes aren't struck, so they're left out. `bars` is alphaTab's tickCache.masterBars.
export function buildTargets(score, trackIndex, bars) {
  const track = score?.tracks?.[trackIndex];
  const staff = track?.staves?.find((s) => !s.isPercussion);
  if (!staff) return [];
  const list = [];
  for (const b of bars || []) {
    const bar = staff.bars[b.masterBar.index];
    const byStart = new Map();
    for (const voice of bar?.voices || []) {
      for (const beat of voice.beats || []) {
        if (beat.isRest || !beat.notes?.length) continue;
        const notes = beat.notes.filter((n) => !n.isDead && !n.isTieDestination && n.realValue > 0);
        if (!notes.length) continue;
        const start = b.start + beat.playbackStart;
        const ev = byStart.get(start) || { start, end: start, midis: [] };
        ev.end = Math.max(ev.end, start + beat.playbackDuration);
        for (const n of notes) if (!ev.midis.includes(n.realValue)) ev.midis.push(n.realValue);
        byStart.set(start, ev);
      }
    }
    list.push(...[...byStart.values()].sort((x, y) => x.start - y.start));
  }
  list.forEach((ev, i) => { ev.midis.sort((x, y) => x - y); ev.index = i; });
  return list;
}

// What a written moment is called: a note name, or a chord name when the notes spell one.
export function targetLabel(ev) {
  if (!ev) return '–';
  if (ev.midis.length === 1) return midiName(ev.midis[0]);
  const chord = detectChord(ev.midis.map((midi) => ({ midi, weight: 1 })));
  if (chord) return chordName(chord);
  return [...new Set(ev.midis.map(pc))].map((p) => noteName(p)).join(' ');
}

// 12-bin pitch-class profile from an FFT magnitude spectrum in dB (AnalyserNode
// getFloatFrequencyData). Only spectral peaks count, so the skirts of one strong note don't
// leak into its neighbours. Returns { chroma (sums to 1), energy } or null in silence.
export function chromaFromSpectrum(db, sampleRate, { minHz = 60, maxHz = 2200 } = {}) {
  const binHz = sampleRate / (db.length * 2);
  const lo = Math.max(1, Math.floor(minHz / binHz));
  const hi = Math.min(db.length - 2, Math.ceil(maxHz / binHz));
  const chroma = new Array(12).fill(0);
  let energy = 0;
  for (let k = lo; k <= hi; k++) {
    if (!(db[k] > db[k - 1] && db[k] >= db[k + 1])) continue;
    if (db[k] < -85) continue;
    // Interpolated peak frequency.
    const a = db[k - 1], b = db[k], c = db[k + 1];
    const den = a - 2 * b + c;
    const shift = den < 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den))) : 0;
    const hz = (k + shift) * binHz;
    const mag = 10 ** (b / 20);
    const e = mag * mag;
    chroma[pc(hzToMidi(hz))] += e;
    energy += e;
  }
  if (!energy) return null;
  return { chroma: chroma.map((x) => x / energy), energy };
}

// One slice of audio against a written moment: 'hit', 'wrong' or 'quiet'.
// heard = { midi (single detected pitch or null), chroma (array or null), loud (boolean) }.
export function matchFrame(heard, ev) {
  if (!heard?.loud || !ev) return 'quiet';
  const pcs = [...new Set(ev.midis.map(pc))];
  if (pcs.length === 1) {
    // A single note: the detected pitch within 50 cents (any octave: harmonics fool pitch
    // detectors, and bass parts are often read an octave off), or clearly the strongest
    // pitch class when the detector found no single pitch.
    if (heard.midi != null) return Math.abs(compare(heard.midi, ev.midis[0]).cents) <= 50 ? 'hit' : 'wrong';
    const ch = heard.chroma;
    if (ch && ch[pcs[0]] >= 0.3 && ch[pcs[0]] === Math.max(...ch)) return 'hit';
    return 'wrong';
  }
  // A chord: its notes must be clearly there (one may be faint in a chord of four or
  // more), they must make up most of what is heard, and no other note may be as strong.
  const ch = heard.chroma;
  if (!ch) return 'wrong';
  const max = Math.max(...ch);
  const present = pcs.filter((p) => ch[p] >= max * 0.2).length;
  const share = pcs.reduce((s, p) => s + ch[p], 0);
  const foreign = ch.some((v, p) => !pcs.includes(p) && v >= max * 0.5);
  return present >= pcs.length - (pcs.length >= 4 ? 1 : 0) && share >= 0.6 && !foreign ? 'hit' : 'wrong';
}

// Judges a performance against the written moments as playback moves on. frame() gets the
// current (latency-corrected) tick, ms per tick and the frame's match result per moment;
// every moment gets a verdict once its window has passed: 'hit' (played in time), 'wrong'
// (something else was played) or 'missed' (nothing was played).
export function createJudge({ earlyMs = 70, minWindowMs = 140, maxWindowMs = 420, lateMs = 90, hitFrames = 2 } = {}) {
  let events = [];
  let next = 0; // first moment not yet opened
  let open = []; // moments being listened for: { ev, endTick, hit, wrong, quiet }
  let lastTick = null;
  let counts = { hit: 0, wrong: 0, missed: 0 };
  let streak = 0;
  let best = 0;

  const close = (o) => {
    const verdict = o.hit >= hitFrames ? 'hit' : o.wrong > o.quiet / 2 && o.wrong >= 2 ? 'wrong' : 'missed';
    counts[verdict]++;
    streak = verdict === 'hit' ? streak + 1 : 0;
    best = Math.max(best, streak);
    return { ev: o.ev, verdict };
  };

  const seek = (tick) => {
    let lo = 0, hi = events.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (events[mid].start < tick) lo = mid + 1; else hi = mid; }
    next = lo;
  };

  return {
    setEvents(list) { events = list || []; open = []; next = 0; lastTick = null; },
    // match(ev) → 'hit' | 'wrong' | 'quiet' for this slice of audio.
    frame(tick, msPerTick, match) {
      const done = [];
      const toTicks = (ms) => ms / msPerTick;
      if (lastTick !== null && (tick < lastTick - toTicks(30) || tick - lastTick > toTicks(1500))) {
        // A jump (loop, seek): forget what was open without judging it.
        open = [];
        seek(tick);
      } else if (lastTick === null) seek(tick);
      lastTick = tick;
      // Open the moments whose window has started (a little early is fine).
      while (next < events.length && events[next].start - toTicks(earlyMs) <= tick) {
        const ev = events[next++];
        const len = Math.max(minWindowMs, Math.min(maxWindowMs, (ev.end - ev.start) * msPerTick));
        open.push({ ev, endTick: ev.start + toTicks(len + lateMs), hit: 0, wrong: 0, quiet: 0 });
      }
      // A slice counts as a hit for any open moment it matches; otherwise it's held
      // against the newest one only (playing the next note isn't wrong for the last).
      const newest = open[open.length - 1];
      for (const o of open) {
        const r = match(o.ev);
        if (r === 'hit') o.hit++;
        else if (o === newest) o[r]++;
      }
      while (open.length && open[0].endTick <= tick) done.push(close(open.shift()));
      return done;
    },
    // Judges what is still open (the song or loop ended).
    flush() { const done = open.map(close); open = []; return done; },
    current: () => open[open.length - 1]?.ev || null,
    summary() {
      const total = counts.hit + counts.wrong + counts.missed;
      return { ...counts, total, score: total ? Math.round((counts.hit / total) * 100) : 0, streak, best };
    },
    reset() { counts = { hit: 0, wrong: 0, missed: 0 }; streak = 0; best = 0; open = []; lastTick = null; },
  };
}

export function describeJudge(s) {
  if (!s.total) return 'Nothing was played against yet.';
  const parts = [`${s.hit} of ${s.total} notes/chords hit`];
  if (s.wrong) parts.push(`${s.wrong} wrong`);
  if (s.missed) parts.push(`${s.missed} missed`);
  if (s.best > 2) parts.push(`best run ${s.best} in a row`);
  return parts.join(' · ');
}
