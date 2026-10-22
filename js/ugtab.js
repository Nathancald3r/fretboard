// Reads Ultimate Guitar "Tab Pro" printouts (a graphic TAB staff with a rhythm row) from a rendered page:
// finds each staff, its bars and the bold fret numbers (template matching), then the rhythm row's
// stems, beams, flags and dots, and builds alphaTex. Image sizes are normalised to a staff
// spacing of UG_UNIT pixels by the caller (see pdftab.js).
import { UG_ATLAS, UG_W, UG_H } from './ugatlas.js';
import { readHeading, readRestCount } from './ugtext.js';

export const UG_UNIT = 18;
const TEMPLATES = UG_ATLAS.map(([ch, bits]) => ({ ch, bits: Uint8Array.from(bits, (c) => +c) }));
const MAX_MISS = 40;

/* ---------- staves and bars ---------- */

// Every group of equally spaced long horizontal lines: six for guitar, or another count the
// page's "Tuning:" line asks for (four for bass...). Five-line music staves are left alone.
export function findStaves(light, w, h, ink, counts = [6]) {
  const lines = [];
  for (let y = 0; y < h; y++) {
    let n = 0, run = 0, longest = 0;
    for (let x = 0; x < w; x++) {
      n += light[y * w + x];
      run = light[y * w + x] ? run + 1 : 0;
      if (run > longest) longest = run;
    }
    // staff lines span the page and are broken only by fret numbers; a text tab's dashes never join up
    if (n > 0.45 * w && longest > 20) {
      if (lines.length && y - lines[lines.length - 1].last <= 1) { const l = lines[lines.length - 1]; l.last = y; l.sum += y; l.n++; }
      else lines.push({ last: y, sum: y, n: 1 });
    }
  }
  const ys = lines.map((l) => l.sum / l.n);
  const out = [];
  for (let i = 0; i + 1 < ys.length;) {
    const gap = ys[i + 1] - ys[i];
    let j = i + 1; // the run of lines spaced like the first two
    while (j + 1 < ys.length && Math.abs(ys[j + 1] - ys[j] - gap) < 3) j++;
    const n = j - i + 1;
    // a longer run counts only if it splits evenly into six-line staves
    const size = counts.includes(n) ? n : n > 7 && n % 6 === 0 && counts.includes(6) ? 6 : 0;
    if (gap > 6 && size) {
      for (let k = i; k + size <= j + 1; k += size) {
        const rows = ys.slice(k, k + size);
        const y = Math.round(rows[0]);
        let x0 = 0, x1 = w - 1;
        while (x0 < w && !light[y * w + x0]) x0++;
        while (x1 > 0 && !light[y * w + x1]) x1--;
        out.push({ ys: rows, x0, x1, u: (rows[size - 1] - rows[0]) / (size - 1) });
      }
      i = j + 1;
    } else i++;
  }
  return out;
}

function barLines(light, w, st) {
  const t = Math.round(st.ys[0]), b = Math.round(st.ys[st.ys.length - 1]);
  const xs = [];
  for (let x = st.x0; x <= st.x1; x++) {
    let n = 0;
    for (let y = t; y <= b; y++) n += light[y * w + x];
    if (n >= 0.97 * (b - t + 1)) xs.push(x);
  }
  const groups = [];
  for (const x of xs) {
    if (groups.length && x - groups[groups.length - 1][groups[groups.length - 1].length - 1] <= 2) groups[groups.length - 1].push(x);
    else groups.push([x]);
  }
  const out = groups.map((g) => g.reduce((a, c) => a + c, 0) / g.length);
  // some systems end without a closing bar line: the staff's end closes the last bar
  if (out.length && st.x1 - out[out.length - 1] > 4 * st.u) out.push(st.x1);
  return out;
}

/* ---------- fret numbers ---------- */

function glyphAt(comp) {
  const box = new Uint8Array(UG_W * UG_H);
  const ox = (UG_W - comp.w) >> 1, oy = (UG_H - comp.h) >> 1;
  if (comp.w > UG_W || comp.h > UG_H) return null;
  for (const [x, y] of comp.px) box[(y - comp.y0 + oy) * UG_W + (x - comp.x0 + ox)] = 1;
  let best = Infinity, ch = null;
  for (const t of TEMPLATES) {
    let d = 0;
    for (let i = 0; i < box.length && d < best; i++) d += box[i] ^ t.bits[i];
    if (d < best) { best = d; ch = t.ch; }
  }
  return best <= MAX_MISS ? ch : null;
}

