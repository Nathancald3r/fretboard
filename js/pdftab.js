// Turns a PDF of guitar tab into plain-text (ASCII) tab, which the app already plays.
//  - PDFs with a text layer: the text is read straight out of the page.
//  - Scanned / image-only PDFs (like Ultimate Guitar's "print" PDFs): the monospace tab lines
//    are read cell by cell with template matching, which is exact for the fonts tab sites use.
import { ATLAS, ATLAS_W, ATLAS_H } from './pdfatlas.js';
import { findStaves, readStrip, ugToAlphaTex, parseTuning, UG_UNIT } from './ugtab.js';
import { readLyricLine, holdLyricReader, closeLyricReader, readWords, drawBox } from './uglyrics.js';
import { findDrumStaves, readDrumStrip, flip } from './ugdrums.js';
import { findMusicStaves, readScorePage } from './ugscore.js';

const TEMPLATES = ATLAS.map(([ch, bits]) => ({ ch, bits: Uint8Array.from(bits, (c) => +c) }));
const PAGE_WIDTH = 1634; // the width the templates were made at
const PITCH = 11.2;      // character width at that size
export let probe = null; // used by tools to collect glyph bitmaps
export const setProbe = (p) => { probe = p; };
const MAX_MISS = 40;     // most pixels a glyph may differ from its template

/* ---------- image reader ---------- */

function rowRuns(ink, w, h, x0, x1) {
  const runs = [];
  let s = -1;
  for (let y = 0; y < h; y++) {
    let any = false;
    for (let x = x0; x < x1 && !any; x++) any = ink[y * w + x] === 1;
    if (any && s < 0) s = y;
    if (!any && s >= 0) { runs.push([s, y - 1]); s = -1; }
  }
  if (s >= 0) runs.push([s, h - 1]);
  return runs;
}

// Rows that are long dashed lines, i.e. the strings of a tab.
function tabRows(ink, w, x0, x1, runs) {
  return runs.filter(([y0, y1]) => {
    let lo = Infinity, hi = -1, mid = 0;
    const ym = ((y1 - y0) >> 1) + y0;
    for (let x = x0; x < x1; x++) {
      let any = false;
      for (let y = y0; y <= y1 && !any; y++) any = ink[y * w + x] === 1;
      if (any) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
      for (let y = ym - 1; y <= ym + 2; y++) if (ink[y * w + x]) { mid++; break; }
    }
    return hi - lo > 200 && mid > 80;
  });
}

// Systems = groups of 6 rows (12 when a bar wrapped onto an unlabelled second line).
function groupRows(rows) {
  const out = [];
  let cur = [];
  for (const r of rows) {
    if (cur.length && r[0] - cur[cur.length - 1][1] > 20) { out.push(cur); cur = []; }
    cur.push(r);
  }
  if (cur.length) out.push(cur);
  return out.filter((g) => g.length >= 6);
}

function fit(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  return [slope, my - slope * mx];
}

const inkAt = (ink, w, x, y0, y1) => {
  for (let y = y0; y <= y1; y++) if (ink[y * w + x]) return true;
  return false;
};

function startsIn(ink, w, x0, x1, y0, y1, minW, maxW) {
  const out = [];
  let x = x0;
  while (x < x1) {
    if (inkAt(ink, w, x, y0, y1)) {
      let j = x;
      while (j < x1 && inkAt(ink, w, j, y0, y1)) j++;
      if (j - x >= minW && j - x <= maxW) out.push(x);
      x = j;
    } else x++;
  }
  return out;
}

// Character pitch from the spacing of the dashes.
function pitchOf(ink, w, x0, x1, rows) {
  let best = [];
  for (const [y0, y1] of rows) {
    const prof = [];
    for (let x = x0; x < x1; x++) prof.push(inkAt(ink, w, x, y0, y1));
    const starts = [];
    for (let i = 1; i < prof.length; i++) if (prof[i] && !prof[i - 1]) starts.push(i);
    let run = [starts[0]];
    for (const s of starts.slice(1)) {
      if (s - run[run.length - 1] >= 9 && s - run[run.length - 1] <= 13) run.push(s);
      else { if (run.length > best.length) best = run; run = [s]; }
    }
    if (run.length > best.length) best = run;
  }
  if (best.length < 4) return null;
  return fit(best.map((_, i) => i), best)[0];
}

