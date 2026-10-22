// A sensible starting mix, like a live band's sound engineer would set: the lead vocal on
// top, the lead guitar and drums next, then bass, keys and rhythm guitars, with backing
// vocals, harmonies, pads and synths sitting behind. The file's own track volumes are evened
// out first (they are often left at random values), so every song starts balanced the same way.

// Level of each role, relative to the song's typical track (1 = unchanged).
export const LEVELS = {
  vocals: 1.3,
  backing: 0.8, // background singers and harmonies
  lead: 1.05,
  drums: 1.05,
  bass: 0.95,
  keys: 0.9,
  rhythm: 0.85,
  synth: 0.8,
  other: 0.85,
};
const MIN = 0.25;
const MAX = 1.5; // the mixer slider's top

const VOCAL = /vocal|voice|vox|sing|choir|lyric/i;
const VOCAL_PROGRAMS = [52, 53, 54, 85];
const BACKING = /back|bgv|bvs?\b|harmon|choir|ooh|aah|alto|tenor|soprano|baritone|2nd|second|third/i;
const BACKING_PROGRAMS = [52, 53]; // choir aahs, voice oohs
const LEAD = /lead|solo|melody|riff/i;
const RHYTHM = /rhythm|rhy\b|chords?|acoustic|steel|nylon|clean|strum/i;

/**
 * @param track {name, program, drums: bool, volume: file volume 0..16}
 * @param guitars how many guitar tracks the song has
 */
export function roleOf(track, guitars = 1, firstVocal = true) {
  const name = track.name || '';
  const p = track.program ?? -1;
  if (track.drums) return 'drums';
  if (VOCAL.test(name) || VOCAL_PROGRAMS.includes(p) || /harmon/i.test(name)) {
    if (/lead|main|melody/i.test(name)) return 'vocals';
    if (BACKING.test(name) || (BACKING_PROGRAMS.includes(p) && !/vocal|voice|sing|lyric/i.test(name))) return 'backing';
    return firstVocal ? 'vocals' : 'backing'; // more than one unnamed voice: the first leads
  }
  if (/bass/i.test(name) || (p >= 32 && p <= 39)) return 'bass';
  if (/guitar|gtr/i.test(name) || (p >= 24 && p <= 31)) {
    if (LEAD.test(name)) return 'lead';
    if (RHYTHM.test(name)) return 'rhythm';
    if (guitars === 1) return 'lead'; // the only guitar carries the song
    return p === 29 || p === 30 ? 'lead' : 'rhythm'; // overdriven / distortion usually plays the lead
  }
  if (/piano|key|organ|rhodes|wurli/i.test(name) || (p >= 0 && p <= 7) || (p >= 16 && p <= 20)) return 'keys';
  if (/synth|pad|string|ambient/i.test(name) || (p >= 48 && p <= 51) || (p >= 80 && p <= 103)) return 'synth';
  if (LEAD.test(name)) return 'lead';
  return 'other';
}

/** The starting mixer volume (slider value / 100) for each track. */
export function autoLevels(tracks) {
  const guitars = tracks.filter((t) => !t.drums && (/guitar|gtr/i.test(t.name || '') || (t.program >= 24 && t.program <= 31))
    && !/bass/i.test(t.name || '')).length;
  const vols = tracks.map((t) => t.volume).filter((v) => v > 0).sort((a, b) => a - b);
  const typical = vols.length ? vols[Math.floor(vols.length / 2)] : 0;
  let leadVocal = false;
  return tracks.map((t) => {
    const even = typical && t.volume > 0 ? typical / t.volume : 1;
    const role = roleOf(t, guitars, !leadVocal);
    if (role === 'vocals') leadVocal = true;
    const level = LEVELS[role] * even;
    return Math.round(Math.min(MAX, Math.max(MIN, level)) * 100) / 100;
  });
}
