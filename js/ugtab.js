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
  // ink running up and down from (x0, y), a pixel or two either side: a staff's opening bar line
  const barAt = (x0, y) => {
    for (let x = Math.max(0, x0 - 2); x <= Math.min(w - 1, x0 + 2); x++) {
      let up = 0, down = 0;
      while (y - up - 1 >= 0 && light[(y - up - 1) * w + x]) up++;
      while (y + down + 1 < h && light[(y + down + 1) * w + x]) down++;
      if (up + down > 0.025 * w) return true;
    }
    return false;
  };
  for (let y = 0; y < h; y++) {
    let n = 0, run = 0, longest = 0, longX = 0;
    let span = 0, fill = 0, hole = 0, bridged = 0, spanX = 0, bridgedX = 0; // a run across small holes, and the ink in it
    for (let x = 0; x < w; x++) {
      const v = light[y * w + x];
      n += v;
      run = v ? run + 1 : 0;
      if (run > longest) { longest = run; longX = x - run + 1; }
      if (!v) { hole++; continue; }
      if (span && hole <= 0.025 * w) { span += hole + 1; fill++; } else { span = 1; fill = 1; spanX = x; }
      hole = 0;
      if (fill >= 0.8 * span && span > bridged) { bridged = span; bridgedX = spanX; }
    }
    // staff lines span the page and are broken only by fret numbers; a text tab's dashes never join up.
    // A last line holding a bar or two is shorter, but unbroken, or broken only by a fret number or
    // two (mostly ink across the holes; a row of words is mostly gaps). One bar alone can be just 9%
    // of the page: that short, it must start at a bar line (a long flat tie doesn't). Two bars of
    // chords in brackets leave only 7% runs, but 17% of the row inked (How Great Is Our God's last line).
    // A last bar of one chord is shorter still (6%): with a bar line at both ends, and most of the row's
    // ink, it is a staff line (beams between stems along a full line leave more ink in the row).
    if ((n > 0.45 * w && longest > 20) || longest > 0.15 * w || bridged > 0.15 * w
      || (longest > 0.07 * w && barAt(longX, y)) || (bridged > 0.07 * w && barAt(bridgedX, y))
      || (bridged > 0.04 * w && n < 1.5 * bridged && barAt(bridgedX, y) && barAt(bridgedX + bridged - 1, y))
      || (longest > 0.06 * w && n > 0.15 * w)) {
      const wide = n > 0.45 * w; // a row across the page
      if (lines.length && y - lines[lines.length - 1].last <= 1) { const l = lines[lines.length - 1]; l.last = y; l.sum += y; l.n++; l.wide ||= wide; if (wide) { l.wsum += y; l.wn++; } }
      else lines.push({ last: y, sum: y, n: 1, wide, wsum: wide ? y : 0, wn: wide ? 1 : 0 });
    }
  }
  // a band much thicker than the staff lines (a beam, a block of words) is no staff line: taken as
  // one, it would join a staff's run and shift the staff a string down
  const thick = Math.max(lines.map((l) => l.n).sort((a, b) => a - b)[lines.length >> 1] * 2, 3);
  // A staff line with tie arcs lying along it is thick too, but only its own rows cross the page:
  // those are the line (Trust In God's Synth Pad lost a staff a page, and a line read a row high
  // started at the arc and lost its first bar)
  const found = lines.filter((l) => l.n <= thick || (l.wn && l.wn <= thick))
    .map((l) => ({ y: l.wn ? l.wsum / l.wn : l.sum / l.n, wide: l.wide }));
  // a short "line" far closer than a staff space to another (the foot of a multi-bar rest's thick
  // bar, a word) is no staff line: it broke the staff's even spacing and lost the line (How He
  // Loves' 12-bar intro)
  const step = found.slice(1).map((l, i) => l.y - found[i].y).filter((g) => g > 6).sort((a, b) => a - b);
  const sp0 = step[step.length >> 1];
  const ys = found.filter((l, i) => l.wide || !sp0 || !((i > 0 && l.y - found[i - 1].y < 0.4 * sp0) || (i + 1 < found.length && found[i + 1].y - l.y < 0.4 * sp0))).map((l) => l.y);
  const wideAt = new Set(found.filter((l) => l.wide).map((l) => l.y)); // rows across the page
  // A line of only multi-bar rests can be drawn with just its outer two lines (the others are ticks at
  // the bar lines): two lines 3 or 5 spaces apart, joined by bar lines, are a 4- or 6-line staff.
  const gaps = ys.slice(1).map((y, i) => y - ys[i]).filter((g) => g > 6).sort((a, b) => a - b);
  const sp = gaps[gaps.length >> 1];
  for (let i = 0; sp && i + 1 < ys.length; i++) {
    const t = Math.round(ys[i]), b = Math.round(ys[i + 1]), g = b - t;
    const m = [3, 5].find((k) => Math.abs(g - k * sp) <= 0.08 * k * sp && counts.includes(k + 1));
    if (!m) continue;
    let joins = 0;
    for (let x = 0; x < w && joins < 3; x++) {
      let n = 0;
      for (let y = t; y <= b; y++) n += light[y * w + x];
      if (n >= 0.97 * (g + 1)) { joins++; x += 3; }
    }
    if (joins < 3) continue;
    ys.splice(i + 1, 0, ...Array.from({ length: m - 1 }, (_, k) => ys[i] + (k + 1) * g / m));
    i += m - 1;
  }
  const out = [];
  for (let i = 0; i + 1 < ys.length;) {
    const gap = ys[i + 1] - ys[i];
    let j = i + 1; // the run of lines spaced like the first two
    while (j + 1 < ys.length && Math.abs(ys[j + 1] - ys[j] - gap) < 3) j++;
    // seven in a row: a six-line staff and a stray line next to it (words, a beam); the stray one is
    // the end whose gap fits the others least
    if (j - i === 6 && counts.includes(6) && !counts.includes(7)) {
      // (a long flat tie over the staff is no row across the page: Synth Pad, Trust In God)
      const g = (k) => ys[k + 1] - ys[k], mid = [1, 2, 3, 4].map((k) => g(i + k)).sort((a, b) => a - b)[2];
      const topStray = wideAt.has(ys[i]) !== wideAt.has(ys[j]) ? !wideAt.has(ys[i]) : Math.abs(g(i) - mid) > Math.abs(g(j - 1) - mid);
      if (topStray) { i++; continue; }
      j--;
    }
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
        // a staff's lines all start at its left edge; a beam over a music staff starts after the clef
        const starts = rows.map((r) => Math.min(...[-1, 0, 1].map((d) => { const yy = Math.round(r) + d; let x = 0; while (x < w && !light[yy * w + x]) x++; return x; }))).filter((x) => x < w); // a line drawn only as ticks has no start
        if (Math.max(...starts) - Math.min(...starts) > 2 * gap) continue;
        out.push({ ys: rows, x0, x1, u: (rows[size - 1] - rows[0]) / (size - 1) });
      }
      i = j + 1;
    } else if (gap > 6 && n === 5) i = j + 1; // a music staff: none of its lines start a bass's four
    else i++;
  }
  return out;
}