function classify(c) {
  let ink = 0;
  for (let i = 0; i < c.length; i++) ink += c[i];
  if (!ink) return ' ';
  let best = Infinity, bestCh = '?';
  const m = new Uint8Array(c.length);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      m.fill(0);
      for (let y = 0; y < ATLAS_H; y++) {
        for (let x = 0; x < ATLAS_W; x++) {
          if (c[y * ATLAS_W + x]) m[((y + dy + ATLAS_H) % ATLAS_H) * ATLAS_W + ((x + dx + ATLAS_W) % ATLAS_W)] = 1;
        }
      }
      for (const t of TEMPLATES) {
        let d = 0;
        for (let i = 0; i < m.length && d < best; i++) d += m[i] ^ t.bits[i];
        if (d < best) { best = d; bestCh = t.ch; }
      }
    }
  }
  return best <= MAX_MISS ? bestCh : '?';
}

// Reads the six string rows of one system (or one wrapped half) into six strings.
function readRows(ink, w, x0, x1, rows) {
  rows = rows.slice(0, 6);
  const p0 = pitchOf(ink, w, x0, x1, rows);
  if (!p0) return null;
  const starts = [];
  for (const [ya, yb] of rows) {
    const yc = (ya + yb) >> 1;
    starts.push(...startsIn(ink, w, x0, x1, yc - 1, yc + 2, 6, 8));
  }
  if (starts.length < 8) return null;
  let p = p0;
  let ref = starts[0];
  for (let i = 0; i < 4; i++) [p, ref] = fit(starts.map((s) => Math.round((s - ref) / p)), starts);
  let lo = x1, hi = x0;
  for (let x = x0; x < x1; x++) if (inkAt(ink, w, x, rows[0][0], rows[0][1])) { lo = Math.min(lo, x); hi = x; }
  const k0 = Math.floor((lo + 3.5 - (ref + 3.5)) / p + 0.5);
  const n = Math.floor((hi + 6 - (ref + 3.5)) / p - k0) + 1;
  const cell = new Uint8Array(ATLAS_W * ATLAS_H);
  const keep = [];
  const done = rows.map(([ya, yb]) => {
    const yc = (ya + yb) >> 1;
    let line = '';
    const cellsHere = [];
    for (let k = 0; k < n; k++) {
      const xc = ref + 3.5 + (k0 + k) * p;
      const xa = Math.round(xc - p / 2);
      const xb = Math.round(xc + p / 2);
      cell.fill(0);
      for (let y = 0; y < ATLAS_H; y++) {
        for (let x = 0; x < Math.min(ATLAS_W, xb - xa); x++) {
          const px = xa + x, py = yc - 10 + y;
          if (px >= 0 && px < w && py >= 0 && cell && ink[py * w + px]) cell[y * ATLAS_W + x] = 1;
        }
      }
      const ch = classify(cell);
      cellsHere.push([ch, Array.from(cell).join('')]);
      line += ch;
    }
    keep.push(cellsHere);
    return line;
  });
  if (probe) probe.push(keep);
  return done;
}

// Two-column pages: a vertical channel that (almost) no line of text crosses.
function columnSplit(ink, w, h) {
  const lines = rowRuns(ink, w, h, 0, w).filter(([a, b]) => b - a >= 8);
  const hits = new Uint32Array(w);
  const total = new Uint32Array(w);
  for (const [y0, y1] of lines) {
    for (let x = 0; x < w; x++) {
      if (inkAt(ink, w, x, y0, y1)) hits[x]++;
      for (let y = y0; y <= y1; y++) if (ink[y * w + x]) total[x]++;
    }
  }
  const lo = Math.floor(w * 0.35), hi = Math.ceil(w * 0.65);
  const limit = Math.max(1, lines.length * 0.1);
  let best = null, s = -1;
  for (let x = lo; x <= hi; x++) {
    const open = hits[x] <= limit;
    if (open && s < 0) s = x;
    if ((!open || x === hi) && s >= 0) {
      if (x - s >= 25 && (!best || x - s > best[1] - best[0])) best = [s, x];
      s = -1;
    }
  }
  if (!best) return [[0, w]];
  const sum = (a, b) => { let t = 0; for (let x = a; x < b; x++) t += total[x]; return t; };
  return sum(0, best[0]) > 2000 && sum(best[1], w) > 2000 ? [[0, best[0]], [best[1], w]] : [[0, w]];
}