export function components(ink, w, st, bars, dropLines = false) {
  const u = st.u;
  const t = Math.max(0, Math.round(st.ys[0] - 0.8 * u)), b = Math.round(st.ys[st.ys.length - 1] + 0.8 * u);
  const seen = new Uint8Array(w * (b + 1));
  const isBar = (x) => bars.some((bx) => Math.abs(x - bx) <= 2);
  // Staff lines sometimes come through as ink (anti-aliasing). With dropLines, a pixel on a line row with
  // nothing just above and below it is taken as the line itself, so it doesn't glue rests to the lines
  // (notes keep them: it would cut the flat strokes of their digits).
  const lineRow = new Uint8Array(b + 3);
  for (const ly of st.ys) for (let y = Math.round(ly) - 1; y <= Math.round(ly) + 1; y++) if (y >= 0 && y <= b + 2) lineRow[y] = 1;
  const onLine = (x, y) => lineRow[y] && !ink[(y - 2) * w + x] && !ink[(y + 2) * w + x];
  if (dropLines) for (let y = t; y <= b; y++) for (let x = st.x0; x <= st.x1; x++) if (ink[y * w + x] && onLine(x, y)) seen[y * w + x] = 1;
  const comps = [];
  for (let y = t; y <= b; y++) {
    for (let x = st.x0; x <= st.x1; x++) {
      const i = y * w + x;
      if (!ink[i] || seen[i] || isBar(x)) continue;
      const px = [];
      const stack = [[x, y]];
      seen[i] = 1;
      let x0 = x, x1 = x, y0 = y, y1 = y;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        px.push([cx, cy]);
        x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < st.x0 || nx > st.x1 || ny < t || ny > b || isBar(nx)) continue;
            const j = ny * w + nx;
            if (ink[j] && !seen[j]) { seen[j] = 1; stack.push([nx, ny]); }
          }
        }
      }
      comps.push({ x0, x1: x1 + 1, y0, y1: y1 + 1, w: x1 - x0 + 1, h: y1 - y0 + 1, area: px.length, px });
    }
  }
  return comps;
}

function readNotes(ink, w, st, bars, comps = components(ink, w, st, bars)) {
  const u = st.u;
  const glyphs = [];
  for (const c of comps) {
    const cy = (c.y0 + c.y1) / 2;
    if (c.h < 0.45 * u || c.area < 18 || c.h > 1.3 * u || c.w > 1.3 * u || c.w <= 4) continue; // (a bracket is thinner than any digit)
    if (cy < st.ys[0] - 0.45 * u || cy > st.ys[st.ys.length - 1] + 0.45 * u) continue;
    const ch = glyphAt(c);
    if (ch === null) continue;
    let s = 0;
    st.ys.forEach((y, i) => { if (Math.abs(cy - y) < Math.abs(cy - st.ys[s])) s = i; });
    glyphs.push({ x0: c.x0, x1: c.x1, s, ch });
  }
  glyphs.sort((a, b) => a.s - b.s || a.x0 - b.x0);
  const notes = [];
  for (const g of glyphs) {
    const last = notes[notes.length - 1];
    if (last && last.s === g.s && g.x0 - last.x1 < 0.45 * u && last.t !== 'X' && g.ch !== 'X') { last.t += g.ch; last.x1 = g.x1; }
    else notes.push({ s: g.s, x0: g.x0, x1: g.x1, t: g.ch });
  }
  // "(8)": a note held over from before is written in brackets, which are thin upright curves either side of it
  // (they may touch the tie arcs, so they are looked for as a vertical run of ink rather than as a shape).
  const upright = (x, y) => {
    if (x <= 0 || x >= w || bars.some((b) => Math.abs(b - x) <= 2) || !ink[Math.round(y) * w + x]) return false;
    let run = 1;
    for (let d = 1; ink[(Math.round(y) - d) * w + x]; d++) run++;
    for (let d = 1; ink[(Math.round(y) + d) * w + x]; d++) run++;
    return run >= 4;
  };
  const bracket = (a, b, y) => { for (let x = Math.round(a); x <= Math.round(b); x++) if (upright(x, y)) return true; return false; };
  notes.forEach((n) => {
    n.cx = (n.x0 + n.x1) / 2;
    n.tied = bracket(n.x0 - 0.9 * u, n.x0 - 1, st.ys[n.s]) && bracket(n.x1 + 1, n.x1 + 0.9 * u, st.ys[n.s]);
  });
  return notes.sort((a, b) => a.cx - b.cx);
}

