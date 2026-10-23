// Reads Ultimate Guitar printouts written as notes (piano and other parts with no tab): five-line
// music staves, a grand staff's two joined by their bar lines. Each note's pitch comes from where its
// head sits (clef, key signature, accidentals), its length from the head (filled or hollow), stem,
// flags, beams and dots. The image is normalised to a staff spacing of UG_UNIT pixels (see pdftab.js).

import { readHeading, readRestCount } from './ugtext.js';
import { thickRest } from './ugtab.js';

/* ---------- staves ---------- */

// Every five-line staff: five long rows of ink, equally spaced, starting at the same x. A tie or
// slur running along a line (a flat arc) thickens it but doesn't make it a different line.
export function findMusicStaves(light, w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let run = 0, longest = 0, x0 = 0, longX = 0;
    for (let x = 0; x < w; x++) {
      if (light[y * w + x]) { if (!run) x0 = x; run++; if (run > longest) { longest = run; longX = x0; } } else run = 0;
    }
    rows.push({ longest, longX });
  }
  // a line's rows are the longest around them (an arc along a line, or bridging two, is shorter)
  const bands = [];
  for (let y = 0; y < h; y++) {
    const l = rows[y].longest;
    if (l < 0.07 * w) continue;
    let near = 0;
    for (let d = -3; d <= 3; d++) if (y + d >= 0 && y + d < h) near = Math.max(near, rows[y + d].longest);
    if (l < 0.8 * near) continue;
    const b = bands[bands.length - 1];
    if (b && y - b.y1 <= 1) { b.y1 = y; b.sum += y; b.n++; b.len = Math.max(b.len, l); b.x0 = Math.min(b.x0, rows[y].longX); }
    else bands.push({ y0: y, y1: y, sum: y, n: 1, len: l, x0: rows[y].longX });
  }
  const lines = bands.map((b) => ({ y: b.sum / b.n, n: b.n, len: b.len, x0: b.x0 }));
  const out = [];
  let taken = -1;
  for (let i = 0; i + 4 < lines.length; i++) {
    if (i <= taken) continue;
    // the next four lines a space apart (a beam or a row of words between two is passed over)
    let five = null;
    for (let j = i + 1; j < lines.length && !five; j++) {
      const g = lines[j].y - lines[i].y;
      if (g < 8) continue;
      if (g > 30) break;
      const pick = [lines[i], lines[j]];
      for (let k = 2; k < 5; k++) {
        const want = pick[k - 1].y + g;
        const l = lines.find((x) => Math.abs(x.y - want) <= 0.15 * g);
        if (!l) break;
        pick.push(l);
      }
      if (pick.length === 5) five = pick;
    }
    if (!five) continue;
    const gaps = five.slice(1).map((l, k) => l.y - five[k].y);
    const u = (five[4].y - five[0].y) / 4;
    if (gaps.some((g) => Math.abs(g - u) > 0.12 * u)) continue;
    if (Math.max(...five.map((l) => l.x0)) - Math.min(...five.map((l) => l.x0)) > 2 * u) continue;
    if (Math.min(...five.map((l) => l.len)) < 0.8 * Math.max(...five.map((l) => l.len))) continue;
    const ys = five.map((l) => l.y);
    const y = Math.round(ys[0]);
    let x0 = 0, x1 = w - 1;
    while (x0 < w && !light[y * w + x0]) x0++;
    while (x1 > 0 && !light[y * w + x1]) x1--;
    out.push({ ys, x0, x1, u, lw: Math.round(five.reduce((t, l) => t + l.n, 0) / 5) });
    taken = lines.indexOf(five[4]);
  }
  return out;
}

// ink straight down column x from y0 to y1 (a pixel either side), allowing a gap or two
function column(light, w, x, y0, y1) {
  let miss = 0;
  for (let y = Math.round(y0); y <= Math.round(y1); y++) if (!light[y * w + x - 1] && !light[y * w + x] && !light[y * w + x + 1]) miss++;
  return miss <= 2;
}

/** Staves joined at their left edge by one line (a grand staff's two) make one system: [[st, st], [st], ...] */
export function musicSystems(light, w, staves) {
  const out = [];
  for (const st of staves) {
    const prev = out[out.length - 1]?.at(-1);
    const joined = prev && [0, 1, 2, -1, -2].some((d) => column(light, w, Math.round(st.x0) + d, prev.ys[4], st.ys[0]));
    if (joined) out[out.length - 1].push(st); else out.push([st]);
  }
  return out;
}

