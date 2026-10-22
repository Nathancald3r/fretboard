// Chords for the player: the file's own chord names when it has them, otherwise a guess
// per bar (or half bar) from the notes of every pitched track. Works on alphaTab's score
// model but has no browser dependencies.
import { noteName, pitchClass } from './theory.js';

// [suffix, intervals above the root, complexity penalty]
const TEMPLATES = [
  ['', [0, 4, 7], 0],
  ['m', [0, 3, 7], 0],
  ['5', [0, 7], 0.02],
  ['7', [0, 4, 7, 10], 0.06],
  ['m7', [0, 3, 7, 10], 0.06],
  ['maj7', [0, 4, 7, 11], 0.08],
  ['sus4', [0, 5, 7], 0.08],
  ['sus2', [0, 2, 7], 0.08],
  ['dim', [0, 3, 6], 0.1],
];

/**
 * Best chord for a set of sounding notes.
 * notes: [{ midi, weight }] (weight = how long it sounds). Returns
 * { root, bass, suffix, confidence } or null when the notes don't spell a chord
 * (single-note lines, scale runs).
 */
export function detectChord(notes) {
  const pcWeight = new Array(12).fill(0);
  let total = 0;
  for (const n of notes) {
    pcWeight[((n.midi % 12) + 12) % 12] += n.weight;
    total += n.weight;
  }
  if (!total || pcWeight.filter((w) => w > total * 0.08).length < 2) return null;
  const lowest = notes.reduce((a, b) => (b.midi < a.midi ? b : a)).midi;
  const bass = ((lowest % 12) + 12) % 12;

  let best = null;
  for (let root = 0; root < 12; root++) {
    if (pcWeight[root] < total * 0.05) continue;
    for (const [suffix, intervals, penalty] of TEMPLATES) {
      const tones = intervals.map((i) => (root + i) % 12);
      let inside = 0;
      let missing = 0;
      for (const pc of tones) {
        inside += pcWeight[pc];
        if (pcWeight[pc] < total * 0.04) missing++;
      }
      // Every chord tone (the third, the 7th) must actually be there.
      if (missing) continue;
      const coverage = inside / total;
      let score = coverage - penalty;
      if (root === bass) score += 0.12;
      // Four-note chords explain more notes by nature, so they must fit better.
      if (intervals.length > 3 && coverage < 0.85) continue;
      if (!best || score > best.score) best = { root, suffix, score, coverage, tones };
    }
  }
  if (!best || best.coverage < 0.72) return null;
  return { root: best.root, bass: best.tones.includes(bass) ? bass : best.root, suffix: best.suffix, confidence: best.coverage };
}

export function chordName({ root, bass, suffix }, preferFlats = false) {
  const name = noteName(root, preferFlats) + suffix;
  return bass !== root && suffix !== '5' ? `${name}/${noteName(bass, preferFlats)}` : name;
}

const isPitched = (track) => !track.staves.some((s) => s.isPercussion);

// Notes sounding in [from, to) ticks of one master bar, across all pitched tracks.
// Empty unless something is harmonic (a beat with 2+ notes, or 2+ tracks playing):
// a lone melody or scale run isn't a chord.
function notesIn(score, barIndex, from, to) {
  const out = [];
  let chordal = false;
  let tracks = 0;
  for (const track of score.tracks) {
    if (!isPitched(track)) continue;
    const before = out.length;
    for (const staff of track.staves) {
      const bar = staff.bars[barIndex];
      if (!bar) continue;
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          if (beat.isRest || !beat.notes.length) continue;
          const start = Math.max(from, beat.playbackStart);
          const end = Math.min(to, beat.playbackStart + beat.playbackDuration);
          if (end <= start) continue;
          // Notes on the downbeat count a bit more: that's where chords change.
          if (beat.notes.length > 1) chordal = true;
          const weight = (end - start) * (beat.playbackStart <= from ? 1.3 : 1);
          for (const n of beat.notes) {
            const midi = n.realValue;
            if (Number.isFinite(midi) && !n.isDead) out.push({ midi, weight });
          }
        }
      }
    }
    if (out.length > before) tracks++;
  }
  return chordal || tracks > 1 ? out : [];
}

/** True when any track has chord names from the file. */
export function scoreHasChords(score) {
  return score.tracks.some((t) => t.staves.some((s) => s.chords && s.chords.size > 0));
}

/**
 * Guessed chords per master bar: [[{ offset, name }], ...] (offset in ticks from the
 * bar start). A bar gets two chords when its halves clearly differ.
 */
