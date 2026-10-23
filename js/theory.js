// Music theory helpers: note names, chord parsing, key detection, Nashville numbers, scales.

export const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// Scale degree names by semitone distance from the key's root.
export const DEGREES = ['1', 'b2', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7'];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

export function pitchClass(name) {
  const m = /^([A-G])([#b]?)/.exec(name);
  if (!m) return null;
  return (PITCH[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
}

export const noteName = (pc, preferFlats = false) => (preferFlats ? FLAT_NAMES : NOTES)[((pc % 12) + 12) % 12];

const CHORD = /^([A-G][#b]?)([^/\s]*)(?:\/([A-G][#b]?))?$/;

export function parseChord(text) {
  const m = CHORD.exec(text);
  if (!m) return null;
  const quality = m[2];
  return {
    root: pitchClass(m[1]),
    quality,
    minor: /^(m(?!aj)|min|-)/.test(quality),
    bass: m[3] ? pitchClass(m[3]) : null,
  };
}

/** A key is { tonic: pitchClass, minor: boolean }. */
export function keyLabel(key) {
  return `${noteName(key.tonic, [5, 10, 3, 8, 1].includes(key.tonic))}${key.minor ? 'm' : ''}`;
}

// Scores every major and minor key by how many chords fit it; first/last chord count extra.
export function detectKey(chordNames) {
  const chords = chordNames.map(parseChord).filter(Boolean);
  if (!chords.length) return null;
  let best = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      const scale = minor ? MINOR : MAJOR;
      // Triad quality of each scale degree (minor key: i ii° III iv v VI VII; major: I ii iii IV V vi vii°).
      const minorDegrees = minor ? [0, 3, 4] : [1, 2, 5];
      let score = 0;
      chords.forEach((c, i) => {
        const deg = scale.indexOf((c.root - tonic + 12) % 12);
        if (deg === -1) return;
        let s = minorDegrees.includes(deg) === c.minor ? 2 : 0.5;
        if (minor && deg === 4 && !c.minor) s = 1.5; // V in minor (harmonic minor) is common
        // Songs usually start (and often end) on the tonic; the first chord weighs most.
        if (deg === 0 && c.minor === minor) s += i === 0 ? 3.5 : i === chords.length - 1 ? 3 : 1;
        score += s;
      });
      if (!best || score > best.score) best = { tonic, minor, score };
    }
  }
  return { tonic: best.tonic, minor: best.minor };
}

/**
 * The key numbers count from: the shapes' key, since the numbers are written over the shapes.
 * The page's "Key:" (how it sounds) minus its capo; only a sheet with no key line is guessed
 * from its chords. Returns { tonic, minor, from: 'page' | 'chords' } or null.
 */
export function shapesKey(pageKey, capo, chordNames) {
  const tonic = pageKey ? pitchClass(pageKey) : null;
  if (tonic !== null) return { tonic: (((tonic - (capo || 0)) % 12) + 12) % 12, minor: /m$/.test(pageKey), from: 'page' };
  const guess = detectKey(chordNames);
  return guess && { ...guess, from: 'chords' };
}

/** "Em7/B" in G → "6m7/3". In a minor key numbers count from the minor tonic (Am in Am → "1m"). */
export function toNashville(chordText, key) {
  const c = parseChord(chordText);
  if (!c || !key) return chordText;
  const degree = DEGREES[(c.root - key.tonic + 12) % 12];
  let quality = c.quality;
  if (/^min/.test(quality)) quality = 'm' + quality.slice(3);
  if (quality.startsWith('-')) quality = 'm' + quality.slice(1);
  const bass = c.bass === null ? '' : '/' + DEGREES[(c.bass - key.tonic + 12) % 12];
  return degree + quality + bass;
}

// Roman numerals by semitones from the tonic. A minor key counts from its own tonic (C in Am → III).
const ROMAN_MAJOR = ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII'];
const ROMAN_MINOR = ['I', 'bII', 'II', 'III', '#III', 'IV', '#IV', 'V', 'VI', '#VI', 'VII', '#VII'];

/**
 * "Em7" in G → "vi7", "Bdim" in C → "vii°", "C/G" in G → "IV/1" (the bass as a scale number).
 * Minor and diminished chords are lower case.
 */
export function toRoman(chordText, key) {
  const c = parseChord(chordText);
  if (!c || !key) return chordText;
  let numeral = (key.minor ? ROMAN_MINOR : ROMAN_MAJOR)[(c.root - key.tonic + 12) % 12];
  let q = c.quality;
  const dim = /^(dim|°|o(?![a-z]))/.test(q);
  const half = /^(m7b5|ø)/.test(q);
  if (half) q = 'ø7' + q.replace(/^(m7b5|ø7?)/, '');
  else if (dim) q = '°' + q.replace(/^(dim|°|o)/, '');
  else if (c.minor) q = q.replace(/^(min|m|-)/, '');
  else if (/^(aug|\+)/.test(q)) q = '+' + q.replace(/^(aug|\+)/, '');
  if (c.minor || dim || half) numeral = numeral.toLowerCase();
  const bass = c.bass === null ? '' : '/' + DEGREES[(c.bass - key.tonic + 12) % 12];
  return numeral + q + bass;
}

export const SCALES = {
  'Major (Ionian)': [0, 2, 4, 5, 7, 9, 11],
  'Natural minor (Aeolian)': [0, 2, 3, 5, 7, 8, 10],
  'Minor pentatonic': [0, 3, 5, 7, 10],
  'Major pentatonic': [0, 2, 4, 7, 9],
  'Blues': [0, 3, 5, 6, 7, 10],
  'Dorian': [0, 2, 3, 5, 7, 9, 10],
  'Mixolydian': [0, 2, 4, 5, 7, 9, 10],
  'Phrygian': [0, 1, 3, 5, 7, 8, 10],
  'Lydian': [0, 2, 4, 6, 7, 9, 11],
  'Locrian': [0, 1, 3, 5, 6, 8, 10],
  'Harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'Melodic minor': [0, 2, 3, 5, 7, 9, 11],
};

// Open strings, low E first (MIDI).
export const STANDARD = [40, 45, 50, 55, 59, 64];

/**
 * One playable box ("position") of a scale. Position k starts on the k-th scale degree
 * on the low E string and climbs string by string inside a small fret window.
 * @returns {{ notes: {string: number, fret: number, midi: number, degree: string}[], lo: number, hi: number }}
 * string: 0 = low E … 5 = high e.
 */
export function scalePosition(root, intervals, position) {
  const pcs = intervals.map((i) => (root + i) % 12);
  const startPc = pcs[position % pcs.length];
  const f0 = (startPc - (STANDARD[0] % 12) + 12) % 12;
  const lo = Math.max(0, f0 - 1);
  const hi = f0 + (intervals.length >= 7 ? 4 : 3);
  const inScale = (midi) => pcs.includes(midi % 12);
  const degree = (midi) => DEGREES[(midi - root + 120) % 12];

  const notes = [];
  let midi = STANDARD[0] + f0;
  for (let s = 0; s < STANDARD.length; s++) {
    for (;;) {
      const fret = midi - STANDARD[s];
      if (fret < lo) { midi = next(midi); continue; }
      if (fret > hi) break; // continue on the next string
      notes.push({ string: s, fret, midi, degree: degree(midi) });
      midi = next(midi);
    }
  }
  return { notes, lo, hi };

  function next(m) {
    do m++; while (!inScale(m));
    return m;
  }
}

/** Every scale note on the neck from fret 0 to maxFret (for the faint background dots). */
export function scaleNeck(root, intervals, maxFret = 15) {
  const pcs = intervals.map((i) => (root + i) % 12);
  const out = [];
  STANDARD.forEach((open, s) => {
    for (let fret = 0; fret <= maxFret; fret++) {
      const midi = open + fret;
      if (pcs.includes(midi % 12)) out.push({ string: s, fret, midi, degree: DEGREES[(midi - root + 120) % 12] });
    }
  });
  return out;
}

/** Practice orderings over an ascending note list. */
export function sequence(notes, pattern) {
  const down = [...notes].reverse();
  if (pattern === 'straight') return [...notes, ...down.slice(1)];
  const size = pattern === 'threes' ? 3 : 4;
  const groups = (list) => {
    const out = [];
    for (let i = 0; i + size <= list.length; i++) out.push(...list.slice(i, i + size));
    return out;
  };
  return [...groups(notes), ...groups(down)];
}

const PATTERN_LABEL = { straight: '', threes: ' · in 3s', fours: ' · in 4s' };

/** Name used for the library entry of a scale exercise. */
export function scaleTitle({ root, scale, position, pattern }) {
  return `${noteName(root, [5, 10, 3, 8, 1].includes(root))} ${scale} · position ${position + 1}${PATTERN_LABEL[pattern] || ''}`;
}

/**
 * alphaTex for a scale exercise: the position played with the chosen pattern,
 * ending on a held root note. noteValue is 4, 8 or 16.
 */
export function scaleTex({ root, scale, position, pattern = 'straight', noteValue = 8, tempo = 80 }) {
  const { notes } = scalePosition(root, SCALES[scale], position);
  const played = sequence(notes, pattern);
  const perBar = noteValue; // in 4/4 a bar holds `noteValue` notes of that value
  const tex = (n) => `${n.fret}.${6 - n.string}`;
  const beats = played.map((n) => `${tex(n)}.${noteValue}`);
  while (beats.length % perBar) beats.push(`r.${noteValue}`);
  const bars = [];
  for (let i = 0; i < beats.length; i += perBar) bars.push(beats.slice(i, i + perBar).join(' '));
  const lowestRoot = notes.find((n) => n.degree === '1') || notes[0];
  bars.push(`${tex(lowestRoot)}.2 r.2`);
  const title = scaleTitle({ root, scale, position, pattern });
  return [
    `\\title "${title}"`,
    '\\artist "Scale"',
    `\\tempo ${tempo}`,
    '.',
    '\\track "Guitar"',
    '\\staff {score tabs}',
    bars.join(' |\n'),
  ].join('\n');
}