/** A system's bar lines: lines straight down through all its staves (a stem stops at its note). */
export function systemBars(light, w, sys) {
  const top = sys[0].ys[0], bot = sys[sys.length - 1].ys[4], u = sys[0].u;
  const xs = [];
  for (let x = Math.round(sys[0].x0); x <= Math.round(sys[0].x1); x++) {
    let n = 0;
    for (let y = Math.round(top); y <= Math.round(bot); y++) n += light[y * w + x];
    if (n >= 0.97 * (Math.round(bot) - Math.round(top) + 1)) xs.push(x);
  }
  const groups = [];
  for (const x of xs) {
    const g = groups[groups.length - 1];
    if (g && x - g[g.length - 1] <= 2) g.push(x); else groups.push([x]);
  }
  let bars = groups.map((g) => ({ x: (g[0] + g[g.length - 1]) / 2, wd: g.length }));
  // one staff alone: a stem as tall as the staff could pass, but it has a note head at one end
  if (sys.length === 1) {
    const head = (x, y) => {
      let n = 0;
      for (let yy = Math.round(y - 0.6 * u); yy <= Math.round(y + 0.6 * u); yy++) for (const d of [-1, 1]) for (let k = 2; k <= Math.round(0.9 * u); k++) n += light[yy * w + Math.round(x + d * k)];
      return n > 0.5 * u * u;
    };
    bars = bars.filter((b) => !head(b.x, top) && !head(b.x, bot));
  }
  // the thin and thick lines of a double bar are one bar line
  const out = bars.filter((b, i) => i === 0 || b.x - bars[i - 1].x > u).map((b) => b.x);
  if (out.length && sys[0].x1 - out[out.length - 1] > 4 * u) out.push(sys[0].x1);
  return out;
}

/* ---------- note heads ---------- */

// The ink of a band around a staff with its staff lines and ledger lines taken out: a pixel on a line
// row whose ink runs no more than a line's thickness up and down. Returns { img, y0, y1 } (rows y0..y1).
export function cleanBand(ink, w, st, y0, y1) {
  y0 = Math.max(0, Math.round(y0)); y1 = Math.round(y1);
  const H = y1 - y0 + 1;
  const img = new Uint8Array(w * H);
  for (let y = y0; y <= y1; y++) img.set(ink.subarray(y * w, y * w + w), (y - y0) * w);
  const u = st.u, thin = (st.lw || 2) + 1; // a line's own thickness (an arc or a head's rim joined to it is thicker)
  const at = (x, y) => (y < 0 || y >= H ? 0 : img[y * w + x]);
  // rows of the staff lines and of any ledger line (a short line on a line position outside the staff)
  const rows = [];
  for (let k = 1; k <= 6; k++) rows.push(st.ys[0] - k * u, st.ys[4] + k * u);
  rows.push(...st.ys);
  for (const ly of rows) {
    const c = Math.round(ly) - y0;
    if (c < -2 || c >= H + 2) continue;
    for (let x = Math.round(st.x0); x <= Math.round(st.x1); x++) {
      for (let y = c - 2; y <= c + 2; y++) {
        if (!at(x, y)) continue;
        let a = y, b = y;
        while (at(x, a - 1)) a--;
        while (at(x, b + 1)) b++;
        if (b - a + 1 <= thin && Math.abs((a + b) / 2 - (ly - y0)) <= 1) for (let yy = a; yy <= b; yy++) img[yy * w + x] = 0;
      }
    }
  }
  return { img, y0, y1, H };
}

// Summed-area table of a band, for counting ink in boxes.
function integral(img, w, H) {
  const s = new Uint32Array((w + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += img[y * w + x]; s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1] + row; }
  }
  return (x0, y0, x1, y1) => s[(y1 + 1) * (w + 1) + x1 + 1] - s[y0 * (w + 1) + x1 + 1] - s[(y1 + 1) * (w + 1) + x0] + s[y0 * (w + 1) + x0];
}