function barLines(light, w, st) {
  const t = Math.round(st.ys[0]), b = Math.round(st.ys[st.ys.length - 1]);
  const xs = [];
  for (let x = st.x0; x <= st.x1; x++) {
    let n = 0, gaps = 0, hole = 0, run = 0;
    for (let y = t; y <= b; y++) {
      n += light[y * w + x];
      if (y > t && light[(y - 1) * w + x] && !light[y * w + x]) gaps++;
      run = light[y * w + x] ? 0 : run + 1;
      hole = Math.max(hole, run);
    }
    // whole, or broken once in the middle (UG breaks the bar lines of a line of multi-bar rests); a chord's
    // stacked numbers leave a gap between every two
    if (n >= 0.97 * (b - t + 1) || (gaps <= 1 && hole <= 0.8 * st.u && n >= 0.7 * (b - t + 1) && light[t * w + x] && light[b * w + x])) xs.push(x);
  }
  const groups = [];
  for (const x of xs) {
    if (groups.length && x - groups[groups.length - 1][groups[groups.length - 1].length - 1] <= 2) groups[groups.length - 1].push(x);
    else groups.push([x]);
  }
  // A bar line is straight. Brackets round a tied chord stacked on every string ("(0)" over "(2)" ...) can
  // join into one column of ink too, but they curve: just beside it, between the staff lines, there's ink
  // on many rows.
  const between = [];
  for (let y = t; y <= b; y++) if (st.ys.every((ly) => Math.abs(y - ly) > 2)) between.push(y);
  const straight = (g) => {
    const l = g[0] - 2, r = g[g.length - 1] + 2;
    let n = 0;
    for (const y of between) if ((l >= 0 && light[y * w + l]) || (r < w && light[y * w + r])) n++;
    return n <= 0.25 * between.length;
  };
  const out = groups.filter(straight).map((g) => g.reduce((a, c) => a + c, 0) / g.length)
    .filter((x, i, a) => i === 0 || x - a[i - 1] > st.u); // the thin and thick lines of a final double bar are one
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
  const dist = TEMPLATES.map((t) => {
    let d = 0;
    for (let i = 0; i < box.length; i++) d += box[i] ^ t.bits[i];
    return { ch: t.ch, d };
  }).sort((a, b) => a.d - b.d);
  if (dist[0].d > MAX_MISS) return null;
  // A close call between digits with a different number of closed loops (a small 6 matched 5 by one
  // pixel: Trust In God, Lead Guitar 3, bar 135) goes to the one whose loops the glyph has.
  // Missing a loop the best match needs counts for more (a heavier 5 matched 6 by seven pixels).
  const found = loops(box), holes = found.length;
  let ch = dist[0].ch;
  if (HOLES[ch] !== undefined && HOLES[ch] !== holes) {
    const room = holes < HOLES[ch] ? 10 : 6;
    const alt = dist.find((t) => t.d <= dist[0].d + room && HOLES[t.ch] === holes);
    if (alt) ch = alt.ch;
  }
  // One loop: where it sits tells 0, 6 and 9 apart in any font (a 0's loop is central, a 6's low down,
  // a 9's high up). Another font's 9 matched 8 and then 0; its 6 matched 0 by a pixel.
  // An 8's lower loop is its bigger one; a 9 whose tail curls shut has a small second loop under its own.
  if (holes === 2 && ch === '8' && found[1].size < 0.8 * found[0].size) ch = '9';
  else if (holes === 1 && '0689'.includes(ch)) {
    const [h] = found, mid = (h.y0 + h.y1) / 2 - oy;
    ch = mid < 0.375 * comp.h ? '9' : mid > 0.55 * comp.h ? '6' : '0'; // (centres: 9 0.27-0.32 of the height, 0 0.43-0.46, 6 0.65)
  }
  return ch;
}

// Closed loops in each digit (4 left out: fonts draw it open or closed).
const HOLES = { 0: 1, 1: 0, 2: 0, 3: 0, 5: 0, 6: 1, 7: 0, 8: 2, 9: 1 };