/**
 * Reads every tab system on one rendered page.
 * @returns {{ systems: string[][], pitch: number|null, unknown: number }}
 */
export function readTabPage(ink, w, h) {
  const systems = [];
  let pitch = null, unknown = 0;
  for (const [x0, x1] of columnSplit(ink, w, h)) {
    const runs = rowRuns(ink, w, h, x0, x1);
    for (const g of groupRows(tabRows(ink, w, x0, x1, runs))) {
      const head = readRows(ink, w, x0, x1, g);
      if (!head) continue;
      pitch = pitch || pitchOf(ink, w, x0, x1, g.slice(0, 6));
      let rows = head;
      if (g.length >= 12) {
        const tail = readRows(ink, w, x0, x1, g.slice(6, 12));
        if (tail) rows = rows.map((r, i) => r + tail[i]);
      }
      unknown += rows.join('').split('?').length - 1;
      systems.push(rows);
    }
  }
  return { systems, pitch, unknown };
}

/* ---------- PDF reader ---------- */

let pdfjs = null;
export async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

export async function renderInk(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const ink = new Uint8Array(width * height);
  const light = new Uint8Array(width * height); // also the pale staff lines
  for (let i = 0; i < ink.length; i++) {
    const g = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
    ink[i] = g < 150 ? 1 : 0;
    light[i] = g < 205 ? 1 : 0;
  }
  // a pale 1-px line drawn across two pixel rows leaves both too pale to count (a Synth Pad's staff
  // was lost on three pages): a pale pair with white above and below is one line, on its upper row
  const gray = (i) => (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
  for (let y = 1; y + 2 < height; y++) {
    for (let x = 0, i = y * width; x < width; x++, i++) {
      if (light[i] || light[i + width]) continue;
      const a = gray(i), b = gray(i + width);
      if (a < 240 && b < 240 && a + b < 455 && gray(i - width) >= 240 && gray(i + 2 * width) >= 240) light[i] = 1;
    }
  }
  return { ink, light, w: width, h: height };
}

// Lines of text from a page's text layer, with characters placed in monospace columns.
function textLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str) continue;
    const y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
    if (!row) rows.push((row = { y, items: [] }));
    row.items.push({ x: it.transform[4], s: it.str, w: it.width });
  }
  const widths = items.filter((i) => i.str.length >= 6 && /^[-|0-9]+$/.test(i.str)).map((i) => i.width / i.str.length).sort((a, b) => a - b);
  const cw = widths.length ? widths[widths.length >> 1] : 0;
  return rows.sort((a, b) => b.y - a.y).map((row) => {
    row.items.sort((a, b) => a.x - b.x);
    let line = '';
    for (const it of row.items) {
      const col = cw ? Math.round((it.x - row.items[0].x) / cw) + (line ? 0 : 0) : line.length;
      line = cw ? line.padEnd(col, ' ') + it.s : line + (line && !line.endsWith(' ') ? ' ' : '') + it.s;
    }
    return line;
  });
}

/* ---------- the "Notation" pages ---------- */
// The UG helper adds the same score drawn with its music staff after a page headed "Notation":
// only there does the player print the dynamics (mf, f) and words such as "w/sustainer". Their
// tab staves are read for where the bars and notes are; the words go on the same notes of the
// tab pages, which hold the rhythm.

