// The Practice page's curriculum: the foundations (warm-ups, scales, chords, rhythm, technique, ear and theory),
// each a ready-made exercise (alphaTex, standard tuning) or a link to a drill page, plus a short daily routine.
// Pure data and text: no page code, so the tests can parse every exercise with alphaTab.
import { scaleTex, scaleTitle } from './theory.js';

const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const range = (from, to) => (from <= to ? Array.from({ length: to - from + 1 }, (_, i) => from + i) : Array.from({ length: from - to + 1 }, (_, i) => from - i));
const note = ([fret, string]) => `${fret}.${string}`;
// Strings count 6 (low E) to 1 (high e), like the tab.

/** One text: header, then the bars (each a string of beats; `:8` sets the note value from there on). */
function tex(title, tempo, bars, artist = 'Exercise') {
  return [`\\title "${title}"`, `\\artist "${artist}"`, `\\tempo ${tempo}`, '.', '\\track "Guitar"', '\\staff {score tabs}', bars.join(' |\n')].join('\n');
}

/** Eighth notes, `perBar` to a bar. */
const eighths = (notes, perBar = 8) => chunk(notes.map(note), perBar).map((b, i) => `${i ? '' : ':8 '}${b.join(' ')}`);

/* ---------- the exercises ---------- */

const chromatic = () => {
  const up = range(6, 1).flatMap((s) => range(1, 4).map((f) => [f, s]));
  const down = range(1, 6).flatMap((s) => range(4, 1).map((f) => [f, s]));
  return tex('Warm-up: Chromatic 1-2-3-4', 70, eighths([...up, ...down]));
};

const SPIDER = [[1, 2, 3, 4], [1, 3, 2, 4], [1, 4, 2, 3]];
const spider = () => tex('Warm-up: Spider walk', 70,
  eighths(SPIDER.flatMap((order) => range(6, 1).flatMap((s) => order.map((finger) => [4 + finger, s])))));

const picking = () => {
  const up = range(6, 1).map((s) => `:8 ${Array(8).fill(note([0, s])).join(' ')}`);
  const down = range(1, 6).map((s) => `:16 ${Array(16).fill(note([0, s])).join(' ')}`);
  return tex('Warm-up: Alternate picking', 60, [...up, ...down]);
};

const legato = () => tex('Warm-up: Hammer-ons and pull-offs', 70,
  range(6, 1).flatMap((s) => [6, 7, 8].map((top, i) => {
    const pair = `5.${s}{h} ${top}.${s}{h}`;
    return `${i === 0 && s === 6 ? ':8 ' : ''}${pair} ${pair} ${pair} 5.${s} ${top}.${s}`;
  })));

const openChords = (title, tempo, chords) => tex(title, tempo, chords.map((c, i) => `${i ? '' : ':4 '}${Array(4).fill(c).join(' ')}`), 'Chords');
const G = '(3.6 2.5 0.4 0.3 0.2 3.1)', C = '(3.5 2.4 0.3 1.2 0.1)', D = '(0.4 2.3 3.2 2.1)', Em = '(2.5 2.4 0.3 0.2 0.1 0.6)';
const Am = '(0.5 2.4 2.3 1.2 0.1)', Dm = '(0.4 2.3 3.2 1.1)', E = '(0.6 2.5 2.4 1.3 0.2 0.1)';

const counting = () => {
  const open = (s, value, count) => `:${value} ${Array(count).fill(note([0, s])).join(' ')}`;
  return tex('Rhythm: quarters, eighths, sixteenths', 70, [open(5, 4, 4), open(5, 8, 8), open(5, 16, 16), open(5, 4, 4), open(5, 8, 8), open(5, 16, 16)]);
};

const slides = () => tex('Technique: Slides', 70, [
  ':8 5.3{sl} 7.3 7.3{sl} 5.3 5.3{sl} 7.3 7.3{sl} 5.3',
  '5.2{sl} 8.2 8.2{sl} 5.2 5.2{sl} 8.2 8.2{sl} 5.2',
  '7.1{sl} 10.1 10.1{sl} 7.1 7.1{sl} 10.1 10.1{sl} 7.1',
  ':2 5.3 r',
]);

