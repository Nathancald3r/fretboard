// Guitar chord voicings and key theory for the Chords & keys view. No browser
// dependencies, so tests can check every shape spells the right chord.
import { pitchClass, STANDARD } from './theory.js';

// Intervals above the root. The 5th may be left out of a voicing.
export const CHORD_TYPES = {
  '': { label: 'major', intervals: [0, 4, 7] },
  m: { label: 'minor', intervals: [0, 3, 7] },
  7: { label: 'dominant 7', intervals: [0, 4, 7, 10] },
  maj7: { label: 'major 7', intervals: [0, 4, 7, 11] },
  m7: { label: 'minor 7', intervals: [0, 3, 7, 10] },
  sus2: { label: 'sus2', intervals: [0, 2, 7] },
  sus4: { label: 'sus4', intervals: [0, 5, 7] },
  add9: { label: 'add9', intervals: [0, 2, 4, 7] },
  6: { label: '6', intervals: [0, 4, 7, 9] },
  9: { label: '9', intervals: [0, 2, 4, 7, 10] },
  5: { label: 'power chord', intervals: [0, 7] },
  dim: { label: 'diminished', intervals: [0, 3, 6] },
  dim7: { label: 'diminished 7', intervals: [0, 3, 6, 9] },
  m7b5: { label: 'half-diminished (m7♭5)', intervals: [0, 3, 6, 10] },
  aug: { label: 'augmented', intervals: [0, 4, 8] },
};

const X = -1; // muted string
// Open-position shapes, low E to high e.
const OPEN = {
  C: [X, 3, 2, 0, 1, 0], A: [X, 0, 2, 2, 2, 0], G: [3, 2, 0, 0, 0, 3], E: [0, 2, 2, 1, 0, 0], D: [X, X, 0, 2, 3, 2],
  Am: [X, 0, 2, 2, 1, 0], Em: [0, 2, 2, 0, 0, 0], Dm: [X, X, 0, 2, 3, 1], F: [X, X, 3, 2, 1, 1],
  C7: [X, 3, 2, 3, 1, 0], A7: [X, 0, 2, 0, 2, 0], G7: [3, 2, 0, 0, 0, 1], E7: [0, 2, 0, 1, 0, 0], D7: [X, X, 0, 2, 1, 2], B7: [X, 2, 1, 2, 0, 2],
  Cmaj7: [X, 3, 2, 0, 0, 0], Amaj7: [X, 0, 2, 1, 2, 0], Dmaj7: [X, X, 0, 2, 2, 2], Fmaj7: [X, X, 3, 2, 1, 0], Gmaj7: [3, 2, 0, 0, 0, 2],
  Am7: [X, 0, 2, 0, 1, 0], Em7: [0, 2, 0, 0, 0, 0], Dm7: [X, X, 0, 2, 1, 1],
  Asus2: [X, 0, 2, 2, 0, 0], Asus4: [X, 0, 2, 2, 3, 0], Dsus2: [X, X, 0, 2, 3, 0], Dsus4: [X, X, 0, 2, 3, 3], Esus4: [0, 2, 2, 2, 0, 0],
  Cadd9: [X, 3, 2, 0, 3, 0], E5: [0, 2, 2, X, X, X], A5: [X, 0, 2, 2, X, X], D5: [X, X, 0, 2, 3, X],
  A6: [X, 0, 2, 2, 2, 2], E9: [0, 2, 0, 1, 0, 2],
};
// Movable shapes as fret offsets from the root's fret (null = muted).
// "E shape": root on the low E string. "A shape": root on the A string.
const MOVABLE = {
  E: {
    string: 0,
    shapes: {
      '': [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], 7: [0, 2, 0, 1, 0, 0], maj7: [0, null, 1, 1, 0, null],
      m7: [0, 2, 0, 0, 0, 0], sus4: [0, 2, 2, 2, 0, 0], add9: [0, 2, 2, 1, 0, 2], 6: [0, 2, 2, 1, 2, 0], 9: [0, 2, 0, 1, 0, 2],
      5: [0, 2, 2, null, null, null], dim: [0, 1, 2, 0, null, null], dim7: [0, null, -1, 0, -1, null],
      m7b5: [0, null, 0, 0, -1, null], aug: [0, null, 2, 1, 1, 0],
    },
  },
  A: {
    string: 1,
    shapes: {
      '': [null, 0, 2, 2, 2, 0], m: [null, 0, 2, 2, 1, 0], 7: [null, 0, 2, 0, 2, 0], maj7: [null, 0, 2, 1, 2, 0],
      m7: [null, 0, 2, 0, 1, 0], sus2: [null, 0, 2, 2, 0, 0], sus4: [null, 0, 2, 2, 3, 0], add9: [null, 0, 2, 4, 2, 0],
      6: [null, 0, 2, 2, 2, 2], 9: [null, 0, -1, 0, 0, 0], 5: [null, 0, 2, 2, null, null], dim: [null, 0, 1, 2, 1, null],
      dim7: [null, 0, 1, -1, 1, null], m7b5: [null, 0, 1, 0, 1, null], aug: [null, 0, 3, 2, 2, null],
    },
  },
  // "D shape": root on the D string, the top four strings
  D: {
    string: 2,
    shapes: {
      '': [null, null, 0, 2, 3, 2], m: [null, null, 0, 2, 3, 1], 7: [null, null, 0, 2, 1, 2], maj7: [null, null, 0, 2, 2, 2],
      m7: [null, null, 0, 2, 1, 1], sus2: [null, null, 0, 2, 3, 0], sus4: [null, null, 0, 2, 3, 3],
    },
  },
};
const MAX_FRET = 15;

