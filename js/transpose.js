// Transpose and capo: rewrites a parsed alphaTab score in place, before it is rendered.
// - Transpose moves every pitched note (and key signatures and chord names) by semitones.
// - Capo keeps the sound and shows the tab relative to a capo on the shown track.
// Frets that would fall off the neck (below the capo or above fret 24) move to another
// string in the same chord. Pure model edits, so tests run it on real alphaTab scores.
import { pitchClass, noteName } from './theory.js';

const MAX_FRET = 24;

/** A chord name moved by semitones: 'G/B' +2 → 'A/C#'. Unknown names are left alone. */
export function shiftChordName(name, semitones, preferFlats = false) {
  if (!semitones) return name;
  const m = /^([A-G][#b♯♭]?)(.*?)(?:\/([A-G][#b♯♭]?))?$/.exec(String(name).trim());
  if (!m) return name;
  const move = (n) => noteName(pitchClass(n.replace('♯', '#').replace('♭', 'b')) + semitones, preferFlats);
  return move(m[1]) + m[2] + (m[3] ? '/' + move(m[3]) : '');
}

/** Key signature (sharps > 0, flats < 0) after moving the key by semitones. */
export function shiftKeySignature(ks, semitones) {
  if (!semitones) return ks;
  const tonic = ((ks * 7) % 12 + 12) % 12; // the major key's tonic for ks sharps
  let v = (((tonic + semitones) * 7) % 12 + 12) % 12;
  if (v > 6 || (v === 6 && ks < 0)) v -= 12;
  return v;
}

const tuningOf = (staff, string) => staff.tuning[staff.tuning.length - string];

function eachBeat(staff, fn) {
  for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) fn(beat, bar);
}

// Frets for one beat's notes: keep each on its string when it fits, else the free string
// nearest to where it was. Tied notes stay on their origin's string.
function refret(beat, staff, semitones, oldCapo, newCapo) {
  const strings = staff.tuning.length;
  const notes = beat.notes.filter((n) => n.fret >= 0 && n.string >= 1 && n.string <= strings);
  const used = new Set();
  const pending = [];
  for (const n of notes) {
    if (n.harmonicType === 1) { used.add(n.string); continue; } // natural harmonics stay where they ring
    const pitch = n.fret + tuningOf(staff, n.string) + oldCapo + semitones;
    const origin = n.isTieDestination ? n.tieOrigin : null;
    const string = origin && origin.string >= 1 ? origin.string : n.string;
    const fret = pitch - tuningOf(staff, string) - newCapo;
    if (fret >= 0 && fret <= MAX_FRET && !used.has(string)) {
      n.string = string; n.fret = fret; used.add(string);
    } else pending.push([n, pitch]);
  }
  for (const [n, pitch] of pending) {
    let best = null;
    for (let s = 1; s <= strings; s++) {
      if (used.has(s)) continue;
      const fret = pitch - tuningOf(staff, s) - newCapo;
      if (fret < 0 || fret > MAX_FRET) continue;
      const cost = Math.abs(s - n.string) * 3 + Math.abs(fret - n.fret);
      if (!best || cost < best.cost) best = { s, fret, cost };
    }
    if (best) { n.string = best.s; n.fret = best.fret; used.add(best.s); continue; }
    // Nowhere to put it at this pitch: an octave up or down on its own string.
    let fret = pitch - tuningOf(staff, n.string) - newCapo;
    while (fret < 0) fret += 12;
    while (fret > MAX_FRET) fret -= 12;
    n.fret = fret;
    used.add(n.string);
  }
}

function shiftChords(staff, semitones, flats) {
  if (!semitones || !staff.chords) return;
  for (const chord of staff.chords.values()) {
    if (chord.name) chord.name = shiftChordName(chord.name, semitones, flats);
    const frets = chord.strings || [];
    const played = frets.filter((f) => f >= 0).map((f) => f + semitones);
    if (played.some((f) => f < 0 || f > MAX_FRET)) { chord.showDiagram = false; continue; }
    for (let i = 0; i < frets.length; i++) if (frets[i] >= 0) frets[i] += semitones;
    const fretted = played.filter((f) => f > 0);
    chord.firstFret = fretted.length ? Math.max(1, Math.min(...fretted)) : 1;
  }
}

/**
 * Rewrites the score. semitones: −11…11. capo: the capo on capoTrack's guitar (null keeps
 * the file's). Returns { flats } so chord names elsewhere can be spelled to match.
 */
export function transposeScore(score, { semitones = 0, capo = null, capoTrack = -1 } = {}) {
  const firstKs = shiftKeySignature(score.tracks[0]?.staves[0]?.bars[0]?.keySignature ?? 0, semitones);
  const flats = firstKs < 0;
  score.tracks.forEach((track, ti) => {
    for (const staff of track.staves) {
      if (staff.isPercussion) continue;
      if (semitones) for (const bar of staff.bars) bar.keySignature = shiftKeySignature(bar.keySignature, semitones);
      const stringed = staff.tuning.length > 0;
      const oldCapo = staff.capo || 0;
      const newCapo = stringed && ti === capoTrack && capo !== null ? capo : oldCapo;
      if (!semitones && newCapo === oldCapo) continue;
      eachBeat(staff, (beat) => {
        if (stringed) { refret(beat, staff, semitones, oldCapo, newCapo); return; }
        for (const n of beat.notes) {
          if (n.octave < 0 || n.tone < 0) continue;
          const v = n.octave * 12 + n.tone + semitones;
          n.octave = Math.floor(v / 12);
          n.tone = ((v % 12) + 12) % 12;
        }
      });
      staff.capo = newCapo;
      // File chords are named and drawn relative to the capo, like the tab.
      shiftChords(staff, semitones + oldCapo - newCapo, flats);
    }
  });
  return { flats };
}