const bends = () => tex('Technique: Bends to pitch', 60, [
  ':4 9.2 7.2{b (0 4)} 9.2 7.2{b (0 4)}',
  '10.2 8.2{b (0 4)} 10.2 8.2{b (0 4)}',
  '8.3{b (0 4)} 8.3 r r',
  ':2 7.2{b (0 4)} r',
]);

const vibrato = () => tex('Technique: Vibrato', 60, [
  ':2 7.2{v} 9.2{v}',
  '8.1{v} 10.1{v}',
  ':1 7.2{v}',
]);

const scale = (opts) => ({ title: scaleTitle(opts), artist: 'Scale', tempo: opts.tempo, tex: () => scaleTex(opts) });
const sc = (root, name, position, tempo = 80) => scale({ root, scale: name, position, pattern: 'straight', noteValue: 8, tempo });

/** Every built-in exercise, by id. level: 'Beginner' | 'Intermediate'; tip: the one thing to watch. */
export const EXERCISES = {
  chromatic: { title: 'Warm-up: Chromatic 1-2-3-4', artist: 'Exercise', tempo: 70, level: 'Beginner', tex: chromatic, tip: 'One finger per fret, fingertips close to the strings, thumb behind the neck.' },
  spider: { title: 'Warm-up: Spider walk', artist: 'Exercise', tempo: 70, level: 'Beginner', tex: spider, tip: 'Three finger orders (1-2-3-4, 1-3-2-4, 1-4-2-3) across all six strings. Keep fingers down as long as you can.' },
  picking: { title: 'Warm-up: Alternate picking', artist: 'Exercise', tempo: 60, level: 'Beginner', tex: picking, tip: 'Down-up-down-up on every note, eighths then sixteenths. Loose wrist, small movements.' },
  legato: { title: 'Warm-up: Hammer-ons and pull-offs', artist: 'Exercise', tempo: 70, level: 'Intermediate', tex: legato, tip: 'Pick only the first note; the fretting finger does the rest. Hit the fret hard, lift the finger off sideways.' },
  pent1: { ...sc(9, 'Minor pentatonic', 0), level: 'Beginner', tip: 'The first box every guitarist learns. Say the notes out loud as you play.' },
  pent2: { ...sc(9, 'Minor pentatonic', 1), level: 'Beginner', tip: 'The second box, joined to the first. Move between them without stopping.' },
  majpent: { ...sc(7, 'Major pentatonic', 0), level: 'Beginner', tip: 'Brighter than the minor box: the sound of country and a lot of pop solos.' },
  major: { ...sc(7, 'Major (Ionian)', 0, 70), level: 'Beginner', tip: 'Do, re, mi: three notes a string. The scale every chord and key comes from.' },
  minor: { ...sc(9, 'Natural minor (Aeolian)', 0, 70), level: 'Beginner', tip: 'The minor key with its seven notes. Compare it with the minor pentatonic.' },
  blues: { ...sc(9, 'Blues', 0), level: 'Intermediate', tip: 'The minor pentatonic plus one passing note (the flat 5). Lean on it.' },
  open1: { title: 'Chords: G - C - D - Em', artist: 'Chords', tempo: 60, level: 'Beginner', tex: () => openChords('Chords: G - C - D - Em', 60, [G, C, D, Em]), tip: 'Four strums each. Move all fingers at once, and look ahead to the next shape.' },
  open2: { title: 'Chords: Am - Em - Dm - E', artist: 'Chords', tempo: 60, level: 'Beginner', tex: () => openChords('Chords: Am - Em - Dm - E', 60, [Am, Em, Dm, E]), tip: 'The minor chords. Keep the shared fingers down where two shapes have one.' },
  counting: { title: 'Rhythm: quarters, eighths, sixteenths', artist: 'Exercise', tempo: 70, level: 'Beginner', tex: counting, tip: 'Tap your foot on every beat. Count 1 2 3 4, then 1 & 2 &, then 1 e & a.' },
  slides: { title: 'Technique: Slides', artist: 'Exercise', tempo: 70, level: 'Intermediate', tex: slides, tip: 'Keep the pressure on while the finger travels; land exactly on the fret.' },
  bends: { title: 'Technique: Bends to pitch', artist: 'Exercise', tempo: 60, level: 'Intermediate', tex: bends, tip: 'Play the target note first, then bend the lower one until it sounds the same. Use three fingers.' },
  vibrato: { title: 'Technique: Vibrato', artist: 'Exercise', tempo: 60, level: 'Intermediate', tex: vibrato, tip: 'Rock the wrist, not the finger. Slow and wide first, then faster and smaller.' },
};
for (const [id, e] of Object.entries(EXERCISES)) e.id = id;

