// Reads Ultimate Guitar "Tab Pro" printouts (a graphic TAB staff with a rhythm row) from a rendered page:
// finds each staff, its bars and the bold fret numbers (template matching), then the rhythm row's
// stems, beams, flags and dots, and builds alphaTex. Image sizes are normalised to a staff
// spacing of UG_UNIT pixels by the caller (see pdftab.js).
import { UG_ATLAS, UG_W, UG_H } from './ugatlas.js';
import { readHeading } from './ugtext.js';

export const UG_UNIT = 18;
const TEMPLATES = UG_ATLAS.map(([ch, bits]) => ({ ch, bits: Uint8Array.from(bits, (c) => +c) }));
const MAX_MISS = 40;

/* ---------- staves and bars ---------- */

// Every group of six equally spaced long horizontal lines.
export function findStaves(light, w, h, ink) {
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
  for (let i = 0; i + 5 < ys.length;) {
    const d = [1, 2, 3, 4, 5].map((k) => ys[i + k] - ys[i + k - 1]);
    if (Math.min(...d) > 6 && Math.max(...d) - Math.min(...d) < 3) {
      const rows = ys.slice(i, i + 6);
      const y = Math.round(rows[0]);
      let x0 = 0, x1 = w - 1;
      while (x0 < w && !light[y * w + x0]) x0++;
      while (x1 > 0 && !light[y * w + x1]) x1--;
      out.push({ ys: rows, x0, x1, u: (rows[5] - rows[0]) / 5 });
      i += 6;
    } else i++;
  }
  return out;
}