// Rests inside the staff: a quarter rest is a tall narrow zigzag, a sixteenth as tall but wider
// (two flags), an eighth about half as tall. A dot just after one makes it half as long again.
// Lengths in sixteenths.
function readRests(comps, st) {
  const u = st.u, top = st.ys[0], bot = st.ys[st.ys.length - 1];
  const rests = [];
  for (const c of comps) {
    const cy = (c.y0 + c.y1) / 2;
    if (cy < top || cy > bot || c.w < 0.4 * u || c.w > 0.95 * u || c.area < 0.15 * c.w * c.h) continue;
    let len = 0;
    if (c.h >= 1.7 * u && c.h <= 2.2 * u) len = c.w <= 0.7 * u ? 4 : 1;
    else if (c.h >= 1.0 * u && c.h <= 1.4 * u && c.w >= 0.55 * u) len = 2;
    if (!len) continue;
    const dot = comps.some((d) => d.w <= 0.4 * u && d.h <= 0.4 * u && d.area >= 6 && d.x0 >= c.x1 && d.x0 - c.x1 <= 0.8 * u && d.y0 >= c.y0 && d.y1 <= c.y1);
    rests.push({ cx: (c.x0 + c.x1) / 2, len: dot ? len * 1.5 : len, rest: true, notes: [] });
  }
  return rests;
}

/* ---------- rhythm row ---------- */

function stemsBelow(ink, w, h, st) {
  const u = st.u;
  const y0 = Math.round(st.ys[st.ys.length - 1] + 0.5 * u), y1 = Math.min(h - 1, Math.round(st.ys[st.ys.length - 1] + 3.2 * u));
  const cols = [];
  for (let x = st.x0; x <= st.x1; x++) {
    let best = 0, cur = 0, end = 0;
    for (let y = y0; y <= y1; y++) {
      cur = ink[y * w + x] ? cur + 1 : 0;
      if (cur > best) { best = cur; end = y; }
    }
    if (best >= 0.7 * u) cols.push({ x, top: end - best + 1, bot: end });
  }
  const groups = [];
  for (const c of cols) {
    const g = groups[groups.length - 1];
    if (g && c.x - g[g.length - 1].x <= 2) g.push(c); else groups.push([c]);
  }
  return groups.map((g) => ({
    x: g.reduce((a, c) => a + c.x, 0) / g.length,
    top: Math.min(...g.map((c) => c.top)),
    bot: Math.max(...g.map((c) => c.bot)),
  }));
}

function bandCount(ink, w, xa, xb, ya, yb) {
  xa = Math.round(xa); xb = Math.round(xb);
  let bands = 0, inBand = false;
  for (let y = ya; y <= yb; y++) {
    let n = 0;
    for (let x = xa; x <= xb; x++) n += ink[y * w + x];
    const on = n > 0.6 * (xb - xa + 1);
    if (on && !inBand) bands++;
    inBand = on;
  }
  return bands;
}