const DYNAMICS = new Set(['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff']);
const SECTION = /^(intro|verse|pre-?chorus|chorus|bridge|outro|interlude|instrumental|solo|tag|ending|turnaround|refrain|vamp|coda|break|riff|notation)\b/i;
const CHORD = /^[A-G][#b♯♭]?(m|maj|min|dim|aug|sus|add|M)?\d*(sus\d*|add\d*|maj\d*|b\d+|#\d+)*(\/[A-G][#b♯♭]?)?$/;

/** Tesseract words from above a music staff -> [{ x, txt }] ("w/sustainer", "let ring"); exported for tests. */
export function notationText(words, u) {
  const out = [];
  const lines = [];
  for (const w of [...words].sort((a, b) => a.x0 - b.x0)) {
    if (!w.text.trim()) continue;
    // words in a row with small gaps make one phrase ("let ring")
    const ln = lines.find((l) => Math.abs(l.y - (w.y0 + w.y1) / 2) < 0.6 * u && w.x0 - l.x1 < 1.6 * u);
    if (ln) { ln.words.push(w); ln.x1 = w.x1; } else lines.push({ y: (w.y0 + w.y1) / 2, x1: w.x1, words: [w] });
  }
  for (const l of lines) {
    let ws = l.words.map((w) => w.text.trim());
    if (ws.some((t) => !/^[A-Za-z][A-Za-z./'-]*$/.test(t))) continue; // digits, symbols: a tempo mark, notes read as letters
    if (ws.length > 1 && /^w[rl1|/]?$/i.test(ws[0])) ws = [`w/${ws[1]}`, ...ws.slice(2)]; // "w/" read as "wr"
    const text = ws.join(' ');
    const letters = text.replace(/[^A-Za-z]/g, '');
    const conf = l.words.reduce((a, w) => a + w.conf, 0) / l.words.length;
    // UPPER-case runs are noteheads and beams read as letters; real marks are words in lower case
    if (letters.length < 5 || !/[a-z]{4}/.test(text) || letters.replace(/[^A-Z]/g, '').length > 1 || conf < 20) continue;
    if (SECTION.test(text) || /tuning/i.test(text) || ws.some((t) => CHORD.test(t))) continue;
    if (l.words.some((w) => w.y1 - w.y0 > 2 * u)) continue;
    out.push({ x: l.words[0].x0, txt: text });
  }
  return out;
}

// Ink pieces (8-connected) in a box of the page.
function inkBlobs(ink, w, x0, y0, x1, y1) {
  [x0, y0, x1, y1] = [Math.max(0, Math.round(x0)), Math.max(0, Math.round(y0)), Math.min(w, Math.round(x1)), Math.round(y1)];
  const bw = x1 - x0, bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return [];
  const seen = new Uint8Array(bw * bh);
  const out = [];
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (seen[y * bw + x] || !ink[(y + y0) * w + x + x0]) continue;
      const b = { x0: x, y0: y, x1: x, y1: y, n: 0 };
      const st = [y * bw + x];
      seen[y * bw + x] = 1;
      while (st.length) {
        const i = st.pop(), cx = i % bw, cy = (i - cx) / bw;
        b.n++;
        if (cx < b.x0) b.x0 = cx; if (cx > b.x1) b.x1 = cx; if (cy < b.y0) b.y0 = cy; if (cy > b.y1) b.y1 = cy;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh || seen[ny * bw + nx] || !ink[(ny + y0) * w + nx + x0]) continue;
          seen[ny * bw + nx] = 1;
          st.push(ny * bw + nx);
        }
      }
      out.push({ x0: b.x0 + x0, y0: b.y0 + y0, x1: b.x1 + x0 + 1, y1: b.y1 + y0 + 1, n: b.n });
    }
  }
  return out;
}

// The five lines of the music staff drawn above a tab staff (between y0 and y1): [top, bottom] or null.
function musicStaff(light, w, x0, x1, y0, y1) {
  const lines = [];
  for (let y = Math.max(0, Math.round(y0)); y < Math.round(y1); y++) {
    let n = 0;
    for (let x = Math.round(x0); x < Math.round(x1); x++) n += light[y * w + x];
    if (n < 0.6 * (x1 - x0)) continue;
    const last = lines[lines.length - 1];
    if (last && y - last.y1 <= 1) last.y1 = y; else lines.push({ y0: y, y1: y });
  }
  const ys = lines.map((l) => (l.y0 + l.y1) / 2);
  for (let k = ys.length - 5; k >= 0; k--) {
    const gaps = [1, 2, 3, 4].map((i) => ys[k + i] - ys[k + i - 1]);
    if (Math.max(...gaps) - Math.min(...gaps) <= 2 && gaps[0] > 4) return [ys[k], ys[k + 4]];
  }
  return null;
}