function barLines(light, w, st) {
  const t = Math.round(st.ys[0]), b = Math.round(st.ys[5]);
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
  return groups.map((g) => g.reduce((a, c) => a + c, 0) / g.length);
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

export function components(ink, w, st, bars) {
  const u = st.u;
  const t = Math.max(0, Math.round(st.ys[0] - 0.8 * u)), b = Math.round(st.ys[5] + 0.8 * u);
  const seen = new Uint8Array(w * (b + 1));
  const isBar = (x) => bars.some((bx) => Math.abs(x - bx) <= 2);
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

function readNotes(ink, w, st, bars) {
  const u = st.u;
  const glyphs = [];
  const parens = [];
  for (const c of components(ink, w, st, bars)) {
    const cy = (c.y0 + c.y1) / 2;
    // "(8)": a note held over from before is written in brackets, which stand taller than the numbers
    if (c.h > 0.6 * u && c.h < 1.6 * u && c.w <= 4 && c.area >= 10 && cy > st.ys[0] - 0.6 * u && cy < st.ys[5] + 0.6 * u) { parens.push({ x0: c.x0, x1: c.x1, cy }); continue; }
    if (c.h < 0.45 * u || c.area < 18 || c.h > 1.3 * u || c.w > 1.3 * u) continue;
    if (cy < st.ys[0] - 0.45 * u || cy > st.ys[5] + 0.45 * u) continue;
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
  notes.forEach((n) => {
    n.cx = (n.x0 + n.x1) / 2;
    n.tied = parens.some((q) => Math.abs(q.cy - st.ys[n.s]) < 0.8 * u && (Math.abs(q.x1 - n.x0) < 0.5 * u || Math.abs(q.x0 - n.x1) < 0.5 * u));
  });
  return notes.sort((a, b) => a.cx - b.cx);
}

/* ---------- rhythm row ---------- */

function stemsBelow(ink, w, h, st) {
  const u = st.u;
  const y0 = Math.round(st.ys[5] + 0.5 * u), y1 = Math.min(h - 1, Math.round(st.ys[5] + 3.2 * u));
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
function stemLength(ink, w, s, u) {
  const x = s.x;
  const bottom = [s.bot - Math.round(0.6 * u), s.bot + 2];
  const far = Math.max(bandCount(ink, w, x + 1.0 * u, x + 1.2 * u, bottom[0], bottom[1]), bandCount(ink, w, x - 1.2 * u, x - 1.0 * u, bottom[0], bottom[1]));
  if (far) return { len: far >= 2 ? 1 : 2, beamed: true }; // beamed eighths / sixteenths
  // To the right of a lone stem: a dot is a small blob, a flag a tall curl at the bottom.
  const xa = Math.round(x + 0.3 * u), xb = Math.round(x + 1.0 * u);
  const runs = [];
  let start = -1;
  for (let y = s.top - 2; y <= s.bot + 4; y++) {
    let any = false;
    for (let xx = xa; xx <= xb && !any; xx++) any = ink[y * w + xx] === 1;
    if (any && start < 0) start = y;
    if (!any && start >= 0) { runs.push(y - start); start = -1; }
  }
  if (start >= 0) runs.push(s.bot + 5 - start);
  const flagRun = runs.length && runs[runs.length - 1] >= 9 ? runs[runs.length - 1] : 0;
  const dot = runs.some((r, i) => r <= 8 && r >= 3 && (i < runs.length - 1 || !flagRun));
  const base = flagRun ? (flagRun >= 18 ? 1 : 2) : 4;
  return { len: dot ? base * 1.5 : base, beamed: false };
}

/* ---------- strips -> bars ---------- */

export function readStrip(ink, light, w, h, st) {
  const bl = barLines(light, w, st);
  if (bl.length < 2) return null;
  const notes = readNotes(ink, w, st, bl);
  const stems = stemsBelow(ink, w, h, st);
  const bars = [];
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
    bars.push({ x0: bl[i], x1: bl[i + 1], cols });
  }
  // The text above the staff: a section name starts a new section, a tempo mark changes the tempo.
  const dbg = [];
  const hd = readHeading(ink, w, st, { debug: dbg });
  // Each mark belongs to the bar it stands above (a section can start mid-line).
  const barAt = (x) => {
    let k = 0;
    bars.forEach((b, i) => { if (b.x0 <= x + 0.6 * st.u) k = i; });
    return bars[k];
  };
  for (const sec of hd.sections) Object.assign(barAt(sec.x), { heading: true, name: sec.name, numbered: sec.numbered });
  for (const t of hd.tempos) barAt(t.x).tempo = t.v;
  return { bars, dbg };
}

/* ---------- alphaTex ---------- */

const UNITS = [[12, 2, true], [8, 2, false], [6, 4, true], [4, 4, false], [3, 8, true], [2, 8, false], [1, 16, false]];
const dur = (len) => {
  const u = UNITS.find(([n]) => n === len);
  return u ? `${u[1]}${u[2] ? '{d}' : ''}` : null;
};

// Splits a length (sixteenths) into note values.
function pieces(len) {
  const out = [];
  for (let left = Math.round(len); left > 0;) {
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

const fretOf = (n) => (n.tie ? '-' : n.t === 'X' ? 'x' : n.t);
const beatTex = (notes, len) => {
  const d = dur(len);
  const one = notes.map((n) => `${fretOf(n)}.${n.s + 1}`);
  return notes.length === 1 ? `${one[0]}.${d}` : `(${one.join(' ')}).${d}`;
};
// A length with no single note value (e.g. 10 sixteenths) is written as tied notes.
const tiedTex = (notes, len) => {
  const [first, ...rest] = pieces(len);
  const n = notes.map((x) => `${fretOf(x)}.${x.s + 1}`);
  const head = n.length === 1 ? `${n[0]}.${dur(first)}` : `(${n.join(' ')}).${dur(first)}`;
  const tail = rest.map((p) => (n.length === 1 ? `-.${notes[0].s + 1}.${dur(p)}` : `(${notes.map((x) => `-.${x.s + 1}`).join(' ')}).${dur(p)}`));
  return [head, ...tail].join(' ');
};
const restTex = (len) => pieces(len).map((p) => `r.${dur(p)}`).join(' ');

/**
 * @param strips parsed strips in reading order ({ bars, heading })
 * @returns {{ tex: string, bars: number, exact: number } | null}
 */
export function ugToAlphaTex(strips, { title = '', artist = '', tempo = 100 } = {}) {
  const bars = strips.flatMap((s) => s.bars);
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
  let prevStrings = new Set();
  const seen = {};
  const sectionName = (b) => {
    if (!b.name) return `Part ${++sectionNo}`;
    seen[b.name] = (seen[b.name] || 0) + 1;
    return b.numbered ? `${b.name} ${seen[b.name]}` : b.name;
  };
  const firstTempo = bars.find((b) => b.tempo)?.tempo;
  let lastTempo = firstTempo || tempo;
  const out = bars.map((b, i) => {
    let lens = b.cols.map((c) => c.len);
    const sum = lens.reduce((a, c) => a + c, 0);
    if (Math.round(sum) === T) exact++;
    else if (b.cols.length > 1) {
      // the rhythm row didn't add up: spread the bar by how far apart the notes sit
      const ends = [...b.cols.map((c) => c.cx), b.x1];
      const span = ends[ends.length - 1] - ends[0];
      lens = b.cols.map((_, k) => snap(((ends[k + 1] - ends[k]) / span) * T));
    }
    lens = lens.map((l) => (dur(l) ? l : snap(l)));
    let total = lens.reduce((a, c) => a + c, 0);
    while (total > T) { const k = lens.indexOf(Math.max(...lens)); lens[k] = snap(lens[k] - (total - T)); total = lens.reduce((a, c) => a + c, 0); }
    // when the row says less than a full bar, the last note rings on to the end of the bar
    if (b.cols.length && total < T) { lens[lens.length - 1] += T - total; total = T; }
    for (const c of b.cols) {
      for (const n of c.notes) n.tie = n.tied && prevStrings.has(n.s); // only a note on a string that was just played can be a tie
      prevStrings = new Set(c.notes.map((n) => n.s));
    }
    if (!b.cols.length) prevStrings = new Set();
    const beats = b.cols.map((c, k) => (pieces(lens[k]).length === 1 ? beatTex(c.notes, lens[k]) : tiedTex(c.notes, lens[k])));
    if (!b.cols.length) beats.splice(0, beats.length, restTex(T));
    const head = [];
    if (b.heading || i === 0) head.push(`\\section ${JSON.stringify(sectionName(b))}`);
    if (b.tempo && b.tempo !== lastTempo) { head.push(`\\tempo ${b.tempo}`); lastTempo = b.tempo; }
    if (i === 0) head.push(`\\ts ${num} ${den}`);
    return `${head.join(' ')} ${beats.join(' ')}`.trim();
  });
  const header = [
    `\\title ${JSON.stringify(title)}`,
    artist ? `\\artist ${JSON.stringify(artist)}` : '',
    `\\tempo ${Math.round(firstTempo || tempo)}`,
    '.',
    `\\track ${JSON.stringify(title || 'Guitar')}`,
    '\\staff {tabs}',
    '\\tuning E4 B3 G3 D3 A2 E2',
    '\\instrument 27',
  ].filter(Boolean).join('\n');
  return { tex: `${header}\n${out.join(' |\n')}`, bars: bars.length, exact };
}