export function blobs(mask, w, H, x0, x1) {
  const seen = new Uint8Array(w * H), out = [];
  for (let y = 0; y < H; y++) for (let x = x0; x <= x1; x++) {
    if (!mask[y * w + x] || seen[y * w + x]) continue;
    const st = [[x, y]]; seen[y * w + x] = 1;
    let a = x, b = x, c = y, d = y, n = 0, sx = 0, sy = 0;
    while (st.length) {
      const [px, py] = st.pop();
      n++; sx += px; sy += py;
      a = Math.min(a, px); b = Math.max(b, px); c = Math.min(c, py); d = Math.max(d, py);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < x0 || nx > x1 || ny < 0 || ny >= H || !mask[ny * w + nx] || seen[ny * w + nx]) continue;
        seen[ny * w + nx] = 1; st.push([nx, ny]);
      }
    }
    out.push({ x0: a, x1: b, y0: c, y1: d, n, cx: sx / n, cy: sy / n });
  }
  return out;
}

/**
 * Note heads in a cleaned band: filled ones are where a box half a space each way is all ink (stems,
 * lines, dots and letters are thinner); hollow ones are a small hole ringed by ink a head wide.
 * Returns [{ cx, cy, hollow }] in page pixels.
 */
export function noteHeads(band, pale, w, st, xa, xb) {
  const { img, y0, H } = band, u = st.u;
  const sum = integral(img, w, H);
  const bw = Math.round(0.28 * u), bh = Math.round(0.26 * u);
  const core = new Uint8Array(w * H);
  for (let y = bh; y < H - bh; y++) for (let x = Math.max(bw, xa); x <= Math.min(w - 1 - bw, xb); x++) {
    if (img[y * w + x] && sum(x - bw, y - bh, x + bw, y + bh) === (2 * bw + 1) * (2 * bh + 1)) core[y * w + x] = 1;
  }
  const heads = [];
  for (const b of blobs(core, w, H, xa, xb)) {
    const bwid = b.x1 - b.x0 + 1, bhei = b.y1 - b.y0 + 1;
    if (bwid > 1.3 * u) continue; // a beam
    // two heads a step apart on one side of the stem can join: one per half space of height
    const k = Math.max(1, Math.round(bhei / (0.5 * u)) - (bhei < 0.75 * u ? 0 : 0));
    if (bhei > 0.7 * u) {
      const n = Math.round((bhei + 0.2 * u) / (0.5 * u)) - 1;
      for (let i = 0; i < n; i++) heads.push({ cx: b.cx, cy: y0 + b.y0 + (bhei / n) * (i + 0.5), hollow: false, w: bwid });
    } else heads.push({ cx: b.cx, cy: y0 + b.cy, hollow: false, w: bwid, k });
  }
  // hollow heads: white holes, small, with ink right round them a head's width across (the pale
  // edge pixels count as ink here, or a thin rim leaks)
  const white = new Uint8Array(w * H);
  for (let y = 0; y < H; y++) for (let x = xa; x <= xb; x++) white[y * w + x] = pale.img[y * w + x] ? 0 : 1;
  for (const b of blobs(white, w, H, xa, xb)) {
    const bwid = b.x1 - b.x0 + 1, bhei = b.y1 - b.y0 + 1;
    if (b.x0 <= xa || b.x1 >= xb || b.y0 === 0 || b.y1 === H - 1) continue;
    if (bwid > 1.1 * u || bhei > 0.8 * u || b.n < 0.04 * u * u) continue;
    const y = Math.round(b.cy);
    let l = b.x0, r = b.x1;
    while (l > xa && pale.img[y * w + l - 1]) l--;
    while (r < xb && pale.img[y * w + r + 1]) r++;
    if (r - l + 1 < 1.0 * u) continue; // a letter's or a sharp's hole
    // a hollow head's rim is thin above and below the hole; the gap between two filled heads (or a
    // tie and a head) has a whole head of ink on at least one side
    const x = Math.round(b.cx);
    let up = 0, dn = 0;
    while (b.y0 - up - 1 >= 0 && pale.img[(b.y0 - up - 1) * w + x]) up++;
    while (b.y1 + dn + 1 < H && pale.img[(b.y1 + dn + 1) * w + x]) dn++;
    if (up > 0.45 * u || dn > 0.45 * u) continue;
    heads.push({ cx: (l + r) / 2, cy: y0 + b.cy, hollow: true, w: r - l + 1, hole: [bwid, bhei] });
  }
  return heads;
}

/* ---------- stems, beams, flags, dots ---------- */

