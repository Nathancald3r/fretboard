// Backing tracks: a chord progression in any key played by drums, bass and a strummed
// guitar, written as alphaTex so the player can show and loop it like any other song.
// Pure (no DOM), so tests can check it loads in alphaTab.
import { chordVoicings } from './chordshapes.js';

// Per style, eight 8th-note slots per 4/4 bar.
//   kick/snare/hat: 1 = hit.  bass: 'R' root, '5' fifth, '8' octave, '-' hold, '.' rest.
//   strum: 'D' down, 'U' up, '-' hold (lets the last strum ring), '.' rest.
export const STYLES = {
  rock: {
    label: 'Rock', tempo: 110,
    kick: [1, 0, 0, 0, 1, 1, 0, 0], snare: [0, 0, 1, 0, 0, 0, 1, 0], hat: [1, 1, 1, 1, 1, 1, 1, 1],
    bass: 'RRRRRRRR', strum: 'DDDDDDDD', guitar: 29, // overdriven guitar
  },
  pop: {
    label: 'Pop', tempo: 100,
    kick: [1, 0, 0, 1, 1, 0, 0, 0], snare: [0, 0, 1, 0, 0, 0, 1, 0], hat: [1, 1, 1, 1, 1, 1, 1, 1],
    bass: 'R-.RR-5-', strum: 'D-DU-UDU', guitar: 25, // steel-string acoustic
  },
  ballad: {
    label: 'Ballad', tempo: 72,
    kick: [1, 0, 0, 0, 1, 0, 0, 0], snare: [0, 0, 1, 0, 0, 0, 1, 0], hat: [1, 0, 1, 0, 1, 0, 1, 0],
    bass: 'R---5---', strum: 'D---D-U-', guitar: 25,
  },
  funk: {
    label: 'Funk', tempo: 96,
    kick: [1, 0, 0, 1, 0, 0, 1, 0], snare: [0, 0, 1, 0, 0, 1, 1, 0], hat: [1, 1, 1, 1, 1, 1, 1, 1],
    bass: 'R.8.R5.R', strum: '.U.U.U.U', guitar: 28, // muted electric
  },
};

const DRUM = { kick: '"Kick (hit)"', snare: '"Snare (hit)"', hat: '"Hi-Hat (closed)"', crash: '"Crash high (hit)"' };
// Four-string bass, standard tuning E A D G (open-string pitch classes, low to high).
const BASS_OPEN = [4, 9, 2, 7];
const PITCH = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Where to play a pitch class on the bass's E or A string: { string (alphaTex 4 = E), fret }. */
export function bassRoot(pc) {
  const onE = (pc - 4 + 12) % 12;
  const onA = (pc - 9 + 12) % 12;
  return onE <= 4 ? { string: 4, fret: onE } : { string: 3, fret: onA };
}

// The fifth sits one string higher, two frets up; the octave two strings higher, two frets up.
function bassNote(kind, root) {
  if (kind === 'R') return `${root.fret}.${root.string}`;
  if (kind === '5') return `${root.fret + 2}.${root.string - 1}`;
  return `${root.fret + 2}.${root.string - 2}`;
}

// Runs of a pattern: 'D-DU' → [['D', 2], ['D', 1], ['U', 1]] (holds join the previous slot).
function runs(pattern) {
  const out = [];
  for (const c of pattern) {
    if (c === '-' && out.length) out[out.length - 1][1]++;
    else out.push([c === '-' ? '.' : c, 1]);
  }
  return out;
}

// alphaTex durations for a number of 8th notes: 1 → '8', 2 → '4', 3 → '4' dotted, 4 → '2' …
const LENGTH = { 1: ['8'], 2: ['4'], 3: ['4', 'd'], 4: ['2'], 6: ['2', 'd'], 8: ['1'] };
function duration(eighths) {
  const parts = [];
  let left = eighths;
  for (const n of [8, 6, 4, 3, 2, 1]) while (left >= n) { parts.push(LENGTH[n]); left -= n; }
  return parts;
}
const beat = (notes, [value, dotted], props = []) => `${notes}.${value}${dotted || props.length ? ` {${[dotted, ...props].filter(Boolean).join(' ')}}` : ''}`;

/**
 * The backing track as alphaTex.
 * chords: [{ name, root (pitch class), type }] (one bar each); repeats: how many times through.
 */
export function backingTex({ title, chords, style = 'pop', tempo, repeats = 4 }) {
  const st = STYLES[style] || STYLES.pop;
  const bars = [];
  for (let r = 0; r < repeats; r++) bars.push(...chords);
  const shapes = chords.map((c) => chordVoicings(c.root, c.type)[0]?.frets || null);
  const shapeOf = (i) => shapes[i % chords.length];

  const drums = bars.map((_, b) => {
    const slots = [];
    for (let i = 0; i < 8; i++) {
      const hits = [];
      if (i === 0 && b % (chords.length * 2) === 0) hits.push(DRUM.crash);
      else if (st.hat[i]) hits.push(DRUM.hat);
      if (st.kick[i]) hits.push(DRUM.kick);
      if (st.snare[i]) hits.push(DRUM.snare);
      slots.push(hits.length ? (hits.length > 1 ? `(${hits.join(' ')})` : hits[0]) + '.8' : 'r.8');
    }
    return slots.join(' ');
  });

  const bass = bars.map((c) => {
    const root = bassRoot(c.root);
    return runs(st.bass).map(([k, n]) => duration(n).map((d, j) => (k === '.' || j > 0 ? beat('r', d) : beat(bassNote(k, root), d))).join(' ')).join(' ');
  });

  const guitar = bars.map((c, b) => {
    const frets = shapeOf(b);
    const notes = frets ? `(${frets.map((f, s) => (f < 0 ? null : `${f}.${6 - s}`)).filter(Boolean).join(' ')})` : 'r';
    let first = true;
    return runs(st.strum).map(([k, n]) => duration(n).map((d, j) => {
      if (k === '.' || !frets) return beat('r', d);
      if (j > 0) return beat(notes, d, ['t']); // held over: tie the chord
      const props = [k === 'U' ? 'su' : 'sd'];
      if (first) { props.push(`ch "${c.name}"`); first = false; }
      return beat(notes, d, props);
    }).join(' ')).join(' ');
  });

  const track = (name, instrument, staff, body, extra = []) => [
    `\\track "${name}"`,
    `\\instrument ${instrument}`,
    `\\staff {${staff}}`,
    ...extra,
    body.join(' |\n'),
  ].join('\n');

  return [
    `\\title "${title.replace(/"/g, "'")}"`,
    '\\artist "Backing track"',
    `\\tempo ${tempo || st.tempo}`,
    '.',
    track('Guitar', st.guitar, 'tabs', guitar),
    track('Bass', 33, 'tabs', bass, ['\\tuning E1 A1 D2 G2']),
    track('Drums', 'percussion', 'score', drums, ['\\articulation defaults']),
  ].join('\n');
}

export const pitchName = (pc) => PITCH[((pc % 12) + 12) % 12];