// What a stem says about the length of its note, in sixteenths.
export function stemLength(ink, w, s, u) {
  const x = s.x;
  const bottom = [s.bot - Math.round(1.0 * u), s.bot + 2]; // room for three beams (thirty-seconds)
  // Beams running from the stem at least 1.1 spaces to one side. Only the stem's own beams count: not the
  // next group's just past a gap, nor a neighbour's short stub that doesn't reach this stem.
  const joined = (d) => {
    const xs = Math.round(x), xe = Math.round(x + d * 1.1 * u), need = 0.9 * (Math.abs(xe - xs) + 1);
    let bands = 0, inBand = false;
    for (let y = bottom[0]; y <= bottom[1]; y++) {
      let n = 0;
      for (let xx = Math.min(xs, xe); xx <= Math.max(xs, xe); xx++) n += ink[y * w + xx];
      const on = n >= need;
      if (on && !inBand) bands++;
      inBand = on;
    }
    return bands;
  };
  const far = Math.max(joined(1), joined(-1));
  const xa = Math.round(x + 0.3 * u), xb = Math.round(x + 1.0 * u);
  if (far) { // beamed eighths / sixteenths; a dot sits beside the stem, above the beams
    let dot = false, run = 0, wide = false;
    for (let y = s.top - 2; y <= s.bot - Math.round(0.9 * u) && !dot; y++) {
      let n = 0;
      for (let xx = xa; xx <= xb; xx++) n += ink[y * w + xx];
      if (n) { run++; wide ||= n > 0.45 * u; } // a beam stub runs wider than a dot
      else { dot = run >= 3 && run <= 8 && !wide; run = 0; wide = false; }
    }
    // a sixteenth beside eighths has only a short second beam (a stub about half a space long) at its stem
    const near = Math.max(bandCount(ink, w, x + 0.2 * u, x + 0.45 * u, bottom[0], s.bot), bandCount(ink, w, x - 0.45 * u, x - 0.2 * u, bottom[0], s.bot)); // not below the beam: bar numbers sit there
    const beams = Math.max(far, near);
    const len = beams >= 3 ? 0.5 : beams >= 2 ? 1 : 2;
    return { len: dot ? len * 1.5 : len, beamed: true };
  }
  // To the right of a lone stem: a dot is a small blob, a flag a tall curl at the bottom.
  const runs = [], spans = [];
  let start = -1;
  for (let y = s.top - 2; y <= s.bot + 4; y++) {
    let any = false;
    for (let xx = xa; xx <= xb && !any; xx++) any = ink[y * w + xx] === 1;
    if (any && start < 0) start = y;
    if (!any && start >= 0) { runs.push(y - start); spans.push([start, y - 1]); start = -1; }
  }
  if (start >= 0) { runs.push(s.bot + 5 - start); spans.push([start, s.bot + 4]); }
  const flagRun = runs.length && runs[runs.length - 1] >= 9 ? runs[runs.length - 1] : 0;
  let dot = runs.some((r, i) => r <= 8 && r >= 3 && (i < runs.length - 1 || !flagRun));
  if (flagRun && !dot) { // a flag pushes the dot out past its curl
    let run = 0;
    for (let y = s.top - 2; y <= s.bot + 1 && !dot; y++) {
      let any = false;
      for (let xx = Math.round(x + 1.0 * u); xx <= Math.round(x + 1.6 * u) && !any; xx++) any = ink[y * w + xx] === 1;
      if (any) run++;
      else { dot = run >= 3 && run <= 8; run = 0; }
    }
  }
  // a half note's stem is drawn about half as tall as a quarter's (1 staff space against 2)
  const half = !flagRun && s.bot - s.top + 1 < 1.4 * u;
  // an eighth's flag is one curl, a sixteenth's two: count the strokes a column just right of the stem crosses
  let strokes = 0;
  if (flagRun) {
    const [y0, y1] = spans[spans.length - 1];
    for (let xx = Math.round(x + 0.25 * u); xx <= Math.round(x + 0.45 * u); xx++) {
      let n = 0, gap = 2;
      for (let y = y0; y <= y1; y++) {
        if (ink[y * w + xx]) { if (gap >= 2) n++; gap = 0; } else gap++;
      }
      strokes = Math.max(strokes, n);
    }
  }
  const base = flagRun ? (strokes >= 2 ? 1 : 2) : half ? 8 : 4;
  return { len: dot ? base * 1.5 : base, beamed: false };
}

// A multi-bar rest is a thick horizontal bar across the middle of the staff, between two lines.
function thickRest(ink, w, st, xa, xb) {
  const mid = (st.ys[0] + st.ys[st.ys.length - 1]) / 2;
  const half = st.ys.length % 2 ? 0.5 * st.u : 0; // odd line count: the middle is a line, so look just off it
  const runAt = (y) => {
    y = Math.round(y);
    let run = 0, best = 0, end = 0;
    for (let x = Math.round(xa) + 3; x < xb - 3; x++) { run = ink[y * w + x] ? run + 1 : 0; if (run > best) { best = run; end = x + 1; } }
    return [best, end];
  };
  const need = Math.min(3 * st.u, 0.4 * (xb - xa));
  const runs = [-0.15, 0, 0.15].map((k) => runAt(mid + half + k * st.u));
  if (!runs.every((r) => r[0] >= need)) return null;
  return { x0: runs[1][1] - runs[1][0], x1: runs[1][1] }; // where the thick bar is
}