// Upright strokes at least two spaces long in a cleaned band: [{ x, top, bot }] in page pixels.
export function stemsIn(band, w, st, xa, xb) {
  const { img, y0, H } = band, u = st.u;
  const cols = [];
  for (let x = xa; x <= xb; x++) {
    let run = 0;
    for (let y = 0; y <= H; y++) {
      if (y < H && img[y * w + x]) { run++; continue; }
      if (run >= 2 * u) cols.push({ x, top: y0 + y - run, bot: y0 + y - 1 });
      run = 0;
    }
  }
  const out = [];
  for (const c of cols.sort((a, b) => a.x - b.x)) {
    const s = out.find((q) => c.x - q.x1 <= 1 && c.x - q.x1 >= 0 && Math.min(q.bot, c.bot) - Math.max(q.top, c.top) > u);
    if (s) { s.x1 = c.x; s.top = Math.min(s.top, c.top); s.bot = Math.max(s.bot, c.bot); s.n++; }
    else out.push({ x0: c.x, x1: c.x, top: c.top, bot: c.bot, n: 1 });
  }
  // a stem is thin; a thick upright is a bar line or part of a letter or clef
  // and stands clear of the notes for a good part of its length (a stack of note heads a third apart
  // is a tall run of ink too, but wide all the way)
  const thin = (s) => {
    const x = Math.round((s.x0 + s.x1) / 2);
    let n = 0;
    for (let y = s.top - y0; y <= s.bot - y0; y++) {
      let l = x, r = x;
      while (l > 0 && x - l < u && img[y * w + l - 1]) l--;
      while (r < w - 1 && r - x < u && img[y * w + r + 1]) r++;
      if (r - l + 1 <= 0.4 * u) n++;
    }
    return n >= 1.2 * u;
  };
  return out.filter((s) => s.x1 - s.x0 <= 0.25 * u && thin(s)).map((s) => ({ x: (s.x0 + s.x1) / 2, top: s.top, bot: s.bot }));
}

// Beams or flags at a stem's free end: 0 (none), 1 (eighth), 2, 3. dir -1: the stem goes up from its
// note (the end is its top), 1: down.
// limit: how far in from the end to look (the stem's nearest note head stops it).
export function stemTail(band, w, s, dir, u, limit = 2.2 * u) {
  const end = dir < 0 ? s.top : s.bot;
  const at = (x, d) => { const y = Math.round(end - dir * d) - band.y0; return y < 0 || y >= band.H ? 0 : band.img[y * w + Math.round(x)]; }; // d: distance in from the end
  const reach = Math.round(Math.min(2.2 * u, limit));
  // beams: bands of ink that run on (nearly level) 1.1 spaces or more to one side
  const joined = (side) => {
    let bands = 0, inBand = false;
    for (let d = -2; d <= reach; d++) {
      let n = 0;
      const span = Math.round(1.1 * u);
      for (let k = 1; k <= span; k++) n += at(s.x + side * k, d);
      const on = n >= 0.9 * span;
      if (on && !inBand) bands++;
      inBand = on;
    }
    return bands;
  };
  const far = Math.max(joined(1), joined(-1));
  // short bands (a sixteenth's stub beside eighths) or a flag's strokes just right of the stem
  const strokes = (x0, x1) => {
    let best = 0;
    for (let x = Math.round(x0); x <= Math.round(x1); x++) {
      let n = 0, gap = 2;
      for (let d = -1; d <= reach; d++) { if (at(x, d)) { if (gap >= 2) n++; gap = 0; } else gap++; }
      best = Math.max(best, n);
    }
    return best;
  };
  const near = Math.max(strokes(s.x + 0.25 * u, s.x + 0.45 * u), far ? strokes(s.x - 0.45 * u, s.x - 0.25 * u) : 0);
  return { beams: Math.min(3, Math.max(far, near)), beamed: far > 0 };
}

/* ---------- one staff ---------- */

const STEP = [0, 2, 4, 5, 7, 9, 11];
const TOP_LINE = { treble: 38, bass: 26 }; // the top line's note, counted in letter steps from C0 (F5, A3)
export const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
export const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
export const midiOf = (d, alter) => 12 * (Math.floor(d / 7) + 1) + STEP[((d % 7) + 7) % 7] + alter;