/** "F#m7" → { root: 6, type: 'm7' }, or null if the type isn't in CHORD_TYPES. */
export function splitChord(name) {
  const m = /^([A-G](?:#|b)?)(.*)$/.exec(name);
  if (!m || !(m[2] in CHORD_TYPES)) return null;
  return { root: pitchClass(m[1]), type: m[2] };
}

/** Pitch classes sounding in a voicing (frets low E → high e, -1 = muted). */
export const voicingNotes = (frets) => frets.map((f, s) => (f < 0 ? null : STANDARD[s] + f)).filter((m) => m !== null);

/**
 * Every voicing for a chord, easiest first: open shapes, then the E- and A-shape barres.
 * Each is { frets, name, barre } where barre is the barred fret (or 0).
 */
export function chordVoicings(root, type) {
  const out = [];
  const seen = new Set();
  const add = (frets, name, barre = 0) => {
    const key = frets.join(',');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ frets, name, barre });
  };
  for (const [name, frets] of Object.entries(OPEN)) {
    const c = splitChord(name);
    if (c.root === root && c.type === type) add(frets, 'Open');
  }
  for (const [shapeName, { string, shapes }] of Object.entries(MOVABLE)) {
    const offsets = shapes[type];
    if (!offsets) continue;
    let fret = (root - STANDARD[string] + 120) % 12;
    const lowest = Math.min(...offsets.filter((o) => o !== null));
    if (fret + lowest < 0) fret += 12;
    const frets = offsets.map((o) => (o === null ? X : fret + o));
    if (Math.max(...frets) > MAX_FRET) continue;
    // A full barre when the lowest and highest played strings both sit on the root's fret.
    const played = frets.map((f, s) => [f, s]).filter(([f]) => f >= 0);
    const barre = fret > 0 && played[0][0] === fret && played[played.length - 1][0] === fret && played.length > 3 ? fret : 0;
    add(frets, `${shapeName} shape${fret ? `, fret ${fret}` : ''}`, barre);
  }
  return out.sort((a, b) => (b.name === 'Open') - (a.name === 'Open') || lowFret(a) - lowFret(b));
}
const lowFret = (v) => Math.min(...v.frets.filter((f) => f >= 0));

// How sheets write chord types, as the types above
const ALIAS = { min: 'm', mi: 'm', '-': 'm', maj: '', M: '', Maj7: 'maj7', M7: 'maj7', ma7: 'maj7', '2': 'sus2', sus: 'sus4', add2: 'add9', min7: 'm7', '-7': 'm7', '°': 'dim', o: 'dim', '°7': 'dim7', ø: 'm7b5', 'ø7': 'm7b5', '+': 'aug', 'm7-5': 'm7b5' };

/**
 * A chord name as written on a sheet ("F#m", "C/G", "Bbmaj9", "G(add9)") → its shapes:
 * { root, type, bass, exact, voicings }. exact is false when the type isn't known and a near one
 * (the triad, or the 7th under a 9th) stands in. null when it isn't a chord name.
 */
