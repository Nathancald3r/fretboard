// What the chord sheet's floating tools need that isn't the page: notes tied to lines, the scroll speed,
// and the chords for a backing track. Pure (no DOM): tested in tests/sheettools.test.mjs.
import { NOTE_COLORS, lineHash, sectionHash, lineLabel } from './chordsheetview.js';

export { NOTE_COLORS };

/* ---------- scroll speed ---------- */

export const SPEED_MIN = 1;
export const SPEED_MAX = 20;
export const clampSpeed = (n) => Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.round(Number(n)) || 5));
/** How fast the sheet scrolls at a speed: pixels a second. */
export const pxPerSecond = (speed) => clampSpeed(speed) * 6;

/* ---------- notes ---------- */

/** A song's notes as a Map of line id → note. */
export const notesMap = (list) => new Map((Array.isArray(list) ? list : []).filter((n) => n && n.k).map((n) => [n.k, n]));

/**
 * The notes with one set for a line (or section) id: its words, a colour, and a few words of what the line
 * said (for when the line changes later). No words and no colour change is a plain highlight.
 */
export function setNote(list, { k, text = '', color = 'yellow', label = '', now = Date.now() }) {
  const rest = (Array.isArray(list) ? list : []).filter((n) => n.k !== k);
  const old = (Array.isArray(list) ? list : []).find((n) => n.k === k);
  return [...rest, {
    k,
    text: String(text).trim().slice(0, 400),
    color: NOTE_COLORS.includes(color) ? color : 'yellow',
    label: String(label || old?.label || '').slice(0, 60),
    at: old?.at || now,
  }];
}

export const dropNote = (list, k) => (Array.isArray(list) ? list : []).filter((n) => n.k !== k);

/** Every line and section id that the sheet has now. */
export function validIds(blocks) {
  const ids = new Set();
  for (const b of blocks) {
    if (b.name) ids.add(sectionHash(b.name));
    for (const l of b.lines) if (l.t !== 'note') ids.add(lineHash(l));
  }
  return ids;
}

/** The notes whose line is no longer in the sheet (it was edited). blocks: readSections(), whole. */
export function orphanNotes(list, blocks) {
  const ids = validIds(blocks);
  return (Array.isArray(list) ? list : []).filter((n) => n && n.k && !ids.has(n.k));
}

/** The id and a few words for a line or a section as read by readSections: { k, label }. */
export const idOfLine = (l) => ({ k: lineHash(l), label: lineLabel(l) });
export const idOfSection = (name) => ({ k: sectionHash(name), label: name });

/* ---------- a backing track from the sheet's chords ---------- */

/**
 * One bar a chord for the backing track: the chords in order, a chord that repeats straight away once,
 * ones with no shape left out, at most max bars. lookup: chord name → { root, type } (shapesFor).
 */
export function backingChords(names, lookup, max = 64) {
  const out = [];
  for (const name of names) {
    const s = lookup(name);
    if (!s) continue;
    if (out.length && out[out.length - 1].name === name) continue;
    out.push({ name, root: s.root, type: s.type });
    if (out.length >= max) break;
  }
  return out;
}