// Upright strokes in a blob (columns with a long run of ink): 1 for a flat, 2 for a sharp or natural.
function strokesOf(img, w, b, u) {
  const out = [];
  for (let x = b.x0; x <= b.x1; x++) {
    let run = 0, best = 0;
    for (let y = b.y0; y <= b.y1; y++) { run = img[y * w + x] ? run + 1 : 0; best = Math.max(best, run); }
    if (best < 1.1 * u) continue;
    const last = out[out.length - 1];
    if (last && x - last.x1 <= 1) { last.x1 = x; last.len = Math.max(last.len, best); } else out.push({ x1: x, len: best });
  }
  return out;
}
// -1 flat, 1 sharp, 0 natural, null none of them. A flat's one tall stroke is on its left (its bowl's
// side can be long enough to count, but is much shorter); a sharp's and a natural's two are alike.
const accidentalOf = (img, w, b, u) => {
  const k = strokesOf(img, w, b, u);
  if (!k.length) return null;
  const top = Math.max(...k.map((q) => q.len));
  if (k.length === 1 || (k[0].len === top && k.slice(1).every((q) => q.len < 0.7 * top))) return -1;
  return b.x1 - b.x0 + 1 >= 0.7 * u ? 1 : 0;
};

/**
 * Everything on one staff of a system between rows ya and yb: the clef, the key signature (sharps
 * positive, flats negative), the time signature's lower number if there is one, and the chords and
 * rests, each { x, notes: [{ d (letter steps from C0), acc, hollow, y }], len (sixteenths), rest }.
 */