/* ---------- strips -> bars ---------- */

export function readStrip(ink, light, w, h, st) {
  const bl = barLines(light, w, st);
  if (bl.length < 2) return null;
  const comps = components(ink, w, st, bl);
  const notes = readNotes(ink, w, st, bl, comps);
  const rests = readRests(components(ink, w, st, bl, true), st);
  const stems = stemsBelow(ink, w, h, st);
  const bars = [];
  let last = null; // the last column read so far, for a held note at the start of a bar
  for (let i = 0; i + 1 < bl.length; i++) {
    const inBar = notes.filter((n) => n.cx > bl[i] && n.cx < bl[i + 1]);
    const cols = [];
    for (const n of inBar) {
      const c = cols.find((k) => Math.abs(k.cx - n.cx) < 0.5 * st.u);
      if (c) c.notes.push(n); else cols.push({ cx: n.cx, notes: [n] });
    }
    cols.sort((a, b) => a.cx - b.cx);
    for (const c of cols) {
      const s = stems.reduce((best, q) => (!best || Math.abs(q.x - c.cx) < Math.abs(best.x - c.cx) ? q : best), null);
      const r = s && Math.abs(s.x - c.cx) < 0.6 * st.u ? stemLength(ink, w, s, st.u) : { len: 4, beamed: false };
      c.len = r.len; c.beamed = r.beamed;
    }
    // A stem with no number over it is the previous note held on (its tie arc ends there). Stems start just
    // under the staff; anything starting lower (a bar number) isn't one.
    const lastLine = st.ys[st.ys.length - 1];
    for (const s of stems) {
      if (s.x < bl[i] + 0.5 * st.u || s.x > bl[i + 1] - 0.5 * st.u || s.top > lastLine + 1.2 * st.u || cols.some((c) => Math.abs(c.cx - s.x) < 1.0 * st.u)) continue; // a flag curl sits within 1u of its stem
      const r = stemLength(ink, w, s, st.u);
      const prev = [...cols].reverse().find((c) => c.cx < s.x) || (cols.some((c) => c.cx < s.x) ? null : last);
      cols.push({ cx: s.x, len: r.len, beamed: r.beamed, notes: prev ? prev.notes.map((n) => ({ ...n, tied: true })) : [] });
      cols.sort((a, b) => a.cx - b.cx);
    }
    if (cols.length) last = cols[cols.length - 1];
    const bar = { x0: bl[i], x1: bl[i + 1], cols };
    const thick = !cols.length && thickRest(ink, w, st, bl[i], bl[i + 1]);
    if (thick) { // the number sits centred over the thick bar
      const c = (thick.x0 + thick.x1) / 2;
      bar.rest = readRestCount(ink, w, st, c - 2.2 * st.u, c + 2.2 * st.u) || 1;
    } else if (cols.length) { // rests between the notes keep them in time (a bar of only rests stays empty)
      const inside = rests.filter((r) => r.cx > bl[i] && r.cx < bl[i + 1] && !cols.some((c) => Math.abs(c.cx - r.cx) < 0.6 * st.u));
      if (inside.length) { cols.push(...inside.map((r) => ({ ...r }))); cols.sort((a, b) => a.cx - b.cx); }
    }
    bars.push(bar);
  }
  // The text above the staff: a section name starts a new section, a tempo mark changes the tempo.
  const dbg = [];
  const hd = readHeading(ink, w, st, { debug: dbg });
  // Each mark belongs to the bar it stands above (a section can start mid-line).
  // A name is drawn centred on the bar line it starts at, so the nearest bar start wins.
  const barAt = (x, x1 = x) => {
    const mid = (x + x1) / 2;
    let k = 0;
    bars.forEach((b, i) => { if (b.x0 <= mid) k = i; });
    bars.forEach((b, i) => { if (Math.abs(b.x0 - mid) < Math.abs(bars[k].x0 - mid) && Math.abs(b.x0 - mid) <= (x1 - x) / 2 + 0.5 * st.u) k = i; });
    return bars[k];
  };
  for (const sec of hd.sections) Object.assign(barAt(sec.x, sec.x1), { heading: true, name: sec.name, numbered: sec.numbered });
  for (const t of hd.tempos) barAt(t.x).tempo = t.v;
  return { bars, dbg, strings: st.ys.length };
}

