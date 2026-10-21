// Turns a PDF of guitar tab into plain-text (ASCII) tab, which the app already plays.
//  - PDFs with a text layer: the text is read straight out of the page.
//  - Scanned / image-only PDFs (like Ultimate Guitar's "print" PDFs): the monospace tab lines
//    are read cell by cell with template matching, which is exact for the fonts tab sites use.
import { ATLAS, ATLAS_W, ATLAS_H } from './pdfatlas.js';
import { findStaves, readStrip, ugToAlphaTex, UG_UNIT } from './ugtab.js';

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
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

async function renderInk(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const ink = new Uint8Array(width * height);
  const light = new Uint8Array(width * height); // also the pale staff lines
  for (let i = 0; i < ink.length; i++) {
    const g = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
    ink[i] = g < 150 ? 1 : 0;
    light[i] = g < 205 ? 1 : 0;
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

const looksLikeTab = (lines) => lines.filter((l) => /-{4,}/.test(l) && /\|/.test(l)).length >= 6;

/**
 * @param {ArrayBuffer} buf the PDF
 * @returns {Promise<{ text: string, how: 'text'|'image', systems: number, unknown: number }>}
 */
export async function pdfToTab(buf, onProgress = () => {}, { tempo = 100, title = '', artist = '' } = {}) {
  const lib = await loadPdfjs();
  const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
  const pages = [];
  const seen = new Set();
  let how = 'image', unknown = 0, systems = 0;
  const strips = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    onProgress(n, pdf.numPages);
    const page = await pdf.getPage(n);
    const lines = textLines((await page.getTextContent()).items);
    if (looksLikeTab(lines)) {
      how = 'text';
      pages.push(lines.join('\n'));
      continue;
    }
    const base = PAGE_WIDTH / page.getViewport({ scale: 1 }).width;
    let r = await renderInk(page, base);
    let staves = findStaves(r.light, r.w, r.h, r.ink);
    if (staves.length) { // a graphic TAB staff (Ultimate Guitar Tab Pro)
      how = 'staff';
      if (Math.abs(staves[0].u - UG_UNIT) > 0.6) {
        r = await renderInk(page, base * UG_UNIT / staves[0].u);
        staves = findStaves(r.light, r.w, r.h, r.ink);
      }
      for (const st of staves) {
        const strip = readStrip(r.ink, r.light, r.w, r.h, st);
        if (strip) strips.push(strip);
      }
      continue;
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
    const made = ugToAlphaTex(strips, { tempo, title, artist });
    return made ? { tex: made.tex, text: '', how: 'staff', systems: strips.length, bars: made.bars, exact: made.exact, unknown: 0 } : { text: '', how, systems: 0, unknown: 0 };
  }
  return { text: pages.filter(Boolean).join('\n\n'), how, systems, unknown };
}