export function readStaff(ink, light, w, st, ya, yb, bars) {
  const u = st.u;
  const band = cleanBand(ink, w, st, ya, yb), pale = cleanBand(light, w, st, ya, yb);
  const { img, y0, H } = band;
  const xL = Math.round(st.x0), xR = Math.round(st.x1);
  const isBar = (x0, x1) => bars.some((b) => b >= x0 - 2 && b <= x1 + 2);
  const all = blobs(img, w, H, xL, xR).map((b) => ({ ...b, ly0: b.y0, ly1: b.y1, y0: b.y0 + y0, y1: b.y1 + y0, cy: b.cy + y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 }));
  const local = (b) => ({ x0: b.x0, x1: b.x1, y0: b.ly0, y1: b.ly1 });
  const inStaff = (b) => b.y1 > st.ys[0] - 2.5 * u && b.y0 < st.ys[4] + 2.5 * u;
  const posOf = (y) => Math.round((y - st.ys[0]) / (u / 2));
  // the header: clef, key signature, time signature
  const head = all.filter((b) => inStaff(b) && b.x0 < xL + 20 * u && !isBar(b.x0, b.x1)).sort((a, b) => a.x0 - b.x0);
  const clefB = head.find((b) => b.h >= 2.5 * u && b.x0 < xL + 2 * u);
  const clef = clefB && clefB.h >= 5 * u ? 'treble' : 'bass';
  let end = clefB ? clefB.x1 : xL + 3.5 * u;
  for (const b of head) if (b !== clefB && b.x0 < end + 0.9 * u && b.w < 0.6 * u && b.h < 0.6 * u) end = Math.max(end, b.x1); // the bass clef's dots
  const top = TOP_LINE[clef], shift = clef === 'bass' ? 2 : 0;
  let key = 0;
  for (const b of head) {
    if (b.x0 <= end || b.x0 > end + 1.6 * u) continue;
    if (b.h < 1.6 * u || b.h > 3.2 * u || b.w > 1.2 * u) break;
    const a = accidentalOf(img, w, local(b), u);
    if (!a) break;
    const n = Math.abs(key);
    if (n && Math.sign(key) !== a) break;
    // each one sits where the key signature's order puts it
    const want = a > 0 ? [0, 3, -1, 2, 5, 1, 4][n] : [4, 1, 5, 2, 6, 3, 7][n];
    const pos = a > 0 ? posOf(b.cy) : posOf(b.y1 - 0.55 * u);
    if (want == null || Math.abs(pos - (want + shift)) > 1) break;
    key += a;
    end = b.x1;
  }
  // the time signature: two numbers stacked, the lower one 8 (two holes), 4 (one) or 2 (none)
  let den = 0;
  // (the two numbers often touch at the middle line and come as one blob)
  const nums = head.filter((b) => b.x0 > end && b.x0 < end + 1.6 * u && b.h >= 1.6 * u && b.w <= 2.5 * u && b.y0 > st.ys[0] - 0.4 * u && b.y1 < st.ys[4] + 0.4 * u);
  if (nums.length && Math.max(...nums.map((b) => b.y1)) - Math.min(...nums.map((b) => b.y0)) >= 3.4 * u) {
    const bx0 = Math.min(...nums.map((b) => b.x0)), bx1 = Math.max(...nums.map((b) => b.x1));
    const by0 = Math.round(st.ys[2] - 0.1 * u - y0), by1 = Math.max(...nums.map((b) => b.ly1));
    const white = new Uint8Array(w * H);
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) white[y * w + x] = pale.img[y * w + x] ? 0 : 1;
    const holes = blobs(white, w, H, bx0, bx1).filter((q) => q.y0 > by0 && q.y1 < by1 && q.x0 > bx0 && q.x1 < bx1 && q.n >= 0.04 * u * u).length;
    den = holes >= 2 ? 8 : holes === 1 ? 4 : 2;
    end = bx1;
  }
  const xa = Math.round(end + 0.3 * u);
  // note heads (a grace note's small head is left out), and the stems
  // a note over or under the staff has a ledger line next to the staff (words over it, "Moderate",
  // have letters with holes like hollow heads)
  const ledger = (h) => {
    const ly = h.cy < st.ys[0] ? st.ys[0] - u : st.ys[4] + u;
    for (let y = Math.round(ly - 3); y <= Math.round(ly + 3); y++) {
      let run = 0;
      for (let x = Math.round(h.cx - 1.2 * u); x <= Math.round(h.cx + 1.2 * u); x++) {
        run = ink[y * w + x] ? run + 1 : 0;
        if (run >= 1.3 * u) return true;
      }
    }
    return false;
  };
  const heads = noteHeads(band, pale, w, st, xa, xR)
    .filter((h) => (h.hollow || h.w >= 0.35 * u) && !isBar(h.cx - 0.5 * u, h.cx + 0.5 * u) && h.cy > ya + 0.4 * u && h.cy < yb - 0.4 * u)
    .filter((h) => (h.cy > st.ys[0] - 0.75 * u && h.cy < st.ys[4] + 0.75 * u) || ledger(h));
  const stems = stemsIn(band, w, st, xa, xR).filter((s) => !isBar(s.x, s.x));
  const chords = [];
  const used = new Set();
  for (const s of stems) {
    const on = heads.filter((h) => !used.has(h) && Math.abs(h.cx - s.x) <= 1.0 * u && h.cy >= s.top - 0.7 * u && h.cy <= s.bot + 0.7 * u);
    if (!on.length) continue;
    // the note at the stem's end: left of an up stem at its foot, right of a down stem at its top
    const upEnd = on.find((h) => h.cx < s.x && Math.abs(h.cy - s.bot) < 0.8 * u);
    const downEnd = on.find((h) => h.cx > s.x && Math.abs(h.cy - s.top) < 0.8 * u);
    if (!upEnd && !downEnd) continue;
    const dir = upEnd && (!downEnd || s.bot - upEnd.cy < downEnd.cy - s.top) ? -1 : 1;
    on.forEach((h) => used.add(h));
    const free = dir < 0 ? s.top : s.bot;
    const nearest = Math.min(...on.map((h) => Math.abs(h.cy - free)));
    const tail = stemTail(band, w, s, dir, u, nearest - 0.75 * u);
    chords.push({ x: dir < 0 ? s.x - 0.65 * u : s.x + 0.65 * u, stem: s, dir, heads: on, hollow: on.some((h) => h.hollow), beams: tail.beams, beamed: tail.beamed });
  }
  for (const h of heads) if (!used.has(h)) chords.push({ x: h.cx, heads: [h], hollow: h.hollow, beams: 0, whole: h.hollow });
  // dots: small round blobs just right of the chord's notes
  const dots = all.filter((b) => b.w >= 0.2 * u && b.w <= 0.55 * u && b.h >= 0.2 * u && b.h <= 0.55 * u && b.n >= 0.5 * b.w * b.h);
  for (const c of chords) {
    const right = Math.max(...c.heads.map((h) => h.cx + 0.65 * u));
    c.dot = dots.some((d) => d.x0 > right && d.x0 < right + 1.0 * u && c.heads.some((h) => Math.abs(d.cy - h.cy) < 0.75 * u));
    const base = c.whole ? 16 : c.hollow ? 8 : 4 / 2 ** c.beams;
    c.len = c.dot ? base * 1.5 : base;
  }
  // accidentals: a sharp, flat or natural just left of a note, level with it
  const accs = all.filter((b) => b.h >= 1.5 * u && b.h <= 3.2 * u && b.w >= 0.35 * u && b.w <= 1.2 * u && b.x0 >= xa - 0.3 * u);
  const notes = [];
  for (const c of chords) {
    c.notes = c.heads.map((h) => ({ d: top - posOf(h.cy), acc: null, hollow: h.hollow, y: h.cy, x: h.cx }));
    notes.push(...c.notes);
  }
  for (const b of accs) {
    const a = accidentalOf(img, w, local(b), u);
    if (a == null) continue;
    const mid = a < 0 ? b.y1 - 0.55 * u : b.cy;
    const best = notes.filter((n) => n.x - 0.65 * u > b.x1 - 0.2 * u && n.x - 0.65 * u - b.x1 < 3.2 * u && Math.abs(n.y - mid) < 0.4 * u).sort((p, q) => p.x - q.x)[0];
    if (best) best.acc = a;
  }
  // rests: shapes in the staff that are none of the above
  const taken = (b) => chords.some((c) => c.heads.some((h) => Math.abs(h.cx - (b.x0 + b.x1) / 2) < 0.9 * u && Math.abs(h.cy - b.cy) < 0.9 * u)
    || (c.stem && b.x0 <= c.stem.x + 1 && b.x1 >= c.stem.x - 1 && b.y1 >= c.stem.top && b.y0 <= c.stem.bot));
  const rests = [];
  for (const c of all) {
    if (c.x0 < xa || isBar(c.x0, c.x1) || c.cy < st.ys[0] || c.cy > st.ys[4] || c.w < 0.4 * u || c.w > 1.4 * u || taken(c)) continue;
    let len = 0;
    if (c.h >= 1.7 * u && c.h <= 2.3 * u && c.w <= 0.95 * u && c.n >= 0.15 * c.w * c.h) len = c.w <= 0.75 * u ? 4 : 1;
    else if (c.h >= 1.0 * u && c.h <= 1.5 * u && c.w >= 0.5 * u && c.w <= 0.95 * u && c.n >= 0.15 * c.w * c.h) len = 2;
    else if (c.h >= 0.3 * u && c.h <= 0.65 * u && c.w >= 0.7 * u && c.n >= 0.8 * c.w * c.h) {
      const line = (y) => st.ys.some((ly) => Math.abs(ly - y) <= 2.5);
      len = line(c.y1 + 1) ? 8 : line(c.y0 - 1) ? 16 : 0;
    }
    if (!len) continue;
    const dot = dots.some((d) => d.x0 > c.x1 && d.x0 - c.x1 < 0.8 * u && Math.abs(d.cy - c.cy) < 1.0 * u);
    rests.push({ x: (c.x0 + c.x1) / 2, len: dot ? len * 1.5 : len, rest: true, notes: [], whole: len === 16, box: c });
  }
  return { clef, key, den, xa, events: [...chords, ...rests].sort((a, b) => a.x - b.x) };
}