/** The Practice page, top to bottom. An item is an exercise id, `{ drill }` (a drill page, see practicehub.js) or `{ href, title, blurb }`. */
export const FOUNDATIONS = [
  { id: 'warmup', title: 'Warm-ups', blurb: 'Loosen up first. Slow and clean beats fast and sloppy.', items: ['chromatic', 'spider', 'picking', 'legato'] },
  { id: 'scales', title: 'Scales', blurb: 'The notes every solo and melody is made of.', items: ['pent1', 'pent2', 'majpent', 'major', 'minor', 'blues', { drill: 'scales' }] },
  { id: 'chords', title: 'Chords and changes', blurb: 'Clean chords first, then clean changes between them.', items: ['open1', 'open2', { drill: 'keys' }] },
  { id: 'rhythm', title: 'Rhythm and timing', blurb: 'Play in time with a click, and hear how early or late you are.', items: ['counting', { drill: 'strum' }, { drill: 'tools' }] },
  { id: 'technique', title: 'Technique', blurb: 'The moves that make a part sound like a guitarist played it.', items: ['slides', 'bends', 'vibrato'] },
  { id: 'ear', title: 'Ear and theory', blurb: 'Know the neck, know the keys, hear the notes.', items: [{ href: '#keys', title: 'Know the neck', blurb: 'Name the notes on the fretboard, the circle of fifths and the chord finder.' }, { drill: 'vocal' }] },
];

/** Today's warm-up: about ten minutes, in this order. A step is an exercise id or a drill. */
export const ROUTINE = [
  { ex: 'chromatic', minutes: 2 },
  { ex: 'spider', minutes: 2 },
  { ex: 'picking', minutes: 1 },
  { ex: 'pent1', minutes: 3 },
  { drill: 'keys', minutes: 2 },
];
export const routineMinutes = (routine = ROUTINE) => routine.reduce((n, s) => n + s.minutes, 0);
export const stepKey = (step) => step.ex || `drill:${step.drill}`;

/**
 * Which steps are done on `day`: ticked by hand (`ticks`: { day, keys }), or a practice session today for that
 * exercise (matched by its title) or drill (by its id). sessions: { songId, title, start }.
 * @returns {Set<string>} step keys
 */
export function stepsDone({ routine = ROUTINE, sessions = [], ticks = null, now = Date.now(), drillId = (d) => `drill:${d}` }) {
  const startOfDay = new Date(new Date(now).toDateString()).getTime();
  const today = sessions.filter((s) => s.start >= startOfDay);
  const done = new Set(ticks && ticks.day === dayKey(now) ? ticks.keys : []);
  for (const step of routine) {
    const hit = step.ex ? today.some((s) => s.title === EXERCISES[step.ex].title) : today.some((s) => s.songId === drillId(step.drill));
    if (hit) done.add(stepKey(step));
  }
  return done;
}

/** "2026-10-27" in the local day. */
export const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** The first routine step not done yet, or null when the routine is finished. */
export const nextStep = (done, routine = ROUTINE) => routine.find((s) => !done.has(stepKey(s))) || null;
