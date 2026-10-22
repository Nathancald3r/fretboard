// A chord sheet (chords written over the words, as Ultimate Guitar shows them) lined up with the
// song's sung words, so each chord lands on the bar and beat where its word is sung. The words are
// matched in order; a part the sheet doesn't write out again (a repeated chorus) is found by its
// first few words. Pure (no DOM): tested in tests/chordsheet.test.mjs.
import { lyricsTrack, buildLyrics } from './lyrics.js';

const CHORD = /^\(?[A-G][#b♯♭]?(?:maj|min|dim|aug|sus|add|m|M|\+|°|ø|-|\d|\(|\)|#|b)*(?:\/[A-G][#b♯♭]?)?\)?$/;
const FILLER = /^(?:\||\|\||x\d+|\d+x|N\.?C\.?|-+|\(|\)|\.+|%|\/)$/i;
const tidy = (c) => c.replace(/^\(|\)$/g, '').replace(/♯/g, '#').replace(/♭/g, 'b');

/** True for a line that holds only chord names (and bar lines, "x2" and the like). */
export function isChordLine(line) {
  const t = line.trim().split(/\s+/).filter(Boolean);
  return t.some((x) => CHORD.test(x)) && t.every((x) => CHORD.test(x) || FILLER.test(x));
}

export const norm = (w) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

const tokens = (line, re) => [...line.matchAll(re)].map((m) => ({ text: m[0], at: m.index, end: m.index + m[0].length }));

/**
 * The sheet's words in order, and its chords tied to them:
 *   { name, word, frac }    over a word (frac: how far into the word, 0..1)
 *   { name, after, k }      past the end of a line's words (k-th of them)
 *   { name, before, k, n }  before a word: the chords of a chord-only line (an intro), or left of a line's first word
 */
export function parseSheet(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const words = [];
  const chords = [];
  let pre = [];
  const addPre = (list) => { pre.push(...list.map((c) => tidy(c.text))); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*\[[^\]]*\]\s*$/.test(line)) continue;
    if (isChordLine(line)) {
      const found = tokens(line, /\S+/g).filter((t) => CHORD.test(t.text));
      const next = lines[i + 1];
      if (next === undefined || !next.trim() || isChordLine(next) || /^\s*\[[^\]]*\]\s*$/.test(next)) { addPre(found); continue; }
      // chords over the words of the next line
      const ws = tokens(next, /\S+/g).filter((t) => norm(t.text));
      i++;
      if (!ws.length) { addPre(found); continue; }
      const base = words.length;
      ws.forEach((t) => words.push(norm(t.text)));
      if (pre.length) { pre.forEach((name, k) => chords.push({ name, before: base, k, n: pre.length })); pre = []; }
      const lead = found.filter((c) => c.at < ws[0].at - 1);
      lead.forEach((c, k) => chords.push({ name: tidy(c.text), before: base, k, n: lead.length }));
      let after = 0;
      for (const c of found) {
        if (lead.includes(c)) continue;
        const w = ws.findIndex((t) => c.at >= t.at - 1 && c.at < t.end);
        if (w >= 0) { chords.push({ name: tidy(c.text), word: base + w, frac: Math.max(0, (c.at - ws[w].at) / (ws[w].end - ws[w].at)) }); continue; }
        const nextWord = ws.findIndex((t) => t.at > c.at);
        if (nextWord >= 0) chords.push({ name: tidy(c.text), word: base + nextWord, frac: 0 });
        else chords.push({ name: tidy(c.text), after: base + ws.length - 1, k: after++ });
      }
      continue;
    }
    // words with no chords over them
    const base = words.length;
    const ws = tokens(line, /\S+/g).filter((t) => norm(t.text));
    ws.forEach((t) => words.push(norm(t.text)));
    if (pre.length && ws.length) { pre.forEach((name, k) => chords.push({ name, before: base, k, n: pre.length })); pre = []; }
  }
  return { words, chords };
}

/** Each master bar's start and length in ticks, in written order (repeats not played out). */
export function barSpans(score) {
  let at = 0;
  return score.masterBars.map((mb) => {
    const length = mb.calculateDuration ? mb.calculateDuration() : 3840;
    const b = { start: at, length };
    at += length;
    return b;
  });
}

/** The sung words in master-bar order: [{ w, syl: [{ tick, text }] }] (ticks as in bars, from barSpans). */
export function sungWords(score, bars = barSpans(score), track = lyricsTrack(score)) {
  if (track < 0) return [];
  const lines = buildLyrics(score, track, bars.map((b, i) => ({ start: b.start, masterIndex: i })));
  const out = [];
  let open = null;
  for (const w of lines.flatMap((l) => l.words)) {
    for (const part of w.text.split(/\s+/).filter(Boolean)) { // a beat may carry two words
      if (!open) { open = { w: '', syl: [] }; out.push(open); }
      open.syl.push({ tick: w.tick, text: part });
      open.w += norm(part);
      if (!(w.joined && part === w.text.split(/\s+/).pop())) open = null;
    }
  }
  return out.filter((x) => x.w);
}