/**
 * A page's systems, each { staves: [readStaff results], bars: [x of each bar line] }. Each staff is
 * read between the midpoints to the staves above and below it on the page (at most 6 spaces away),
 * so the next system's notes or the words between two systems aren't read twice.
 */
export function readPage(ink, light, w, h) {
  const systems = musicSystems(light, w, findMusicStaves(light, w, h));
  const all = systems.flat();
  return systems.map((sys) => {
    const bars = systemBars(light, w, sys);
    const staves = sys.map((st) => {
      const i = all.indexOf(st), up = all[i - 1], down = all[i + 1];
      const ya = Math.max(st.ys[0] - 6 * st.u, up ? (up.ys[4] + st.ys[0]) / 2 : 0);
      const yb = Math.min(st.ys[4] + 6 * st.u, down ? (st.ys[4] + down.ys[0]) / 2 : h - 1);
      return { ...readStaff(ink, light, w, st, Math.round(ya), Math.round(yb), bars), st };
    });
    return { staves, bars, u: sys[0].u };
  });
}

/* ---------- bars ---------- */

// When each event in a bar starts (sixteenths), from the order the events stand in across all the
// staves: events at one x start together, and the next ones start when the first note still sounding
// ends (so two voices on one staff, or a held chord under moving notes, keep their own times).
// Returns the bar's natural length (the last end).
export function timeBar(evs, u) {
  const cols = [];
  for (const e of [...evs].sort((a, b) => a.x - b.x)) {
    const c = cols[cols.length - 1];
    if (c && e.x - c.x < 0.7 * u) c.push(e); else cols.push(Object.assign([e], { x: e.x }));
  }
  let t = 0;
  const ends = [];
  for (const c of cols) {
    for (const e of c) { e.t = t; ends.push(t + e.len); }
    const next = ends.filter((v) => v > t + 1e-6);
    if (next.length) t = Math.min(...next);
  }
  return Math.max(0, ...ends);
}

