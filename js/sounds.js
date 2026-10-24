// The instrument a track plays: a typed name ("vibes", "xylaphone", "upright bass") → the closest
// General MIDI sound in the soundfont. Pure (no DOM): tested in tests/sounds.test.mjs.
import { GM } from './midi.js';

// [name, General MIDI program]: the typical ones, offered as suggestions.
export const TYPICAL = [
  ['Acoustic guitar', 25], ['Nylon guitar', 24], ['Clean electric guitar', 27], ['Jazz guitar', 26],
  ['Overdriven guitar', 29], ['Distortion guitar', 30], ['Bass', 33], ['Acoustic bass', 32],
  ['Piano', 0], ['Electric piano', 4], ['Organ', 16], ['Strings', 48], ['Violin', 40], ['Cello', 42],
  ['Choir', 52], ['Brass', 61], ['Trumpet', 56], ['Sax', 65], ['Flute', 73],
  ['Synth pad', 89], ['Synth lead', 81], ['Bells', 14],
];
// Every sound, by name: the typical names first, then all 128 General MIDI ones.
export const SOUNDS = [...TYPICAL, ['Bass (pick)', 34], ...GM.map((name, p) => [name, p])]
  .filter(([name], k, all) => all.findIndex(([n]) => n.toLowerCase() === name.toLowerCase()) === k);

// Other names for a sound (matched, never listed).
const ALIASES = {
  keys: 0, keyboard: 0, 'grand piano': 0, 'upright piano': 0, rhodes: 4, wurlitzer: 4, 'e piano': 4, epiano: 4,
  clav: 7, celeste: 8, glock: 9, glockenspiel: 9, 'music box': 10, vibes: 11, vibraphone: 11, marimba: 12, xylophone: 13,
  chimes: 14, 'tubular bells': 14, 'church bells': 14, 'hand bells': 14, handbells: 14, dulcimer: 15, 'hammered dulcimer': 15,
  hammond: 16, 'b3': 16, 'pipe organ': 19, 'church organ': 19, harmonium: 20, accordion: 21, harmonica: 22, 'mouth organ': 22,
  ukulele: 24, uke: 24, classical: 24, 'classical guitar': 24, 'steel guitar': 25, '12 string': 25, mandolin: 25, 'rhythm guitar': 25,
  'electric guitar': 27, 'lead guitar': 29, crunch: 29, 'muted guitar': 28, 'palm mute': 28, 'clean guitar': 27,
  'upright bass': 32, 'double bass': 32, 'stand up bass': 32, 'bass guitar': 33, 'electric bass': 33, 'fretless bass': 35, 'slap bass': 36, 'synth bass': 38,
  viola: 41, violoncello: 42, contrabass: 43, harp: 46, timpani: 47, kettledrum: 47, 'kettle drum': 47,
  'string section': 48, orchestra: 48, 'string ensemble': 48, ensemble: 48, 'strings pad': 50,
  vocals: 52, vocal: 52, voice: 53, singer: 53, ooh: 53, aah: 52, 'backing vocals': 52, bgv: 52, 'orchestra hit': 55,
  horn: 60, horns: 61, 'french horn': 60, trombone: 57, tuba: 58, sousaphone: 58, euphonium: 58, flugelhorn: 56, cornet: 56,
  saxophone: 65, 'alto sax': 65, 'tenor sax': 66, 'baritone sax': 67, 'soprano sax': 64, oboe: 68, 'english horn': 69, 'cor anglais': 69,
  bassoon: 70, clarinet: 71, piccolo: 72, recorder: 74, 'pan flute': 75, panpipes: 75, 'pan pipes': 75, whistle: 78, 'tin whistle': 78, 'penny whistle': 78, ocarina: 79,
  synth: 81, lead: 81, 'synth lead': 81, pad: 89, 'synth pad': 89, 'warm pad': 89, atmosphere: 99, ambient: 88,
  sitar: 104, banjo: 105, shamisen: 106, koto: 107, kalimba: 108, 'thumb piano': 108, mbira: 108, bagpipe: 109, bagpipes: 109, shanai: 111, shehnai: 111,
  'tinkle bell': 112, agogo: 113, 'steel drum': 114, 'steel drums': 114, 'steel pan': 114, steelpan: 114,
  woodblock: 115, 'wood block': 115, 'temple block': 115, claves: 115, taiko: 116, 'taiko drum': 116,
  // hand drums: a pitched drum sound, played on the track's notes
  conga: 116, congas: 116, bongo: 117, bongos: 117, djembe: 116, cajon: 117, tabla: 117, tom: 117, toms: 117, 'melodic tom': 117, 'frame drum': 116,
  'synth drum': 118, 'electronic drum': 118,
};
// Drum-kit sounds: no pitched sound comes close, they play only on a drum track.
const KIT = /\b(shakers?|tambourines?|maracas?|cowbells?|cabasa|guiro|hand ?claps?|claps?|snares?|kicks?|bass drum|hi ?hats?|cymbals?|crash|ride|splash|triangles?|drums?|kit|percussion|rim ?shots?|sticks|machine)\b/g;

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const byProgram = (p) => SOUNDS.find(([, q]) => q === p);
export const soundName = (program) => byProgram(program)?.[0] || '';

// Typo distance (Levenshtein), stopped early once past max.
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...row) > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}
const allowed = (w) => (w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0);

// Every name a sound answers to: [normalised name, program].
const NAMES = [...SOUNDS.map(([n, p]) => [norm(n), p]), ...Object.entries(ALIASES).map(([n, p]) => [norm(n), p])];

/**
 * The sound a typed name means: [name, program], { drum: true } for a drum-kit sound, or null.
 * Tries the same name, then one starting with it, then the words in it (the last word,
 * "electric BASS", counting most), each word also with a typo or two ("xylaphone").
 */
export function soundFor(text) {
  const t = norm(text || '');
  if (!t) return null;
  const exact = NAMES.find(([n]) => n === t) || NAMES.find(([n]) => n === t.replace(/s$/, ''));
  if (exact) return byProgram(exact[1]);
  const kit = t !== t.replace(KIT, '');
  const rest = t.replace(KIT, ' ').replace(/ +/g, ' ').trim(); // "conga drum" is a conga
  if (kit && !rest) return { drum: true };
  if (kit) return soundFor(rest) || { drum: true };
  const start = t.length >= 3 && NAMES.find(([n]) => n.startsWith(t));
  if (start) return byProgram(start[1]);
  const words = t.split(' ').filter((w) => w.length > 2 && !/^(the|and|for|my)$/.test(w)).map((w) => w.replace(/(?<=..)s$/, ''));
  let best = null, top = 0;
  for (const [n, p] of NAMES) {
    const own = n.split(' ');
    const score = words.reduce((a, w, k) => {
      const weight = k === words.length - 1 ? 3 : 2;
      if (own.some((o) => o === w || o.replace(/s$/, '') === w)) return a + weight;
      if (own.some((o) => distance(o, w, allowed(w)) <= allowed(w))) return a + weight - 0.5;
      return a;
    }, 0) - own.length * 0.01; // a tie goes to the shorter name
    if (score > top) { best = p; top = score; }
  }
  return best == null ? null : byProgram(best);
}