// For each sung word, the sheet word it is (-1: none).
export function matchWords(sung, sheet) {
  const S = sung.map((x) => x.w);
  const at = new Array(S.length).fill(-1);
  const same = (q, j, n) => { for (let d = 0; d < n; d++) if (sheet[q + d] !== S[j + d]) return false; return true; };
  let p = 0;
  for (let j = 0; j < S.length; j++) {
    if (sheet[p] === S[j]) { at[j] = p++; continue; }
    // a word or two left out on either side
    let q = -1;
    for (let d = 1; d <= 3 && q < 0; d++) if (sheet[p + d] === S[j] && (j + 1 >= S.length || sheet[p + d + 1] === S[j + 1])) q = p + d;
    // somewhere else in the sheet: the same three words (two near the end), later first, then earlier
    const n = Math.min(3, S.length - j);
    if (q < 0 && n >= 2) {
      for (let k = p; k + n <= sheet.length && q < 0; k++) if (same(k, j, n)) q = k;
      for (let k = 0; k < p && q < 0; k++) if (same(k, j, n)) q = k;
    }
    if (q >= 0) { at[j] = q; p = q + 1; }
  }
  return at;
}

/**
 * Chords per master bar from a chord sheet: [{ all: [{ offset, name }], shown }] like guessChords,
 * or null when the sheet's words don't fit the song (fewer than a third of the sung words found).
 * bars: [{ start, length }] per master bar.
 */
export function sheetChords(sheetText, sung, bars) {
  const { words, chords } = parseSheet(sheetText);
  if (!words.length || !chords.length || !sung.length || !bars.length) return null;
  const at = matchWords(sung, words);
  if (at.filter((x) => x >= 0).length < sung.length / 3) return null;
  const end = bars[bars.length - 1].start + bars[bars.length - 1].length;
  const barOf = (tick) => { let i = 0; while (i + 1 < bars.length && bars[i + 1].start <= tick) i++; return i; };
  const events = [];
  const byWord = new Map();
  for (const c of chords) {
    const key = c.word ?? c.after ?? c.before;
    if (!byWord.has(key)) byWord.set(key, []);
    byWord.get(key).push(c);
  }
  at.forEach((i, j) => {
    if (i < 0) return;
    const word = sung[j];
    const start = word.syl[0].tick;
    for (const c of byWord.get(i) || []) {
      if (c.word !== undefined) {
        // the syllable under the chord
        const lens = word.syl.map((s) => norm(s.text).length);
        const total = lens.reduce((a, b) => a + b, 0) || 1;
        let char = Math.round(c.frac * total), k = 0;
        while (k + 1 < lens.length && char >= lens[k]) { char -= lens[k]; k++; }
        events.push({ tick: word.syl[k].tick, name: c.name });
      } else if (c.before !== undefined) {
        // one bar each, ending at the word's bar (or the bar before, when the word starts its bar)
        const b = barOf(start);
        const last = bars[b].start === start ? b - 1 : b;
        const bar = last - (c.n - 1 - c.k);
        if (bar >= 0) events.push({ tick: bars[bar].start, name: c.name, soft: true });
      } else {
        // after the line's last word: the next bar(s), or halfway to the next word
        const next = sung[j + 1]?.syl[0].tick ?? end;
        const b = barOf(start) + 1 + c.k;
        const tick = b < bars.length && bars[b].start < next ? bars[b].start : Math.round((start + (next - start) / 2) / 960) * 960;
        if (tick > start && tick < end) events.push({ tick, name: c.name, soft: true });
      }
    }
  });
  events.sort((a, b) => a.tick - b.tick || (a.soft ? -1 : 1));
  // one chord per spot: the one over a word wins
  const list = [];
  for (const e of events) {
    const last = list[list.length - 1];
    if (last && last.tick === e.tick) { if (!e.soft || last.soft) list[list.length - 1] = e; continue; }
    list.push(e);
  }
  let previous = null;
  return bars.map((bar, i) => {
    const all = list.filter((e) => barOf(e.tick) === i).map((e) => ({ offset: e.tick - bar.start, name: e.name }));
    const shown = all.filter((c, k) => (k ? c.name !== all[k - 1].name : c.name !== previous));
    previous = all.at(-1)?.name ?? previous;
    return { all, shown };
  });
}