export function guessChords(score) {
  const flats = (score.masterBars[0]?.keySignature ?? 0) < 0;
  let previous = null;
  return score.masterBars.map((mb, i) => {
    const len = mb.calculateDuration ? mb.calculateDuration() : 3840;
    const whole = detectChord(notesIn(score, i, 0, len));
    const chords = [];
    const halves = mb.timeSignatureNumerator >= 4 && mb.timeSignatureNumerator % 2 === 0;
    const a = halves ? detectChord(notesIn(score, i, 0, len / 2)) : null;
    const b = halves ? detectChord(notesIn(score, i, len / 2, len)) : null;
    if (a && b && chordName(a) !== chordName(b) && a.confidence > 0.8 && b.confidence > 0.8) {
      chords.push({ offset: 0, name: chordName(a, flats) }, { offset: len / 2, name: chordName(b, flats) });
    } else if (whole) {
      chords.push({ offset: 0, name: chordName(whole, flats) });
    }
    // Don't repeat the same chord bar after bar in the score; the bar's chord is still known.
    const shown = chords.filter((c, j) => j > 0 || c.name !== previous);
    previous = chords.at(-1)?.name ?? previous;
    return { all: chords, shown };
  });
}

/**
 * Puts guessed chord names on the beats of every pitched track so alphaTab draws them
 * above the staff. Needs the Chord class (alphaTab.model.Chord).
 */
export function injectChords(score, guessed, Chord) {
  for (const track of score.tracks) {
    if (!isPitched(track)) continue;
    const staff = track.staves[0];
    guessed.forEach(({ shown }, i) => {
      const voice = staff.bars[i]?.voices[0];
      if (!voice) return;
      for (const c of shown) {
        const beat = voice.beats.find((bt) => bt.playbackStart <= c.offset && c.offset < bt.playbackStart + bt.playbackDuration) || voice.beats[0];
        if (!beat || beat.chordId) continue;
        const chord = new Chord();
        chord.name = c.name;
        chord.showDiagram = false;
        const id = 'guess-' + c.name;
        if (!staff.chords?.has(id)) staff.addChord(id, chord);
        beat.chordId = id;
      }
    });
  }
}

// The notes a chord name spells, as pitch classes above its root ('Asus2/C#' -> root 9, [0, 2, 7], bass 1).
function chordTones(name) {
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(String(name).trim());
  if (!m) return null;
  const q = m[2];
  const third = /sus2/.test(q) ? 2 : /sus/.test(q) ? 5 : /^(m(?!aj)|min|dim|°)/.test(q) ? 3 : 4;
  const fifth = /dim|°|b5/.test(q) ? 6 : /aug|\+|#5/.test(q) ? 8 : 7;
  const tones = q === '5' ? [0, 7] : [0, third, fifth];
  if (/maj7|M7/.test(q)) tones.push(11); else if (/7/.test(q)) tones.push(10);
  return { root: pitchClass(m[1]), tones, bass: m[3] ? pitchClass(m[3]) : null };
}

/**
 * Semitones to move a chord sheet's names so they fit the notes the song plays (0..11). A sheet from
 * another page may be in another key or written for a capo (D shapes for a song in E: +2).
 * chordBars: per master bar, { all: [{ offset, name }] }. 0 when nothing fits clearly better.
 */
export function sheetKeyShift(score, chordBars) {
  const fit = new Array(12).fill(0);
  chordBars.forEach(({ all }, i) => {
    const mb = score.masterBars[i];
    const len = mb?.calculateDuration ? mb.calculateDuration() : 3840;
    all.forEach((c, k) => {
      const t = chordTones(c.name);
      if (!t || t.root === null) return;
      const notes = notesIn(score, i, c.offset, k + 1 < all.length ? all[k + 1].offset : len);
      const total = notes.reduce((a, n) => a + n.weight, 0);
      if (!total) return;
      for (let s = 0; s < 12; s++) {
        const pcs = new Set(t.tones.map((x) => (t.root + s + x) % 12));
        if (t.bass !== null) pcs.add((t.bass + s) % 12);
        fit[s] += notes.reduce((a, n) => a + (pcs.has(((n.midi % 12) + 12) % 12) ? n.weight : 0), 0) / total;
      }
    });
  });
  const best = fit.indexOf(Math.max(...fit));
  return fit[best] > 1.25 * fit[0] ? best : 0;
}

/** File chords per master bar (from the shown track, else the first track that has any): same shape as guessChords. */
export function fileChords(score, trackIndex) {
  const order = [score.tracks[trackIndex], ...score.tracks].filter(Boolean);
  const track = order.find((t) => t.staves.some((s) => s.chords && s.chords.size > 0));
  return score.masterBars.map((_, i) => {
    const list = [];
    for (const staff of track?.staves || []) {
      for (const voice of staff.bars[i]?.voices || []) {
        for (const beat of voice.beats) {
          if (beat.chordId && beat.chord?.name && !list.some((c) => c.offset === beat.playbackStart)) list.push({ offset: beat.playbackStart, name: beat.chord.name });
        }
      }
    }
    list.sort((a, b) => a.offset - b.offset);
    return { all: list, shown: list };
  });
}