/** Background areas of a glyph box that don't reach its edge (top to bottom: the rows each covers, its size). */
function loops(box) {
  const seen = new Uint8Array(box.length);
  const out = [];
  for (let s = 0; s < box.length; s++) {
    if (box[s] || seen[s]) continue;
    let edge = false, size = 0, y0 = UG_H, y1 = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % UG_W, y = (i / UG_W) | 0;
      size++; y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      if (x === 0 || y === 0 || x === UG_W - 1 || y === UG_H - 1) edge = true;
      for (const j of [x > 0 && i - 1, x < UG_W - 1 && i + 1, y > 0 && i - UG_W, y < UG_H - 1 && i + UG_W]) {
        if (j !== false && !box[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (!edge && size >= 2) out.push({ y0, y1, size });
  }
  return out;
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
    if (ch === null || (ch === '1' && c.h > 0.9 * u)) continue; // (a bracket can match a 1, but it's taller: UG's 1 is 0.75 spaces)
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
// (two flags), an eighth about half as tall; a half rest is a flat block sitting on a line, a whole
// rest the same block hanging from one. A dot just after one makes it half as long again.
// Lengths in sixteenths.
export function readRests(comps, st) { // exported for tests
  const u = st.u, top = st.ys[0], bot = st.ys[st.ys.length - 1];
  const rests = [];
  for (const c of comps) {
    const cy = (c.y0 + c.y1) / 2;
    if (cy < top || cy > bot || c.w < 0.4 * u || c.w > 0.95 * u || c.area < 0.15 * c.w * c.h) continue;
    let len = 0;
    if (c.h >= 1.7 * u && c.h <= 2.2 * u) len = c.w <= 0.385 * c.h ? 4 : 1; // (by its shape: fonts draw a quarter rest 0.55 to 0.73 spaces wide)
    else if (c.h >= 1.0 * u && c.h <= 1.4 * u && c.w >= 0.55 * u) len = 2;
    else if (c.h >= 0.25 * u && c.h <= 0.45 * u && c.w >= 0.6 * u && c.area >= 0.8 * c.w * c.h) {
      const line = (y) => st.ys.some((ly) => Math.abs(ly - y) <= 2);
      len = line(c.y1) ? 8 : line(c.y0) ? 16 : 0;
    }
    if (!len) continue;
    const isDot = (d) => d.w <= 0.4 * u && d.h <= 0.4 * u && d.area >= 6;
    const dot = comps.find((d) => isDot(d) && d.x0 >= c.x1 && d.x0 - c.x1 <= 0.8 * u
      && ((d.y0 >= c.y0 && d.y1 <= c.y1) || Math.abs((d.y0 + d.y1) / 2 - cy) < 0.5 * u));
    // a second dot just after the first: double dotted (one and three quarters)
    const two = dot && comps.some((d) => d !== dot && isDot(d) && d.x0 >= dot.x1 && d.x0 - dot.x1 <= 0.6 * u && Math.abs(d.y0 + d.y1 - dot.y0 - dot.y1) <= 0.5 * u);
    rests.push({ cx: (c.x0 + c.x1) / 2, len: two ? len * 1.75 : dot ? len * 1.5 : len, rest: true, notes: [] });
  }
  return rests;
}

/* ---------- rhythm row ---------- */

export function stemsBelow(ink, w, h, st) { // exported for tests
  const u = st.u;
  const y0 = Math.round(st.ys[st.ys.length - 1] + 0.5 * u), y1 = Math.min(h - 1, Math.round(st.ys[st.ys.length - 1] + 3.2 * u));
  const cols = [];
  for (let x = st.x0; x <= st.x1; x++) {
    let best = 0, cur = 0, end = 0;
    for (let y = y0; y <= y1; y++) {
      cur = ink[y * w + x] ? cur + 1 : 0;
      if (cur > best) { best = cur; end = y; }
    }
    // a half note's stem is about a space tall; the sung words' tall letters (b, d, H), which can sit
    // just under the staff, are shorter
    if (best >= 0.85 * u) cols.push({ x, top: end - best + 1, bot: end });
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

function bandCount(ink, w, xa, xb, ya, yb, lines = []) {
  xa = Math.round(xa); xb = Math.round(xb);
  let bands = 0, inBand = false;
  for (let y = ya; y <= yb; y++) {
    let n = 0;
    for (let x = xa; x <= xb; x++) n += ink[y * w + x];
    const on = lines.some((l) => Math.abs(y - l) <= 1.5) ? inBand : n > 0.6 * (xb - xa + 1); // (a staff line running through is no beam)
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
      const on = (s.lines || []).some((l) => Math.abs(y - l) <= 1.5) ? inBand : n >= need; // (a staff line running through is no beam)
      if (on && !inBand) bands++;
      inBand = on;
    }
    return bands;
  };
  const far = Math.max(joined(1), joined(-1));
  const xa = Math.round(x + 0.3 * u), xb = Math.round(x + 1.0 * u);
  if (far) { // beamed eighths / sixteenths; a dot sits beside the stem, above the beams (UG's near the top, others' just over the beams)
    let dot = false, run = 0, wide = false;
    for (let y = s.top - 2; y <= s.bot && !dot; y++) {
      let n = 0;
      for (let xx = xa; xx <= xb; xx++) n += ink[y * w + xx];
      // a beam stub runs wider than a dot; down by the beams, a dot also stands clear of its stem (a sixteenth's
      // own short stub grows out of it) and of the next one (the next note's stub reaches it)
      let near = false;
      if (y > s.bot - Math.round(0.9 * u)) for (let xx = Math.round(x + 0.15 * u); xx < xa && !near; xx++) near = ink[y * w + xx] === 1;
      if (n) { run++; wide ||= n > 0.45 * u || near || ink[y * w + xb] === 1; }
      else { dot = run >= 3 && run <= 8 && !wide; run = 0; wide = false; }
    }
    // a sixteenth beside eighths has only a short second beam (a stub about half a space long) at its stem
    const near = Math.max(bandCount(ink, w, x + 0.2 * u, x + 0.45 * u, bottom[0], s.bot, s.lines), bandCount(ink, w, x - 0.45 * u, x - 0.2 * u, bottom[0], s.bot, s.lines)); // not below the beam: bar numbers sit there
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
export function thickRest(ink, w, st, xa, xb) {
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

// Marks drawn just above a tab staff: a swell "<" (the note fades in, as with a sustainer or volume
// knob) and a wavy line (vibrato over the notes under it).
export function readMarks(ink, w, st) {
  const u = st.u, top = st.ys[0];
  const y0 = Math.max(0, Math.round(top - 2.8 * u)), y1 = Math.round(top - 0.3 * u);
  const x0 = Math.round(st.x0), x1 = Math.round(st.x1);
  const seen = new Uint8Array((x1 - x0 + 1) * (y1 - y0 + 1));
  const W = x1 - x0 + 1;
  const swells = [], waves = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!ink[y * w + x] || seen[(y - y0) * W + x - x0]) continue;
    const px = [], stack = [[x, y]];
    seen[(y - y0) * W + x - x0] = 1;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      px.push(cx, cy);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1 || !ink[ny * w + nx] || seen[(ny - y0) * W + nx - x0]) continue;
        seen[(ny - y0) * W + nx - x0] = 1; stack.push([nx, ny]);
      }
    }
    let a = Infinity, b = -1, c = Infinity, d = -1;
    for (let i = 0; i < px.length; i += 2) { a = Math.min(a, px[i]); b = Math.max(b, px[i]); c = Math.min(c, px[i + 1]); d = Math.max(d, px[i + 1]); }
    const cw = b - a + 1, ch = d - c + 1;
    if (c <= y0 || d >= y1) continue; // cut off by the band: something bigger (a word, an arc into the staff)
    // the wavy line: long and flat, its top edge going up and down again and again
    if (cw >= 1.5 * u && ch <= 0.5 * u) {
      const tops = new Array(cw).fill(Infinity);
      for (let i = 0; i < px.length; i += 2) tops[px[i] - a] = Math.min(tops[px[i] - a], px[i + 1]);
      let turns = 0, dir = 0;
      for (let k = 1; k < cw; k++) {
        const s = Math.sign(tops[k] - tops[k - 1]);
        if (s && s !== dir) { if (dir) turns++; dir = s; }
      }
      if (turns >= 6) waves.push({ x0: a, x1: b + 1 });
      continue;
    }
    // the swell: two thin strokes meeting at a point on the left
    if (cw >= 0.5 * u && cw <= 1.6 * u && ch >= 0.4 * u && ch <= 1.1 * u && px.length / 2 < 0.45 * cw * ch) {
      const leftAt = (yy) => { let m = Infinity; for (let i = 0; i < px.length; i += 2) if (px[i + 1] === yy) m = Math.min(m, px[i]); return m; };
      const mid = leftAt(Math.round((c + d) / 2)), up = leftAt(c), down = leftAt(d);
      let rightMid = false;
      for (let i = 0; i < px.length; i += 2) if (px[i] >= b - 1 && Math.abs(px[i + 1] - (c + d) / 2) < 0.15 * ch) rightMid = true;
      if (mid - a <= 0.2 * cw && up - a >= 0.6 * cw && down - a >= 0.6 * cw && !rightMid) swells.push({ x0: a, x1: b + 1 });
    }
  }
  return { swells, waves };
}

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
      let r = s && Math.abs(s.x - c.cx) < 0.6 * st.u ? stemLength(ink, w, s, st.u) : { len: 4, beamed: false, guess: true };
      if (r.guess) { // a stem drawn only a pixel or two above its beam: the beam says the length
        const x = Math.round(c.cx), lastLine = st.ys[st.ys.length - 1];
        let bot = -1;
        for (let y = Math.min(h - 1, Math.round(lastLine + 3.2 * st.u)); y > lastLine + 0.5 * st.u && bot < 0; y--) if (ink[y * w + x]) bot = y;
        const b = bot > 0 && stemLength(ink, w, { x, top: bot - Math.round(st.u), bot }, st.u);
        if (b?.beamed) r = b;
      }
      c.len = r.len; c.beamed = r.beamed;
      if (r.guess) c.guess = true; // no rhythm row (the notes' lengths are in the music staff above)
    }
    // A stem with no number over it is the previous note held on (its tie arc ends there). Stems start just
    // under the staff; anything starting lower (a bar number) isn't one.
    const lastLine = st.ys[st.ys.length - 1];
    for (const s of stems) {
      if (s.x < bl[i] + 0.5 * st.u || s.x > bl[i + 1] - 0.5 * st.u || s.top > lastLine + 1.2 * st.u || cols.some((c) => Math.abs(c.cx - s.x) < 1.0 * st.u)) continue; // a flag curl sits within 1u of its stem
      const r = stemLength(ink, w, s, st.u);
      const prev = [...cols].reverse().find((c) => c.cx < s.x) || (cols.some((c) => c.cx < s.x) ? null : last);
      if (!prev?.notes.length) continue; // no chord yet to repeat or hold: a letter of the words below, not a stem
      cols.push({ cx: s.x, len: r.len, beamed: r.beamed, notes: prev ? prev.notes.map((n) => ({ ...n, tied: true })) : [] });
      cols.sort((a, b) => a.cx - b.cx);
    }
    if (cols.length) last = cols[cols.length - 1];
    const bar = { x0: bl[i], x1: bl[i + 1], cols };
    const thick = !cols.length && thickRest(ink, w, st, bl[i], bl[i + 1]);
    if (thick) { // the number sits centred over the thick bar
      const c = (thick.x0 + thick.x1) / 2;
      bar.rest = readRestCount(ink, w, st, c - 2.2 * st.u, c + 2.2 * st.u) || 1;
    } else if (!cols.length) { // Tablature view draws a multi-bar rest as an empty bar with its number above
      const c = (bl[i] + bl[i + 1]) / 2;
      const n = readRestCount(ink, w, st, c - 2.2 * st.u, c + 2.2 * st.u);
      if (n) bar.rest = n;
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
  // at this size a tempo's digits are only ~14 px tall and often misread: pdftab reads them again, sharper
  const tempoMarks = hd.marks.length;
  // a swell goes on the note it stands over, a wavy line on every note under it
  const marks = readMarks(ink, w, st);
  const played = bars.flatMap((b) => b.cols.filter((c) => c.notes?.length));
  for (const m of marks.swells) {
    const mid = (m.x0 + m.x1) / 2;
    const c = played.reduce((best, q) => (!best || Math.abs(q.cx - mid) < Math.abs(best.cx - mid) ? q : best), null);
    if (c && Math.abs(c.cx - mid) < 1.2 * st.u) (c.fx ||= []).push('f');
  }
  for (const m of marks.waves) {
    for (const c of played) if (c.cx >= m.x0 - 0.6 * st.u && c.cx <= m.x1 + 0.3 * st.u && !c.fx?.includes('v')) (c.fx ||= []).push('v');
  }
  return { bars, dbg, strings: st.ys.length, tempoMarks };
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

// The song's key from every pitched note, weighted by how long it sounds (Krumhansl's key profiles),
// written as the major key with the same signature (a minor key shares its relative major's).
const MAJOR_P = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_P = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const KS_NAMES = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
// How long each pitch class sounds in a part (a tab part as its frets are, without a capo).
function pitchHist(part, list) {
  const h = new Array(12).fill(0);
  const n = part.strips.find((s) => s.strings)?.strings || 6;
  const given = part.strips.find((s) => s.tuning)?.tuning;
  const midi = [...(given && given.length === n ? given : STANDARD[n] || STANDARD[6])].reverse();
  for (const b of list) b.cols.forEach((c, j) => {
    for (const nt of c.notes) {
      if (nt.p != null) { h[nt.p % 12] += b.lens?.[j] || c.len || 1; continue; } // read from notation
      const f = Number(nt.t);
      if (nt.drum || nt.tied || !Number.isFinite(f) || midi[nt.s] == null) continue;
      h[(midi[nt.s] + f) % 12] += b.lens?.[j] || c.len || 1;
    }
  });
  return h;
}
// Correlation of histogram h with profile p (both 12 long) put on tonic r.
function corrOf(h, p, r) {
  const mh = h.reduce((a, c) => a + c, 0) / 12, mp = p.reduce((a, c) => a + c, 0) / 12;
  let xy = 0, xx = 0, yy = 0;
  for (let i = 0; i < 12; i++) { const x = h[(i + r) % 12] - mh, y = p[i] - mp; xy += x * y; xx += x * x; yy += y * y; }
  return xx && yy ? xy / Math.sqrt(xx * yy) : 0;
}
// A capo for each tab part. UG gives each track its own (Trust In God's acoustic guitars: capo 6, its
// piano none), and its PDF says so ("Capo: 6th fret"). In a PDF saved before the helper wrote it, the
// capo is found: the part's notes don't fit the song's key (UG's, else the key of the parts written
// as notes), and with the capo they all do. Of the capos that fit (6 and 1 both put F# major's notes
// in C major's scale), the one whose notes centre on the key's own note (C, not G).
function partCapos(parts, lists, key) {
  let t = KEY_PC[String(key || '').replace(/m$/, '')];
  if (t != null && /m$/.test(key)) t = (t + 3) % 12; // a minor key: its relative major's scale
  if (t == null) {
    const ref = new Array(12).fill(0);
    parts.forEach((q, j) => { if (isScore(q.strips)) pitchHist(q, lists[j]).forEach((v, i) => { ref[i] += v; }); });
    if (ref.reduce((x, c) => x + c, 0) >= 40) t = majorOf(ref);
  }
  const scale = t == null ? null : new Set([0, 2, 4, 5, 7, 9, 11].map((i) => (i + t) % 12));
  return parts.map((part, k) => {
    const given = part.strips.find((s) => s.capo != null)?.capo;
    if (given != null) return given;
    if (!scale || isDrums(part.strips) || isScore(part.strips)) return 0;
    const h = pitchHist(part, lists[k]);
    const total = h.reduce((x, c) => x + c, 0);
    if (total < 40) return 0;
    const fit = (c) => h.reduce((x, v, i) => x + (scale.has((i + c) % 12) ? v : 0), 0) / total;
    if (fit(0) >= 0.85) return 0;
    const prof = Array.from({ length: 12 }, (_, i) => MAJOR_P[(i - t + 12) % 12]);
    let best = 0;
    for (let c = 1; c <= 9; c++) {
      if (fit(c) >= 0.9 && (!best || corrOf(h, prof, (12 - c) % 12) > corrOf(h, prof, (12 - best) % 12))) best = c;
    }
    return best;
  });
}
// The major key (its tonic) that a histogram fits best; a minor key gives its relative major.
function majorOf(h) {
  let best = { v: -2, major: 0 };
  for (let r = 0; r < 12; r++) {
    if (corrOf(h, MAJOR_P, r) > best.v) best = { v: corrOf(h, MAJOR_P, r), major: r };
    if (corrOf(h, MINOR_P, r) > best.v) best = { v: corrOf(h, MINOR_P, r), major: (r + 3) % 12 };
  }
  return best.major;
}
const KEY_PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
function songKey(parts, lists, capos = []) {
  const h = new Array(12).fill(0);
  parts.forEach((part, k) => pitchHist(part, lists[k]).forEach((v, i) => { h[(i + (capos[k] || 0)) % 12] += v; }));
  const total = h.reduce((a, c) => a + c, 0);
  if (total < 20) return null; // too few notes to tell
  const corr = (p, r) => corrOf(h, p, r);
  let best = { v: -2, major: 0 };
  for (let r = 0; r < 12; r++) {
    if (corr(MAJOR_P, r) > best.v) best = { v: corr(MAJOR_P, r), major: r };
    if (corr(MINOR_P, r) > best.v) best = { v: corr(MINOR_P, r), major: (r + 3) % 12 };
  }
  const fifths = (best.major * 7) % 12; // number of sharps; 7 and up read better as flats
  return KS_NAMES[(fifths > 6 ? fifths - 12 : fifths) + 7];
}

const UNITS = [[16, 1, false], [14, 2, 'dd'], [12, 2, true], [8, 2, false], [7, 4, 'dd'], [6, 4, true], [4, 4, false], [3.5, 8, 'dd'], [3, 8, true], [2, 8, false], [1.5, 16, true], [1, 16, false], [0.5, 32, false]];
const dur = (len) => {
  const u = UNITS.find(([n]) => n === len);
  return u ? `${u[1]}${u[2] === 'dd' ? '{dd}' : u[2] ? '{d}' : ''}` : null;
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

// fx: beat effects for the first beat written (e.g. lyrics "word")
const withFx = (d, fx) => (!fx ? d : d.endsWith('}') ? `${d.slice(0, -1)} ${fx}}` : `${d} {${fx}}`);
const restTex = (len, fx = '') => pieces(len).map((p, i) => `r.${withFx(dur(p), i ? '' : fx)}`).join(' ');
const fretOf = (n) => (n.tie ? '-' : n.t === 'X' ? 'x' : n.t);
// a drum hit is named by its kit piece (see drumHead), a tab note by fret and string
const noteTex = (n) => (n.drum ? n.drum : `${fretOf(n)}.${n.s + 1}`);
// own: the column's marks (f a swell, v vibrato: drawn on each note as a wavy line, as UG does; it carries through ties)
const vib = (n, own) => (own.includes('v') && !n.drum && !n.tie ? `${noteTex(n)}{v}` : noteTex(n));
const beatTex = (notes, len, fx = '', own = []) => {
  if (!notes.length) return restTex(len, fx);
  const d = withFx(dur(len), [...own.filter((e) => e !== 'v'), fx].filter(Boolean).join(' '));
  const one = notes.map((n) => vib(n, own));
  return notes.length === 1 ? `${one[0]}.${d}` : `(${one.join(' ')}).${d}`;
};
// A length with no single note value (e.g. 10 sixteenths) is written as tied notes.
const tiedTex = (notes, len, fx = '', own = []) => {
  if (!notes.length) return restTex(len, fx);
  const [first, ...rest] = pieces(len);
  const n = notes.map((x) => vib(x, own));
  const d = withFx(dur(first), [...own.filter((e) => e !== 'v'), fx].filter(Boolean).join(' '));
  const head = n.length === 1 ? `${n[0]}.${d}` : `(${n.join(' ')}).${d}`;
  if (notes[0].drum) return `${head} ${restTex(len - first)}`; // a drum isn't held: the rest of its time is quiet
  const tail = rest.map((p) => (n.length === 1 ? `-.${notes[0].s + 1}.${dur(p)}` : `(${notes.map((x) => `-.${x.s + 1}`).join(' ')}).${dur(p)}`));
  return [head, ...tail].join(' ');
};

// A syllable's time in the bar comes from where it sits between the notes above it.
function lyricTimes(b, T) {
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
  return sy.map((l, i) => ({ t: q[i], text: l.text }));
}

// Keys and pads are written simply: a chord held on (tied into the next note value) is one note, and
// every chord starts on the beat (pads, organ, strings) or the half beat (piano, keys). Returns the
// grid in sixteenths, or 0 for parts written as they are.
function keysGrid(part) {
  const n = part?.name || '';
  if (isScore(part?.strips)) return 0; // read from notation: written as it is
  if (/bass|lead|drum|vocal|guitar|shaker|percussion/i.test(n)) return 0;
  if (/pad|organ|string/i.test(n) || (part.program >= 88 && part.program <= 95)) return 4;
  if (/piano|keys|keyboard|rhodes|wurl|synth/i.test(n)) return 2;
  return 0;
}
function simplifyKeys(b, grid, T) {
  if (!b.cols.length) return;
  let cols = b.cols.map((c, k) => ({ c, t: b.times[k], len: b.lens[k] }));
  // a chord that only continues the one before it (all its notes tied, on the same strings) joins it
  cols = cols.reduce((out, x) => {
    const prev = out[out.length - 1];
    const held = prev && x.c.notes.length && x.c.notes.every((n) => n.tied && prev.c.notes.some((q) => q.s === n.s));
    if (held) prev.len += x.len; else out.push({ ...x });
    return out;
  }, []);
  // onto the grid; two chords landing on the same spot keep the first
  const kept = [];
  for (const x of cols) {
    const t = Math.min(T - grid, Math.round(x.t / grid) * grid);
    if (kept.length && t <= kept[kept.length - 1].t) continue;
    kept.push({ ...x, t: kept.length ? t : 0 });
  }
  b.cols = kept.map((x) => x.c);
  b.times = kept.map((x) => x.t);
  b.lens = kept.map((x, k) => (k + 1 < kept.length ? kept[k + 1].t : T) - x.t);
}

// A drum or percussion part's track: General MIDI drums, with its kit pieces named for the notes.
const DRUM_NOTES = { kick: 36, lowfloortom: 41, floortom: 43, lowtom: 45, snare: 38, midtom: 47, hightom: 48, pedalhat: 44, sidestick: 37, ride: 51, ridebell: 53, hihat: 42, openhat: 46, crash: 49, crash2: 57, shaker: 82, tambourine: 54 };
const isDrums = (strips) => strips.some((s) => s.drums);
const drumHead = (strips) => {
  const used = new Set(strips.flatMap((s) => s.bars.flatMap((b) => b.cols.flatMap((c) => c.notes.map((n) => n.drum)))).filter(Boolean));
  return ['\\staff {score}', '\\instrument percussion', ...[...used].map((d) => `\\articulation ${d} ${DRUM_NOTES[d]}`), '\\clef neutral'].join('\n');
};

// A part read from notation (see ugscore.js): a staff each for its clefs (a piano's two), all one track.
const isScore = (strips) => !!strips?.some((s) => s.score);
const most = (list) => list.reduce((top, v) => (list.filter((x) => x === v).length > list.filter((x) => x === top).length ? v : top), list[0]);
const scoreStaves = (strips) => {
  const sys = strips.filter((s) => s.score);
  const n = Math.max(...sys.map((s) => s.clefs.length));
  return Array.from({ length: n }, (_, k) => (most(sys.map((s) => s.clefs[k]).filter(Boolean)) === 'bass' ? 'F4' : 'G2'));
};
const scoreKey = (strips) => most(strips.filter((s) => s.score).flatMap((s) => s.keys)) || 0;
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const pitchTex = (p, flats, tied) => `${(flats ? FLATS : SHARPS)[p % 12]}${Math.floor(p / 12) - 1}${tied ? '{t}' : ''}`;
// A notation bar's events fitted to the bar: times scaled when the read lengths don't add up to it
// (a triplet read as plain notes), to the nearest thirty-second.
function fitScore(b, T) {
  const all = b.staves.flat();
  const groups = new Map(); // triplets ("3" groups), each staff's own
  for (const e of all) if (e.tu != null) groups.set(e.tu, [...(groups.get(e.tu) || []), e]);
  const k = !groups.size && b.end > 0 && Math.abs(b.end - T) > 1e-6 ? T / b.end : 1;
  const q = (v) => Math.min(T, Math.round(v * k * 2) / 2);
  for (const e of all) { e.at = q(e.t); e.dur = q(e.t + e.len) - e.at; }
  // A triplet plays its written lengths in two thirds of the time. One that ends the bar fills the
  // rest of it, and a group that doesn't add up to whole eighths has its last note put right (a
  // misread length inside it).
  b.tuplets = [];
  groups.forEach((g, id) => {
    const staff = b.staves.find((st) => st.includes(g[0]));
    const order = [...new Set(g.map((e) => e.t))].sort((x, y) => x - y);
    const firsts = order.map((t) => g.filter((e) => e.t === t));
    const g0 = q(order[0]);
    const W = firsts.reduce((sum, es) => sum + es[0].w, 0);
    const last = !staff.some((e) => e.tu !== id && e.t > order[0]);
    const D = last && T - g0 >= 2 ? T - g0 : Math.max(2, Math.round(W / 3) * 2);
    const fix = 1.5 * D - W;
    if (firsts[firsts.length - 1][0].w + fix > 0) for (const e of firsts[firsts.length - 1]) e.w += fix;
    else for (const es of firsts) for (const e of es) e.w *= (1.5 * D) / W;
    let cum = 0;
    for (const es of firsts) {
      for (const e of es) { e.at = g0 + (cum * 2) / 3; e.dur = (e.w * 2) / 3; }
      cum += es[0].w;
    }
    b.tuplets.push({ staff: b.staves.indexOf(staff), t0: g0, t1: g0 + D });
  });
  b.lens = b.cols.map((c) => c.len * k);
  b.times = [];
}
// A length as note values, inside a triplet written at 3/2 of it ("8{tu 3}").
const scorePieces = (len, tu) => (tu ? pieces(len * 1.5).map((p) => withFx(dur(p), 'tu 3')) : pieces(len).map(dur));
// One staff's bar: wherever a note starts on that staff, the notes sounding then (one still held
// from before is tied on); silence is a rest.
// A dynamic (p, mf, f) read under either staff goes on every staff's beat where it falls; `start` is
// the one to begin the staff with (the importer carries the last one on into the next staff).
function scoreBeats(b, k, T, flats, start = null) {
  const evs = (b.staves?.[k] || []).filter((e) => e.notes.length && e.dur > 0);
  const marks = (b.staves || []).flat().filter((e) => e.dy).sort((x, y) => x.at - y.at);
  const eps = 1e-6; // triplet times are thirds
  const starts = [...new Set([0, ...evs.map((e) => e.at)].map((t) => Math.round(t * 1e6) / 1e6))].filter((t) => t < T - eps).sort((x, y) => x - y);
  const tus = (b.tuplets || []).filter((g) => g.staff === k);
  return starts.map((t, j) => {
    const len = (j + 1 < starts.length ? starts[j + 1] : T) - t;
    const tu = tus.some((g) => t >= g.t0 - eps && t < g.t1 - eps);
    const held = new Map(); // pitch -> only tied on from before
    // (a note drawn with a tie into it is held on too, also over the bar line)
    for (const e of evs) if (e.at <= t + eps && e.at + e.dur > t + eps) for (const n of e.notes) held.set(n.p, (held.get(n.p) ?? true) && (e.at < t - eps || !!n.tie));
    const dy = marks.filter((e) => e.at >= t - eps && (e.at < t + len - eps || j === 0)).pop()?.dy || (j === 0 ? start : null);
    const fx = (d, i) => (i === 0 && dy ? withFx(d, `dy ${dy}`) : d);
    if (!held.size) return scorePieces(len, tu).map((d, i) => `r.${fx(d, i)}`).join(' ');
    const ps = [...held.keys()].sort((x, y) => x - y);
    return scorePieces(len, tu).map((d0, i) => {
      const d = fx(d0, i);
      const notes = ps.map((p) => pitchTex(p, flats, i > 0 || held.get(p)));
      return `${notes.length === 1 ? notes[0] : `(${notes.join(' ')})`}.${d}`;
    }).join(' ');
  }).join(' ');
}

/**
 * @param strips parsed strips in reading order ({ bars, heading })
 * @returns {{ tex: string, bars: number, exact: number } | null}
 */
// Other instruments (extra: [{ name, strips, program }]) become tracks of their own, lined up bar for bar
// with the first one (cut or padded with rests when a part has a different number of bars).
export function ugToAlphaTex(strips, { title = '', artist = '', tempo = 100, name = '', program = 27, extra = [], key = '' } = {}) {
  // each lyric syllable belongs to the bar it starts in
  // a multi-bar rest ("16" over a thick bar) stands for that many empty bars, so every part keeps the same bar count
  const barsOf = (list) => list.flatMap((s) => s.bars.flatMap((b) => {
    const lineWords = (s.lyr || []).length; // a line with no words at all (cut off, or not read) can borrow another part's
    const one = { ...b, lyr: (s.lyr || []).filter((l) => l.x >= b.x0 - 4 && l.x < b.x1 - 4), lineWords };
    return b.rest > 1 ? [one, ...Array.from({ length: b.rest - 1 }, () => ({ x0: b.x0, x1: b.x1, cols: [], lyr: [], lineWords }))] : [one];
  }));
  const bars = barsOf(strips);
  // Section names from every part: each part misses some (a name cut at the picture's edge, one
  // printed over another part's staff only) and misreads a few. A name two parts agree on (give or
  // take a bar) starts a section; with fewer than 3 parts, any name does.
  if (extra.length) {
    const groups = [];
    for (const list of [bars, ...extra.map((p) => barsOf(p.strips))]) {
      list.slice(0, bars.length).forEach((b, i) => {
        if (!b.heading || !b.name) return;
        const g = groups.find((x) => x.name === b.name && Math.abs(x.i - i) <= 1);
        if (g) g.votes.push({ i, numbered: b.numbered }); else groups.push({ name: b.name, i, votes: [{ i, numbered: b.numbered }] });
      });
    }
    const need = extra.length >= 2 ? 2 : 1;
    const at = new Map();
    for (const g of groups) {
      if (g.votes.length < need) continue;
      const is = g.votes.map((v) => v.i);
      g.i = is.reduce((top, i) => (is.filter((x) => x === i).length > is.filter((x) => x === top).length ? i : top), is[0]);
      g.numbered = g.votes.filter((v) => v.numbered).length * 2 >= g.votes.length;
      if (!at.has(g.i) || at.get(g.i).votes.length < g.votes.length) at.set(g.i, g);
    }
    bars.forEach((b, i) => {
      const g = at.get(i);
      if (g) Object.assign(b, { heading: true, name: g.name, numbered: g.numbered });
      else { b.heading = false; b.name = ''; }
    });
    // Tempo changes the same way: a part can miss a mark or misread it (Trust In God: the first part
    // had no ♩=70 at bar 175, and Lead Guitar 3 read the ♩=64 at bar 176 as 34). A change stands where
    // enough parts read one, at the value most of them read.
    const tempos = new Map();
    for (const list of [bars, ...extra.map((p) => barsOf(p.strips))]) {
      list.slice(0, bars.length).forEach((b, i) => { if (b.tempo) tempos.set(i, [...(tempos.get(i) || []), b.tempo]); });
    }
    bars.forEach((b, i) => {
      const vs = tempos.get(i) || [];
      b.tempo = vs.length >= need || i === 0 ? vs.reduce((top, v) => (vs.filter((x) => x === v).length > vs.filter((x) => x === top).length ? v : top), vs[0]) : undefined;
    });
  }
  // the bar length every part agrees on most (a part with no rhythm row has no say)
  const sums = [strips, ...extra.map((p) => p.strips)].flatMap((list) => list.flatMap((s) => s.bars))
    .filter((b) => b.cols.length >= 3 && !b.cols.some((c) => c.guess)).map((b) => b.cols.reduce((a, c) => a + c.len, 0));
  const count = {};
  sums.forEach((s) => { count[s] = (count[s] || 0) + 1; });
  const top = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  const T = top ? Math.round(Number(top[0])) : 16; // only long notes and chords (one or two a bar): 4/4
  // a part read from notation has the time signature's lower number (6/8, not 3/4)
  const printed = [strips, ...extra.map((p) => p.strips)].flatMap((list) => list.filter((s) => s.score && s.den)).map((s) => s.den)[0];
  const grouped3 = (bars.some((b) => b.cols.filter((c) => c.beamed).length === 6) || printed === 8) && T === 12;
  const num = T % 4 === 0 && !grouped3 ? T / 4 : T / 2;
  const den = T % 4 === 0 && !grouped3 ? 4 : 8;
  let exact = 0, sectionNo = 0;
  const seen = {};
  const sectionName = (b) => {
    if (!b.name) return `Part ${++sectionNo}`;
    seen[b.name] = (seen[b.name] || 0) + 1;
    return b.numbered ? `${b.name} ${seen[b.name]}` : b.name;
  };
  // the tempo mark may sit over one part's staff only (over the music staff, not the tab); when
  // parts read it differently, most of them are right (a digit misread in one part)
  const marks = [strips, ...extra.map((p) => p.strips)].map((list) => list.flatMap((s) => s.bars).find((b) => b.tempo)?.tempo).filter(Boolean);
  const firstTempo = marks.reduce((top, v) => (marks.filter((x) => x === v).length > marks.filter((x) => x === top).length ? v : top), marks[0]);
  let lastTempo = firstTempo || tempo;
  // each bar's note lengths (sixteenths) fitted to the bar, and when each note starts
  const layout = (b, first) => {
    if (b.staves) { fitScore(b, T); if (first && Math.abs(b.end - T) < 1e-6) exact++; return; }
    let lens = b.cols.map((c) => c.len);
    const sum = lens.reduce((a, c) => a + c, 0);
    if (Math.round(sum) === T && !b.cols.some((c) => c.guess)) { if (first) exact++; } // every part keeps a rhythm row that adds up
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
    b.lens = lens;
    let at = 0;
    b.times = b.cols.map((c, k) => { const t = at; at += lens[k]; return t; });
  };
  // A drum bar with the sung words under it: a syllable that starts between two hits splits the
  // time there (a drum hit isn't held, so the rest of its time is a rest that carries the word).
  const wordedBeats = (b, ws) => {
    const starts = [...new Set([0, ...b.times, ...ws.map((w) => w.t)])].filter((t) => t < T).sort((x, y) => x - y);
    return starts.map((s, k) => {
      const len = (k + 1 < starts.length ? starts[k + 1] : T) - s;
      const c = b.times.indexOf(s);
      const said = ws.filter((w) => w.t === s).map((w) => w.text).join(' ');
      const fx = said ? `lyrics ${JSON.stringify(said)}` : '';
      const own = c >= 0 ? b.cols[c].fx || [] : [];
      return pieces(len).length === 1 ? beatTex(c >= 0 ? b.cols[c].notes : [], len, fx, own) : tiedTex(c >= 0 ? b.cols[c].notes : [], len, fx, own);
    }).join(' ');
  };
  // The vocal part carries the words itself: each syllable sits on the sung note nearest its time
  // (a bar with no notes keeps them on rests).
  const sungBeats = (b, ws) => {
    // words go on sung notes only, never on a rest
    const sung = b.cols.map((c, j) => j).filter((j) => b.cols[j].notes.length);
    if (!sung.length) return wordedBeats(b, ws);
    const fx = b.cols.map(() => []);
    for (const w of ws) {
      let i = 0;
      sung.forEach((j, n) => { if (Math.abs(b.times[j] - w.t) < Math.abs(b.times[sung[i]] - w.t)) i = n; });
      while (fx[sung[i]].length && i + 1 < sung.length && b.times[sung[i]] < w.t) i++; // the note is taken: the next one
      const k = sung[i];
      fx[k].push(w.text);
    }
    return b.cols.map((c, k) => {
      const f = fx[k].length ? `lyrics ${JSON.stringify(fx[k].join(' '))}` : '';
      return pieces(b.lens[k]).length === 1 ? beatTex(c.notes, b.lens[k], f, c.fx) : tiedTex(c.notes, b.lens[k], f, c.fx);
    }).join(' ');
  };
  const render = (barList, first, words = [], sungPart = false, ks = null, staff = null) => {
  let prevStrings = new Set();
  return barList.map((b, i) => {
    if (staff) { // a staff of a part read from notation
      const head = [];
      if (first) {
        if (b.heading || i === 0) head.push(`\\section ${JSON.stringify(sectionName(b))}`);
        if (b.tempo && b.tempo !== lastTempo) { head.push(`\\tempo ${b.tempo}`); lastTempo = b.tempo; }
        if (i === 0) head.push(`\\ts ${num} ${den}`);
      }
      if (i === 0) head.push(`\\clef ${staff.clef}`, `\\ks ${KS_NAMES[staff.key + 7]}`);
      return `${head.join(' ')} ${scoreBeats(b, staff.k, T, staff.key < 0, i === 0 ? 'f' : null) || restTex(T)}`.trim();
    }
    const lens = b.lens;
    for (const c of b.cols) {
      for (const n of c.notes) n.tie = n.tied && prevStrings.has(n.s); // only a note on a string that was just played can be a tie
      prevStrings = new Set(c.notes.map((n) => n.s));
    }
    if (!b.cols.length) prevStrings = new Set();
    const beats = words[i]?.length ? [sungPart ? sungBeats(b, words[i]) : wordedBeats(b, words[i])]
      : b.cols.map((c, k) => (pieces(lens[k]).length === 1 ? beatTex(c.notes, lens[k], '', c.fx) : tiedTex(c.notes, lens[k], '', c.fx)));
    if (!beats.length) beats.push(restTex(T));
    const head = [];
    if (first) {
      if (b.heading || i === 0) head.push(`\\section ${JSON.stringify(sectionName(b))}`);
      if (b.tempo && b.tempo !== lastTempo) { head.push(`\\tempo ${b.tempo}`); lastTempo = b.tempo; }
      if (i === 0) head.push(`\\ts ${num} ${den}`);
    }
    if (i === 0 && ks) head.push(`\\ks ${ks}`);
    return `${head.join(' ')} ${beats.join(' ')}`.trim();
  });
  };
  const lists = [bars, ...extra.map((part) => {
    const list = barsOf(part.strips).slice(0, bars.length);
    while (list.length < bars.length) list.push({ x0: 0, x1: 1, cols: [], lyr: [] });
    return list;
  })];
  lists.forEach((list, k) => list.forEach((b) => layout(b, k === 0)));
  const parts = [{ name, program, strips }, ...extra];
  lists.forEach((list, k) => { const g = keysGrid(parts[k]); if (g) list.forEach((b) => simplifyKeys(b, g, T)); });
  // the lyrics come from whichever part has them (the vocal part, wherever it sits in the order);
  // drum and percussion parts show them under their notes too, as their own PDFs do
  // (the part with the most words is the singer's; another part's words fill the singer's lines that have none)
  const worded = lists.filter((l) => l.some((b) => b.lyr.length)).map((l) => [l, l.filter((b) => b.lyr.length).length]);
  const sungBars = worded.sort((a, b) => b[1] - a[1])[0]?.[0];
  const sung = !!sungBars;
  const words = sung ? sungBars.map((b, i) => {
    if (b.lyr.length) return lyricTimes(b, T);
    const other = b.lineWords === 0 && worded.find(([l]) => l !== sungBars && l[i]?.lyr.length)?.[0];
    return other ? lyricTimes(other[i], T) : [];
  }) : [];
  const sungAt = lists.indexOf(sungBars);
  const pitched = parts.map((p, k) => k).filter((k) => !isDrums(parts[k].strips));
  const capos = partCapos(parts, lists, key);
  const ks = songKey(pitched.map((k) => parts[k]), pitched.map((k) => lists[k]), pitched.map((k) => capos[k]));
  const capoTex = (k) => (capos[k] ? `\n\\capo ${capos[k]}` : '');
  // a part read from notation: one track, a staff for each clef
  const scoreTrack = (list, part, first) => {
    const key = scoreKey(part.strips);
    return scoreStaves(part.strips).map((clef, k) => `\\staff {score}\n\\instrument ${part.program ?? 0}\n`
      + render(list, first && !k, [], false, null, { k, clef, key }).join(' |\n')).join('\n');
  };
  const out = isScore(strips) ? scoreTrack(bars, parts[0], true)
    : render(bars, true, isDrums(strips) || sungAt === 0 ? words : [], sungAt === 0, isDrums(strips) ? null : ks).join(' |\n');
  const header = [
    `\\title ${JSON.stringify(title)}`,
    artist ? `\\artist ${JSON.stringify(artist)}` : '',
    `\\tempo ${Math.round(firstTempo || tempo)}`,
    '.',
    `\\track ${JSON.stringify(name || title || 'Guitar')}`,
    ...(isScore(strips) ? [] : isDrums(strips) ? [drumHead(strips)] : ['\\staff {score tabs}', `\\tuning ${tuningTex(strips)}${capoTex(0)}`, `\\instrument ${program}`]),
  ].filter(Boolean).join('\n');
  const others = extra.map((part, k) => {
    if (isScore(part.strips)) return `\n\\track ${JSON.stringify(part.name)}\n${scoreTrack(lists[k + 1], part, false)}`;
    const drums = isDrums(part.strips);
    const head = drums ? drumHead(part.strips) : `\\staff {score tabs}\n\\tuning ${tuningTex(part.strips)}${capoTex(k + 1)}\n\\instrument ${part.program ?? 27}`;
    return `\n\\track ${JSON.stringify(part.name)}\n${head}\n${render(lists[k + 1], false, drums || sungAt === k + 1 ? words : [], sungAt === k + 1, drums ? null : ks).join(' |\n')}`;
  }).join('');
  return { tex: `${header}\n${out}${others}`, bars: bars.length, exact, lyrics: sung, tracks: 1 + extra.length };
}