/* ---------- tuning ---------- */

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Standard tunings, lowest string first (MIDI).
const STANDARD = { 4: [28, 33, 38, 43], 5: [23, 28, 33, 38, 43], 6: [40, 45, 50, 55, 59, 64], 7: [35, 40, 45, 50, 55, 59, 64] };

/** "Tuning: E♭ A♭ D♭ G♭ B♭ E♭" (lowest string first) -> MIDI pitches, each in the octave nearest the standard one. */
export function parseTuning(text) {
  const m = String(text || '').match(/Tuning:\s*((?:[A-G]\s?[#b♭♯]?\s*){4,7})/);
  if (!m) return null;
  const names = m[1].match(/[A-G]\s?[#b♭♯]?/g).map((s) => s.replace(/\s/g, ''));
  const std = STANDARD[names.length];
  if (!std || names.every((n) => n === names[0])) return null; // "C C C C C C" is what drum parts say
  return names.map((n, i) => {
    const pc = (PC[n[0]] + (/[#♯]/.test(n) ? 1 : /[b♭]/.test(n) ? -1 : 0) + 12) % 12;
    let d = (((pc - std[i]) % 12) + 12) % 12;
    if (d > 6) d -= 12;
    return std[i] + d;
  });
}

// alphaTex lists the strings top line (highest) first.
function tuningTex(strips) {
  const n = strips.find((s) => s.strings)?.strings || 6;
  const given = strips.find((s) => s.tuning)?.tuning;
  const midi = given && given.length === n ? given : STANDARD[n] || STANDARD[6];
  return [...midi].reverse().map((m) => SHARPS[m % 12] + (Math.floor(m / 12) - 1)).join(' ');
}

/* ---------- alphaTex ---------- */

const UNITS = [[12, 2, true], [8, 2, false], [6, 4, true], [4, 4, false], [3, 8, true], [2, 8, false], [1.5, 16, true], [1, 16, false], [0.5, 32, false]];
const dur = (len) => {
  const u = UNITS.find(([n]) => n === len);
  return u ? `${u[1]}${u[2] ? '{d}' : ''}` : null;
};

// Splits a length (sixteenths) into note values.
function pieces(len) {
  const out = [];
  for (let left = Math.round(len * 2) / 2; left > 0;) { // to the nearest thirty-second
    const p = UNITS.find(([n]) => n <= left && n <= 16) || UNITS[UNITS.length - 1];
    out.push(p[0]);
    left -= p[0];
  }
  return out;
}

const snap = (len) => {
  const allowed = [1, 2, 3, 4, 6, 8, 12, 16];
  return allowed.reduce((b, a) => (Math.abs(a - len) < Math.abs(b - len) ? a : b), 4);
};

const restTex = (len) => pieces(len).map((p) => `r.${dur(p)}`).join(' ');
const fretOf = (n) => (n.tie ? '-' : n.t === 'X' ? 'x' : n.t);
// a drum hit is named by its kit piece (see drumHead), a tab note by fret and string
const noteTex = (n) => (n.drum ? n.drum : `${fretOf(n)}.${n.s + 1}`);
const beatTex = (notes, len) => {
  if (!notes.length) return restTex(len);
  const d = dur(len);
  const one = notes.map(noteTex);
  return notes.length === 1 ? `${one[0]}.${d}` : `(${one.join(' ')}).${d}`;
};
// A length with no single note value (e.g. 10 sixteenths) is written as tied notes.
const tiedTex = (notes, len) => {
  if (!notes.length) return restTex(len);
  const [first, ...rest] = pieces(len);
  const n = notes.map(noteTex);
  const head = n.length === 1 ? `${n[0]}.${dur(first)}` : `(${n.join(' ')}).${dur(first)}`;
  if (notes[0].drum) return `${head} ${restTex(len - first)}`; // a drum isn't held: the rest of its time is quiet
  const tail = rest.map((p) => (n.length === 1 ? `-.${notes[0].s + 1}.${dur(p)}` : `(${notes.map((x) => `-.${x.s + 1}`).join(' ')}).${dur(p)}`));
  return [head, ...tail].join(' ');
};

// The lyrics ride on a track of their own (rests carrying the syllables), so the tablature stays clean.
// A syllable's time in the bar comes from where it sits between the notes above it.
function lyricBar(b, T) {
  if (!b.lyr.length) return restTex(T);
  const anchors = [[b.x0, 0], ...b.cols.map((c, k) => [c.cx, b.times[k]]), [b.x1, T]];
  const timeAt = (x) => {
    for (let i = 1; i < anchors.length; i++) {
      const [xa, ta] = anchors[i - 1], [xb, tb] = anchors[i];
      if (x <= xb) return xb > xa ? ta + ((Math.max(x, xa) - xa) / (xb - xa)) * (tb - ta) : tb;
    }
    return T;
  };
  const sy = b.lyr.slice(0, T);
  const q = sy.map((l) => Math.round(timeAt(l.x)));
  q.forEach((v, i) => { q[i] = Math.max(v, i ? q[i - 1] + 1 : 0); });
  for (let i = q.length - 1; i >= 0; i--) q[i] = Math.min(q[i], T - (q.length - i));
  const beats = [];
  if (q[0] > 0) beats.push(restTex(q[0]));
  sy.forEach((l, i) => {
    const gap = (i + 1 < q.length ? q[i + 1] : T) - q[i];
    const len = Math.min(gap, 4); // a long gap stays quiet, so a new line can start after it
    const [first, ...rest] = pieces(len);
    const d = dur(first);
    const word = JSON.stringify(l.text);
    beats.push((d.endsWith('}') ? `r.${d.slice(0, -1)} lyrics ${word}}` : `r.${d} {lyrics ${word}}`) + (rest.length ? ' ' + restTex(len - first) : ''));
    if (gap > len) beats.push(restTex(gap - len));
  });
  return beats.join(' ');
}

// A drum or percussion part's track: General MIDI drums, with its kit pieces named for the notes.
const DRUM_NOTES = { kick: 36, lowfloortom: 41, floortom: 43, lowtom: 45, snare: 38, midtom: 47, hightom: 48, pedalhat: 44, sidestick: 37, ride: 51, ridebell: 53, hihat: 42, openhat: 46, crash: 49, crash2: 57, shaker: 82, tambourine: 54 };
const isDrums = (strips) => strips.some((s) => s.drums);
const drumHead = (strips) => {
  const used = new Set(strips.flatMap((s) => s.bars.flatMap((b) => b.cols.flatMap((c) => c.notes.map((n) => n.drum)))).filter(Boolean));
  return ['\\staff {score}', '\\instrument percussion', ...[...used].map((d) => `\\articulation ${d} ${DRUM_NOTES[d]}`), '\\clef neutral'].join('\n');
};

/**
 * @param strips parsed strips in reading order ({ bars, heading })
 * @returns {{ tex: string, bars: number, exact: number } | null}
 */
// Other instruments (extra: [{ name, strips, program }]) become tracks of their own, lined up bar for bar
// with the first one (cut or padded with rests when a part has a different number of bars).
export function ugToAlphaTex(strips, { title = '', artist = '', tempo = 100, name = '', program = 27, extra = [] } = {}) {
  // each lyric syllable belongs to the bar it starts in
  // a multi-bar rest ("16" over a thick bar) stands for that many empty bars, so every part keeps the same bar count
  const barsOf = (list) => list.flatMap((s) => s.bars.flatMap((b) => {
    const one = { ...b, lyr: (s.lyr || []).filter((l) => l.x >= b.x0 - 4 && l.x < b.x1 - 4) };
    return b.rest > 1 ? [one, ...Array.from({ length: b.rest - 1 }, () => ({ x0: b.x0, x1: b.x1, cols: [], lyr: [] }))] : [one];
  }));
  const bars = barsOf(strips);
  const sums = bars.filter((b) => b.cols.length >= 3).map((b) => b.cols.reduce((a, c) => a + c.len, 0));
  const count = {};
  sums.forEach((s) => { count[s] = (count[s] || 0) + 1; });
  const top = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const T = Math.round(Number(top[0]));
  const grouped3 = bars.some((b) => b.cols.filter((c) => c.beamed).length === 6) && T === 12;
  const num = T % 4 === 0 && !grouped3 ? T / 4 : T / 2;
  const den = T % 4 === 0 && !grouped3 ? 4 : 8;
  let exact = 0, sectionNo = 0;
  const seen = {};
  const sectionName = (b) => {
    if (!b.name) return `Part ${++sectionNo}`;
    seen[b.name] = (seen[b.name] || 0) + 1;
    return b.numbered ? `${b.name} ${seen[b.name]}` : b.name;
  };
  const firstTempo = bars.find((b) => b.tempo)?.tempo;
  let lastTempo = firstTempo || tempo;
  const render = (barList, first) => {
  let prevStrings = new Set();
  return barList.map((b, i) => {
    let lens = b.cols.map((c) => c.len);
    const sum = lens.reduce((a, c) => a + c, 0);
    if (Math.round(sum) === T && first) exact++;
    else if (b.cols.length > 1) {
      // the rhythm row didn't add up: spread the bar by how far apart the notes sit
      const ends = [...b.cols.map((c) => c.cx), b.x1];
      const span = ends[ends.length - 1] - ends[0];
      lens = b.cols.map((_, k) => snap(((ends[k + 1] - ends[k]) / span) * T));
    }
    lens = lens.map((l) => (dur(l) ? l : snap(l)));
    let total = lens.reduce((a, c) => a + c, 0);
    while (total > T) { // shorten the longest note until the bar fits
      const k = lens.indexOf(Math.max(...lens));
      const shorter = snap(lens[k] - (total - T));
      if (shorter >= lens[k]) break; // every note is already as short as it goes
      lens[k] = shorter;
      total = lens.reduce((a, c) => a + c, 0);
    }
    if (total > T) { // more notes than the bar has room for (a misread line): the extra ones are dropped
      while (total > T) total -= lens.pop();
      b.cols = b.cols.slice(0, lens.length);
    }
    // when the row says less than a full bar, the last note rings on to the end of the bar
    if (b.cols.length && total < T) { lens[lens.length - 1] += T - total; total = T; }
    for (const c of b.cols) {
      for (const n of c.notes) n.tie = n.tied && prevStrings.has(n.s); // only a note on a string that was just played can be a tie
      prevStrings = new Set(c.notes.map((n) => n.s));
    }
    if (!b.cols.length) prevStrings = new Set();
    let at = 0;
    b.times = b.cols.map((c, k) => { const t = at; at += lens[k]; return t; });
    const beats = b.cols.map((c, k) => (pieces(lens[k]).length === 1 ? beatTex(c.notes, lens[k]) : tiedTex(c.notes, lens[k])));
    if (!b.cols.length) beats.splice(0, beats.length, restTex(T));
    const head = [];
    if (first) {
      if (b.heading || i === 0) head.push(`\\section ${JSON.stringify(sectionName(b))}`);
      if (b.tempo && b.tempo !== lastTempo) { head.push(`\\tempo ${b.tempo}`); lastTempo = b.tempo; }
      if (i === 0) head.push(`\\ts ${num} ${den}`);
    }
    return `${head.join(' ')} ${beats.join(' ')}`.trim();
  });
  };
  const out = render(bars, true);
  const lists = [bars];
  const header = [
    `\\title ${JSON.stringify(title)}`,
    artist ? `\\artist ${JSON.stringify(artist)}` : '',
    `\\tempo ${Math.round(firstTempo || tempo)}`,
    '.',
    `\\track ${JSON.stringify(name || title || 'Guitar')}`,
    ...(isDrums(strips) ? [drumHead(strips)] : ['\\staff {score tabs}', `\\tuning ${tuningTex(strips)}`, `\\instrument ${program}`]),
  ].filter(Boolean).join('\n');
  const others = extra.map((part) => {
    const list = barsOf(part.strips).slice(0, bars.length);
    while (list.length < bars.length) list.push({ x0: 0, x1: 1, cols: [], lyr: [] });
    lists.push(list);
    const head = isDrums(part.strips) ? drumHead(part.strips) : `\\staff {score tabs}\n\\tuning ${tuningTex(part.strips)}\n\\instrument ${part.program ?? 27}`;
    return `\n\\track ${JSON.stringify(part.name)}\n${head}\n${render(list, false).join(' |\n')}`;
  }).join('');
  // the lyrics come from whichever part has them (the vocal part, wherever it sits in the order)
  const sungBars = lists.find((l) => l.some((b) => b.lyr.length));
  const sung = !!sungBars;
  const voice = sung ? `\n\\track "Lyrics"\n\\staff {score}\n\\instrument 54\n${sungBars.map((b) => lyricBar(b, T)).join(' |\n')}` : '';
  return { tex: `${header}\n${out.join(' |\n')}${others}${voice}`, bars: bars.length, exact, lyrics: sung, tracks: 1 + extra.length };
}