/** The marks around one tab staff of a Notation page: dynamics under its music staff, words above it. */
async function notationMarks(page, scale, r, st, top) {
  const u = st.u, x0 = st.x0 - 2 * u, x1 = st.x1 + u;
  const ms = musicStaff(r.light, r.w, st.x0, st.x1, top, st.ys[0] - u);
  if (!ms) return [];
  const out = [];
  // words: above the music staff, with the wavy lines and ties wiped out first
  const tTop = Math.max(top, ms[0] - 6 * u), tBot = ms[0] - 0.2 * u;
  // the whole box is drawn once; each read below is cut from it (a page render per read cost ~65 ms, 200+ reads a part)
  const src = await drawBox(page, scale, x0 - u - 2, tTop - 2, x1 + u + 2, st.ys[0] + u + 2);
  const flat = inkBlobs(r.ink, r.w, x0, tTop, x1, tBot).filter((b) => b.y1 - b.y0 <= 0.6 * u && b.x1 - b.x0 >= 1.2 * u);
  out.push(...notationText(await readWords(page, scale, x0, tTop, x1, tBot, { wipe: flat, src }), u));
  out.push(...await readDynamics(page, scale, r, x0, x1, ms[1] + 0.3 * u, st.ys[0] - 0.7 * u, u, src));
  return out.sort((a, b) => a.x - b.x);
}

// How bold a group's strokes are: the share of its ink that has ink all round it, a tenth of a staff space out.
function thick(ink, w, g, u) {
  const d = Math.max(1, Math.round(0.1 * u));
  let n = 0, all = 0;
  for (let y = g.y0 + d; y < g.y1 - d; y++) for (let x = g.x0 + d; x < g.x1 - d; x++) {
    if (!ink[y * w + x]) continue;
    all++;
    if (ink[(y - d) * w + x] && ink[(y + d) * w + x] && ink[y * w + x - d] && ink[y * w + x + d]) n++;
  }
  return all ? n / all : 0;
}

// Dynamics: bold letters in a box (under a music staff), each piece read on its own as p, m or f letters.
// `sheet`: a sheet-music system, where u is the music staff's space and the lyrics sit in the same box.
async function readDynamics(page, scale, r, x0, x1, dTop, dBot, u, src, sheet = false) {
  const out = [];
  const pieces = inkBlobs(r.ink, r.w, x0, dTop, x1, dBot).filter((b) => b.y1 - b.y0 >= 0.3 * u && b.x1 - b.x0 >= 0.25 * u);
  pieces.sort((a, b) => a.x0 - b.x0);
  const groups = [];
  for (const b of pieces) {
    const g = groups[groups.length - 1];
    if (g && b.x0 - g.x1 < 0.3 * u && b.y0 < g.y1 && b.y1 > g.y0) { g.x1 = Math.max(g.x1, b.x1); g.y0 = Math.min(g.y0, b.y0); g.y1 = Math.max(g.y1, b.y1); g.n += b.n; g.parts.push(b); } else groups.push({ ...b, parts: [b] });
  }
  const rowInk = (g, y) => { let n = 0; for (let x = g.x0; x < g.x1; x++) n += r.ink[y * r.w + x] ? 1 : 0; return n; };
  for (const g of groups) {
    // a mark touching a stem that runs into the box (a note of the staff above or below): cut the stem off
    if (g.y0 <= dTop + 1) while (g.y0 < g.y1 && rowInk(g, g.y0) <= 0.25 * u) g.y0++;
    if (g.y1 >= dBot - 1) while (g.y1 > g.y0 && rowInk(g, g.y1 - 1) <= 0.25 * u) g.y1--;
    const gw = g.x1 - g.x0, gh = g.y1 - g.y0;
    // a piece still cut off at the top of the box is a note hanging from the staff, not a letter
    if (g.y0 <= dTop + 1 || gh < 0.6 * u || gh > 2.2 * u || gw > 4 * u || g.n < 0.18 * gw * gh) continue;
    // the marks are bold (0.15+ of their ink is deep inside a stroke), the lyrics' letters thin (0.11 at most);
    // an m on its own is short and is read with the letter beside it
    const th = sheet ? thick(r.ink, r.w, g, u) : 0;
    if (sheet && (gh < 1.2 * u || th < 0.14)) continue;
    const ws = await readWords(page, scale, g.x0 - u, g.y0 - u, g.x1 + u, g.y1 + u, { psm: '8', chars: 'pmf', lines: false, src });
    let t = ws.map((w) => w.text.trim()).join('');
    let conf = ws.length ? Math.min(...ws.map((w) => w.conf)) : 0;
    // "mf" and "mp" often come back as "f" and "p": a short piece (the m) in front of the tall letter says so
    if ((t === 'f' || t === 'p') && g.parts.length > 1 && g.parts[0].y1 - g.parts[0].y0 <= 0.65 * gh) { t = 'm' + t; conf = 100; }
    // nothing read (a lyric beside it can throw the reader): a lone bold letter is known by its height,
    // p 1.4 staff spaces, f 2.1 (noteheads are bolder still)
    if (sheet && !t && g.parts.length === 1 && th < 0.35) {
      if (gh >= 1.25 * u && gh <= 1.6 * u) t = 'p';
      else if (gh >= 1.9 * u && gh <= 2.2 * u) t = 'f';
    }
    // a lone f or p comes back with no confidence at all: its tall bold shape vouches for it
    if (DYNAMICS.has(t) && (conf >= 40 || (/^(f+|p+)$/.test(t) && gh >= 1.3 * u && g.n >= 0.2 * gw * gh))) out.push({ x: g.x0, cx: (g.x0 + g.x1) / 2, dy: t });
  }
  return out;
}