// The MIDI note of a letter step with the key signature and the bar's accidentals so far.
function pitchOf(n, key, held) {
  const letter = ((n.d % 7) + 7) % 7;
  if (n.acc != null) held.set(n.d, n.acc);
  const keyAlter = key > 0 && SHARP_ORDER.slice(0, key).includes(letter) ? 1 : key < 0 && FLAT_ORDER.slice(0, -key).includes(letter) ? -1 : 0;
  return midiOf(n.d, held.has(n.d) ? held.get(n.d) : keyAlter);
}

/**
 * A page of notation as strips, one per system, in the shape ugToAlphaTex reads (see ugtab.js): each
 * bar has the staves' own events ({ t, len, notes: [{ p }] }, rests with no notes) in `staves`, and
 * `cols`, every moment a note starts in any staff (for the bar length vote and the key).
 * key: the part's key signature, for a staff that shows none (a system cut from its start).
 */
export function readScorePage(ink, light, w, h, key = null) {
  return readPage(ink, light, w, h).map(({ staves, bars: xs, u }) => {
    const top = staves[0].st;
    const bars = [];
    for (let i = 0; i + 1 < xs.length; i++) {
      const bar = { x0: xs[i], x1: xs[i + 1], cols: [], staves: staves.map(() => []) };
      bars.push(bar);
      const thick = thickRest(ink, w, top, xs[i], xs[i + 1]);
      if (thick) { // a multi-bar rest: a thick bar with the count over it
        const c = (thick.x0 + thick.x1) / 2;
        bar.rest = readRestCount(ink, w, top, c - 2.2 * u, c + 2.2 * u) || 1;
        continue;
      }
      const evs = [];
      staves.forEach((s, k) => {
        const held = new Map(); // accidentals last to the end of the bar
        const sig = s.key || key || 0;
        for (const e of s.events) {
          if (e.x <= xs[i] || e.x >= xs[i + 1] || (e.rest && e.whole)) continue; // a whole rest is the whole bar
          const ev = { x: e.x, len: e.len, staff: k, notes: e.notes.map((n) => ({ p: pitchOf(n, sig, held) })) };
          evs.push(ev);
          bar.staves[k].push(ev);
        }
      });
      bar.end = timeBar(evs, u);
      const starts = [...new Set(evs.map((e) => e.t))].sort((a, b) => a - b);
      bar.cols = starts.map((t, j) => ({
        cx: evs.find((e) => e.t === t).x,
        len: (j + 1 < starts.length ? starts[j + 1] : bar.end) - t,
        notes: evs.filter((e) => e.t === t).flatMap((e) => e.notes),
      }));
    }
    // the words above the top staff: section names and tempo marks
    let hd = { sections: [], tempos: [] };
    try { hd = readHeading(ink, w, top); } catch { /* no canvas (tests in Node) */ }
    const barAt = (x) => bars.reduce((k, b, j) => (b.x0 <= x + 0.5 * u ? j : k), 0);
    for (const sec of hd.sections) if (bars.length) Object.assign(bars[barAt((sec.x + sec.x1) / 2)], { heading: true, name: sec.name, numbered: sec.numbered });
    for (const t of hd.tempos) if (bars.length) bars[barAt(t.x)].tempo = t.v;
    return { score: true, clefs: staves.map((s) => s.clef), keys: staves.map((s) => s.key), den: staves[0].den, bars, lyr: [] };
  }).filter((s) => s.bars.length);
}