export function shapesFor(name) {
  const m = /^\(?([A-G][#b♯♭]?)([^/]*?)(?:\/([A-G][#b♯♭]?))?\)?$/.exec(String(name || '').trim());
  if (!m) return null;
  const root = pitchClass(m[1].replace('♯', '#').replace('♭', 'b'));
  let written = m[2].replace(/[()]/g, '');
  if (written in ALIAS) written = ALIAS[written];
  let type = written;
  if (!(type in CHORD_TYPES)) {
    const near = { maj9: 'maj7', maj13: 'maj7', m9: 'm7', m11: 'm7', 11: '7', 13: '7', '7sus4': 'sus4', '7sus2': 'sus2', madd9: 'm', m6: 'm', '6/9': '6', 69: '6', '7#9': '7', '7b9': '7' }[type];
    type = near ?? (/^(m|min|mi)(?!aj)/.test(type) ? 'm' : '');
  }
  return { root, type, bass: m[3] ? pitchClass(m[3].replace('♯', '#').replace('♭', 'b')) : null, exact: type === written, voicings: chordVoicings(root, type) };
}

/* ---------- keys ---------- */

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const LETTERS = 'CDEFGAB';
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const ACC = { 0: '', 1: '#', 2: '##', 11: 'b', 10: 'bb' };

// Around the circle clockwise from C. Index = number of sharps (1–6) or 12 − flats.
export const CIRCLE_MAJOR = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F'];
export const CIRCLE_MINOR = ['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm'];
const ENHARMONIC = { 'F#': 'Gb', 'D#m': 'Ebm', 'Db': 'C#', 'Bbm': 'A#m', B: 'Cb', 'G#m': 'Abm' };
export const enharmonic = (name) => ENHARMONIC[name] || null;
const SHARP_ORDER = ['F#', 'C#', 'G#', 'D#', 'A#', 'E#', 'B#'];
const FLAT_ORDER = ['Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb', 'Fb'];

/** Scale notes spelled with one letter each, e.g. "F#" major → F# G# A# B C# D# E#. */
export function spellScale(tonicName, minor = false) {
  const letter = LETTERS.indexOf(tonicName[0]);
  const tonic = pitchClass(tonicName);
  return (minor ? MINOR : MAJOR).map((iv, i) => {
    const l = (letter + i) % 7;
    return LETTERS[l] + ACC[(tonic + iv - LETTER_PC[l] + 24) % 12];
  });
}

/** "Bb" major / "Gm" (minor) → { sharps: [], flats: ['Bb', 'Eb'] }. */
export function keySignature(name) {
  const minor = name.endsWith('m');
  const i = (minor ? CIRCLE_MINOR : CIRCLE_MAJOR).indexOf(name);
  if (i <= 6) return { sharps: SHARP_ORDER.slice(0, i), flats: [] };
  return { sharps: [], flats: FLAT_ORDER.slice(0, 12 - i) };
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/**
 * The seven chords built on a key's scale (triads, or 7th chords).
 * Each is { name, roman, number, function } — number is the Nashville number.
 */
export function diatonicChords(name, sevenths = false) {
  const minor = name.endsWith('m');
  const notes = spellScale(minor ? name.slice(0, -1) : name, minor);
  const pcs = notes.map(pitchClass);
  return notes.map((note, i) => {
    const third = (pcs[(i + 2) % 7] - pcs[i] + 12) % 12;
    const fifth = (pcs[(i + 4) % 7] - pcs[i] + 12) % 12;
    const seventh = (pcs[(i + 6) % 7] - pcs[i] + 12) % 12;
    let type = third === 3 ? (fifth === 6 ? 'dim' : 'm') : (fifth === 8 ? 'aug' : '');
    if (sevenths) {
      if (type === '') type = seventh === 11 ? 'maj7' : '7';
      else if (type === 'm') type = 'm7';
      else if (type === 'dim') type = seventh === 10 ? 'm7b5' : 'dim7';
    }
    const isMinor = third === 3;
    const numeral = isMinor ? ROMAN[i].toLowerCase() : ROMAN[i];
    const suffix = { dim: '°', m7b5: 'ø7', dim7: '°7', aug: '+', maj7: 'maj7', 7: '7', m7: '7' }[type] || '';
    const quality = { m: 'm', m7: 'm7', dim: '°', m7b5: 'm7♭5', dim7: '°7', aug: '+', maj7: 'maj7', 7: '7' }[type] || '';
    return { name: note + type, root: pcs[i], type, roman: numeral + suffix, number: String(i + 1) + quality };
  });
}

// Progressions as scale degrees (0-based); a "V" in a minor key uses the major V.
export const PROGRESSIONS = [
  { name: 'I – V – vi – IV (pop)', major: [0, 4, 5, 3] },
  { name: 'I – IV – V (rock, country)', major: [0, 3, 4, 4] },
  { name: 'ii – V – I (jazz)', major: [1, 4, 0, 0] },
  { name: 'vi – IV – I – V', major: [5, 3, 0, 4] },
  { name: 'I – vi – IV – V (50s)', major: [0, 5, 3, 4] },
  { name: '12-bar blues', major: [0, 0, 0, 0, 3, 3, 0, 0, 4, 3, 0, 4] },
  { name: 'i – VI – III – VII (epic minor)', minor: [0, 5, 2, 6] },
  { name: 'i – iv – v (minor)', minor: [0, 3, 4, 4] },
  { name: 'i – VII – VI – VII (rock minor)', minor: [0, 6, 5, 6] },
  { name: 'i – iv – V (harmonic minor)', minor: [0, 3, 'V', 0] },
];

/** Chord names for a progression in a key, or null if it doesn't fit (major vs minor). */
export function progressionChords(prog, keyName) {
  const minor = keyName.endsWith('m');
  const degrees = minor ? prog.minor : prog.major;
  if (!degrees) return null;
  const chords = diatonicChords(keyName);
  return degrees.map((d) => {
    if (d !== 'V') return chords[d];
    const v = chords[4];
    return { ...v, name: v.name.replace(/m$/, ''), type: '', roman: 'V', number: '5' };
  });
}

/** The note at a string (0 = low E) and fret. */
export const noteAt = (string, fret) => (STANDARD[string] + fret) % 12;