// The dynamics under each staff of a sheet-music system go on the first note at or after them (e.dy).
async function scoreDynamics(page, scale, r, sys) {
  const u = sys.u, [x0, x1] = sys.sx;
  for (let k = 0; k < sys.ys.length; k++) {
    // under the staff, above the next one (or 6 spaces down); the lyrics' letters are thin, not bold
    const dTop = sys.ys[k][1] + 0.3 * u, dBot = k + 1 < sys.ys.length ? sys.ys[k + 1][0] - 0.7 * u : sys.ys[k][1] + 6 * u;
    if (dBot - dTop < 1.5 * u) continue;
    const src = await drawBox(page, scale, x0 - 2 * u, dTop - 2, x1 + u, dBot + 2);
    const got = [];
    for (const m of await readDynamics(page, scale, r, x0, x1, dTop, dBot, u, src, true)) {
      const bar = sys.bars.find((b) => m.x >= b.x0 - 0.5 * u && m.x < b.x1);
      const evs = bar?.staves[k]?.filter((e) => e.notes.length).sort((a, b) => a.x - b.x);
      if (!evs?.length) continue;
      // the note it sits under: the nearest one
      let i = 0;
      evs.forEach((e, j) => { if (Math.abs(e.x - m.cx) < Math.abs(evs[i].x - m.cx)) i = j; });
      got.push({ m, bar, evs, i });
    }
    // two marks in a bar keep their order on notes of their own ("p f" under a chord and the note after it)
    for (let j = got.length - 2; j >= 0; j--) if (got[j].bar === got[j + 1].bar && got[j].i >= got[j + 1].i) got[j].i = got[j + 1].i - 1;
    for (const { m, evs, i } of got) if (i >= 0) evs[i].dy = m.dy;
  }
}

// The bars of some strips in play order, a multi-bar rest counting as that many bars.
const playBars = (strips) => strips.flatMap((s) => s.bars.flatMap((b) => Array(Math.max(1, b.rest || 1)).fill(b)));
const playedCols = (b) => b.cols.filter((c) => c.notes?.length);

/** Puts the marks read on the Notation pages onto the same notes of the tab strips (as beat effects). */
export function applyNotationMarks(strips, noted) {
  const tab = playBars(strips);
  const marks = [];
  let at = 0;
  for (const { strip, marks: ms } of noted) {
    const bars = playBars([strip]);
    for (const m of ms) {
      let i = bars.findIndex((b) => m.x < b.x1);
      if (i < 0) continue;
      const cols = playedCols(bars[i]);
      let k = cols.findIndex((c) => c.cx >= m.x - 0.8 * (strip.u || 10));
      if (k < 0) { k = 0; i++; } // after the bar's last note: the next bar's first
      marks.push({ bar: at + i, k, m });
    }
    at += bars.length;
  }
  marks.sort((a, b) => a.bar - b.bar || a.k - b.k);
  let dyn = null;
  for (const { bar, k, m } of marks) {
    if (m.dy && m.dy === dyn) continue;
    let i = bar, c = null;
    while (i < tab.length && !c) { // a mark over a rest goes on the next note
      const cols = playedCols(tab[i]);
      c = i === bar ? cols[Math.min(k, cols.length - 1)] : cols[0];
      i++;
    }
    if (!c) continue;
    const fx = m.dy ? `dy ${m.dy}` : `txt "${m.txt.replace(/["\\]/g, '')}"`;
    if (!(c.fx ||= []).includes(fx)) c.fx.push(fx);
    if (m.dy) dyn = m.dy;
  }
}

