// Making the chord sheet follow its video: each line can be given the video time it is sung at (tapped
// by you), the lines between two taps are spread evenly, and the sheet's lit line and scroll are worked
// out from the video's clock. Pure: no page code (js/sheetfollow.js does the lit line and the scrolling).
import { lineHash } from './chordsheetview.js';

/**
 * Number the sheet's lines in the order they are sung. A line is a "unit"; a run of tab lines (one
 * tab system) is one unit. Sets `u` on every line (and `uf` on the first line of a unit) and returns
 * [{ u, bi, hash, id }]: bi = the section, id = what a time is stored against: the line's content hash and
 * which time that line has been seen (a chorus line written twice has two units), so a time survives
 * edits elsewhere in the sheet.
 */
export function numberUnits(blocks) {
  const units = [];
  const seen = new Map();
  blocks.forEach((b, bi) => {
    let inTab = false;
    for (const l of b.lines) {
      if (l.t === 'note') { inTab = false; continue; }
      if (l.t === 'tab' && inTab) { l.u = units.length - 1; l.uf = false; continue; }
      const hash = lineHash(l);
      const n = seen.get(hash) || 0;
      seen.set(hash, n + 1);
      l.u = units.length;
      l.uf = true;
      units.push({ u: l.u, bi, hash, id: `${hash}#${n}` });
      inTab = l.t === 'tab';
    }
  });
  return units;
}

/**
 * Where each unit is on the page when repeats are folded (items = foldRepeats' result): { u } is the
 * line that shows it (a section written out twice in a row shows the first one's lines for both), { b } is
 * the "↻ Chorus" marker of section b standing in for it.
 */
export function displayTargets(units, items) {
  const home = new Map(); // section → its units
  for (const x of units) { if (!home.has(x.bi)) home.set(x.bi, []); home.get(x.bi).push(x.u); }
  const itemOf = new Map();
  for (const it of items) for (const bi of it.src || []) itemOf.set(bi, it);
  return units.map((x) => {
    const it = itemOf.get(x.bi);
    if (!it || it.marker) return { b: x.bi };
    const first = it.src[0];
    if (x.bi === first) return { u: x.u };
    const shown = home.get(first) || [];
    const at = home.get(x.bi).indexOf(x.u);
    return shown.length ? { u: shown[Math.min(at, shown.length - 1)] } : { b: first };
  });
}

/* ---------- the times you tapped: [{ id, t }] ---------- */

export const setMark = (marks, id, t) => [...(marks || []).filter((m) => m.id !== id), { id, t: Math.max(0, Math.round(t * 100) / 100) }].slice(-2000);
export const dropMark = (marks, id) => (marks || []).filter((m) => m.id !== id);

// the longest run of marks (in line order) whose times keep rising; a stray tap that doesn't fit is left out
function rising(list) {
  const tails = []; // tails[k] = index in list of the smallest end of a rising run of length k + 1
  const prev = new Array(list.length).fill(-1);
  list.forEach((m, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[tails[mid]].t < m.t) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const out = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.push(list[i]);
  return out.reverse();
}

/**
 * The marks that belong to this sheet: { all: [{ u, t }] by line, chain: the ones whose times rise with the
 * lines (what the sheet follows), bad: Set of units whose time doesn't fit }.
 */
export function chainOf(marks, units) {
  const at = new Map(units.map((x) => [x.id, x.u]));
  const all = (marks || []).filter((m) => at.has(m.id) && Number.isFinite(m.t)).map((m) => ({ u: at.get(m.id), t: m.t })).sort((a, b) => a.u - b.u);
  const chain = rising(all);
  const ok = new Set(chain.map((m) => m.u));
  return { all, chain, bad: new Set(all.filter((m) => !ok.has(m.u)).map((m) => m.u)) };
}

/** u → { t, bad } for the badges. */
export function marksMap(marks, units) {
  const { all, bad } = chainOf(marks, units);
  return new Map(all.map((m) => [m.u, { t: m.t, bad: bad.has(m.u) }]));
}

/** The line to tap next while timing: the one after the latest time tapped (the first, with none). */
export function nextUnit(marks, units) {
  const { all } = chainOf(marks, units);
  if (!units.length) return null;
  if (!all.length) return 0;
  const last = all.reduce((a, b) => (b.t > a.t ? b : a));
  return last.u + 1 < units.length ? last.u + 1 : null;
}

/* ---------- the video's time → a place in the sheet ---------- */

// seconds a line takes, as tapped (the median keeps a long instrumental gap from stretching it)
export function medianPace(chain) {
  const gaps = [];
  for (let i = 1; i < chain.length; i++) gaps.push((chain[i].t - chain[i - 1].t) / (chain[i].u - chain[i - 1].u));
  if (!gaps.length) return 4;
  gaps.sort((a, b) => a - b);
  return Math.max(0.5, gaps[gaps.length >> 1]);
}

/**
 * The place in the sheet at video time T, as a line number with a fraction (3.5: halfway from line 3
 * to line 4), or null before the first tapped line (an intro) or with fewer than two taps. Lines
 * between two taps are spread evenly between their times; after the last tap the sheet carries on at the
 * song's usual pace until the final line (last = its number), which then stays.
 */
export function positionAt(chain, T, last) {
  const n = chain.length;
  if (n < 2 || !(T >= chain[0].t)) return null;
  if (T >= chain[n - 1].t) return Math.min(last, chain[n - 1].u + (T - chain[n - 1].t) / medianPace(chain));
  let lo = 0, hi = n - 1; // chain[lo].t <= T < chain[hi].t
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (chain[mid].t <= T) lo = mid; else hi = mid; }
  const a = chain[lo], b = chain[hi];
  return a.u + ((T - a.t) / (b.t - a.t)) * (b.u - a.u);
}

/** One step of easing: cur moves toward target, covering most of the way in about 3 × tau seconds. */
export function follow(cur, target, dt, tau = 0.35) {
  if (!(dt > 0)) return cur;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}