const looksLikeTab = (lines) => lines.filter((l) => /-{4,}/.test(l) && /\|/.test(l)).length >= 6;

/**
 * @param {ArrayBuffer} buf the PDF
 * @returns {Promise<{ text: string, how: 'text'|'image', systems: number, unknown: number }>}
 */
export async function pdfToTab(buf, onProgress = () => {}, opts = {}) {
  const lib = await loadPdfjs();
  const task = lib.getDocument({ data: new Uint8Array(buf) });
  // opts.signal (an AbortSignal) stops the reading at once: the document is closed under it, which
  // ends a page being drawn, and the next step throws
  const { signal } = opts;
  const stop = () => task.destroy();
  signal?.addEventListener('abort', stop);
  holdLyricReader();
  try {
    const go = (...a) => { signal?.throwIfAborted(); onProgress(...a); };
    signal?.throwIfAborted();
    return await readPdf(await task.promise, go, opts);
  } finally {
    signal?.removeEventListener('abort', stop);
    await closeLyricReader();
    task.destroy().catch(() => {});
  }
}

async function readPdf(pdf, onProgress, { tempo = 100, title = '', artist = '', lyrics = true, bass = false, drums = null, dynamics = true }) {
  const pages = [];
  const seen = new Set();
  let how = 'image', unknown = 0, systems = 0;
  let tuning = null;
  let capo = null; // "Capo: 6th fret" (or "Capo: none") beside the tuning
  const strips = [];
  const noted = []; // tab staves of the Notation pages, with the marks above each
  let notation = false;
  let scoreKey = null; // a part written as notes: its key signature, for a system that shows none
  for (let n = 1; n <= pdf.numPages; n++) {
    onProgress(n, pdf.numPages);
    const page = await pdf.getPage(n);
    const items = (await page.getTextContent()).items;
    const lines = textLines(items);
    if (!drums && strips.length && items.some((i) => i.str.trim() === 'Notation')) notation = true;
    tuning ||= parseTuning(items.map((i) => i.str).join(' ')); // "Tuning: E A D G" under the title
    if (capo == null) { const m = items.map((i) => i.str).join(' ').match(/Capo:\s*(?:(\d+)|no|none)/i); if (m) capo = Number(m[1] || 0); }
    if (looksLikeTab(lines)) {
      how = 'text';
      pages.push(lines.join('\n'));
      continue;
    }
    const base = PAGE_WIDTH / page.getViewport({ scale: 1 }).width;
    let r = await renderInk(page, base);
    if (drums) { // drum notation (5-line staff) or a one-line percussion staff (shaker, tambourine...)
      let one = drums !== 'kit';
      let staves = findDrumStaves(r.light, r.w, r.h, one);
      if (!staves.length && !one) staves = findDrumStaves(r.light, r.w, r.h, (one = true)); // percussion on one line
      if (!staves.length) continue;
      how = 'staff';
      if (Math.abs(staves[0].u - UG_UNIT) > 0.6) {
        r = await renderInk(page, base * UG_UNIT / staves[0].u);
        staves = findDrumStaves(r.light, r.w, r.h, one);
      }
      const fl = flip(r.ink, r.w, r.h);
      for (let i = 0; i < staves.length; i++) {
        const strip = readDrumStrip(r.ink, r.light, r.w, r.h, staves[i], fl, { piece: drums === 'kit' ? 'shaker' : drums });
        if (!strip) continue;
        strip.lyr = [];
        strips.push(strip);
        onProgress(n, pdf.numPages, `line ${i + 1} of ${staves.length}`);
      }
      continue;
    }
    // a staff with as many lines as the tuning has strings (bass: 4); six-line guitar staves always
    // (a bass part whose PDF doesn't say its tuning: four strings)
    const counts = [...new Set([6, tuning?.length || (bass ? 4 : 6)])];
    // the page's tab staves share one line spacing; a music staff taken for one (its lines and a
    // ledger line or beam) is closer set
    const tabSize = (st) => {
      const m = st.map((s) => s.u).sort((a, b) => a - b)[st.length >> 1];
      return st.filter((s) => Math.abs(s.u - m) < 0.2 * m);
    };
    let staves = tabSize(findStaves(r.light, r.w, r.h, r.ink, counts));
    if (staves.length) { // a graphic TAB staff (Ultimate Guitar Tab Pro)
      how = 'staff';
      let scale = base;
      if (Math.abs(staves[0].u - UG_UNIT) > 0.6) {
        const found = staves.length;
        scale = base * UG_UNIT / staves[0].u;
        r = await renderInk(page, scale);
        staves = tabSize(findStaves(r.light, r.w, r.h, r.ink, counts));
        // at this size a pale staff line can fall across two pixel rows, both too pale to count, and
        // its staff is lost: a hair larger or smaller puts it on one row
        for (const k of [1.01, 0.99]) {
          if (staves.length >= found) break;
          const r2 = await renderInk(page, scale * k);
          const st2 = tabSize(findStaves(r2.light, r2.w, r2.h, r2.ink, counts));
          if (st2.length > staves.length) { r = r2; staves = st2; scale *= k; }
        }
      }
      for (let i = 0; i < staves.length; i++) {
        const st = staves[i];
        const strip = readStrip(r.ink, r.light, r.w, r.h, st);
        if (!strip) continue;
        if (notation) { // the gap from the staff above (or the page top) holds the music staff and the marks
          strip.u = st.u;
          const top = i ? staves[i - 1].ys[staves[i - 1].ys.length - 1] + 1.5 * st.u : 0;
          const marks = await notationMarks(page, scale, r, st, top);
          noted.push({ strip, marks });
          continue;
        }
        if (tuning?.length === strip.strings) strip.tuning = tuning;
        if (capo != null) strip.capo = capo;
        strip.lyr = lyrics ? await readLyricLine(page, scale, st, r.h) : []; // the line under the rhythm row
        strips.push(strip);
        onProgress(n, pdf.numPages, `line ${i + 1} of ${staves.length}`);
      }
      continue;
    }
    // no tab: a part written as notes only (a piano's grand staff, keys, strings) is read note by note
    if (!strips.some((s) => !s.score)) {
      const music = findMusicStaves(r.light, r.w, r.h);
      if (music.length) {
        const u = music.map((s) => s.u).sort((a, b) => a - b)[music.length >> 1];
        const sc = Math.abs(u - UG_UNIT) > 0.6 ? base * UG_UNIT / u : base;
        if (sc !== base) r = await renderInk(page, sc);
        const got = readScorePage(r.ink, r.light, r.w, r.h, scoreKey);
        if (got.length) {
          if (dynamics) for (const sys of got) await scoreDynamics(page, sc, r, sys);
          how = 'score';
          scoreKey ??= got.flatMap((s) => s.keys).find((k) => k) ?? null;
          strips.push(...got);
          continue;
        }
      }
    }
    let res = readTabPage(r.ink, r.w, r.h);
    if (res.pitch && Math.abs(res.pitch - PITCH) > 0.25) { // different size: redo at the size the templates fit
      r = await renderInk(page, base * PITCH / res.pitch);
      res = readTabPage(r.ink, r.w, r.h);
    }
    unknown += res.unknown;
    const text = res.systems.map((s) => s.map((l) => l.replace(/\?/g, '-')).join('\n')).join('\n\n');
    if (seen.has(text)) continue; // some PDFs repeat a page
    seen.add(text);
    systems += res.systems.length;
    pages.push(text);
  }
  if (strips.length) {
    if (noted.length) applyNotationMarks(strips, noted);
    const made = ugToAlphaTex(strips, { tempo, title, artist });
    return made ? { tex: made.tex, text: '', how: 'staff', systems: strips.length, bars: made.bars, exact: made.exact, strips, unknown: 0 } : { text: '', how, systems: 0, unknown: 0 };
  }
  return { text: pages.filter(Boolean).join('\n\n'), how, systems, unknown };
}
