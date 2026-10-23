// Reads Ultimate Guitar drum and percussion parts from a rendered page: a five-line drum staff, or the
// one-line staff a shaker or tambourine gets. Each notehead's line and shape says which drum it is
// (standard drum notation, as Guitar Pro writes it); the stems, beams and flags give the rhythm.
// The bars come out in the same form as ugtab.js reads tab, so ugToAlphaTex lines them up with the
// other parts. Image sizes are normalised to a staff spacing of UG_UNIT pixels by the caller.
import { stemLength } from './ugtab.js';
import { readHeading } from './ugtext.js';

/* ---------- staves ---------- */

// Thin long horizontal lines (beams are thick, so they're left out). Five evenly spaced ones are a drum
// staff; a line on its own is a one-line percussion staff.
export function findDrumStaves(light, w, h, oneLine = false) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let n = 0, run = 0, longest = 0; // (a song's last line can be short)
    for (let x = 0; x < w; x++) { n += light[y * w + x]; run = light[y * w + x] ? run + 1 : 0; if (run > longest) longest = run; }
    if (n > 0.18 * w && longest > 0.12 * w) {
      const r = rows[rows.length - 1];
      if (r && y - r.last <= 1) { r.last = y; r.sum += y; r.n++; } else rows.push({ first: y, last: y, sum: y, n: 1 });
    }
  }
  const ys = rows.filter((r) => r.n <= 3).map((r) => r.sum / r.n);
  const edges = (y) => {
    y = Math.round(y);
    let x0 = 0, x1 = w - 1;
    while (x0 < w && !light[y * w + x0]) x0++;
    while (x1 > 0 && !light[y * w + x1]) x1--;
    return [x0, x1];
  };
  const out = [];
  if (!oneLine) {
    for (let i = 0; i + 4 < ys.length; i++) {
      const gap = ys[i + 1] - ys[i];
      if (gap < 8 || gap > 40) continue;
      let ok = true;
      for (let k = 1; k < 4; k++) if (Math.abs(ys[i + k + 1] - ys[i + k] - gap) > 2) ok = false;
      if (!ok) continue;
      const [x0, x1] = edges(ys[i]);
      out.push({ ys: ys.slice(i, i + 5), x0, x1, u: (ys[i + 4] - ys[i]) / 4 });
      i += 4;
    }
    return out;
  }
  for (const y of ys) {
    const [x0, x1] = edges(y);
    if (x1 - x0 <= 0.15 * w) continue;
    // the bar line at the start of the line is as tall as a five-line staff: four spaces
    let run = 0;
    for (let x = Math.max(0, x0 - 3); x <= x0 + 3; x++) {
      let a = Math.round(y), b = a;
      while (a > 0 && light[(a - 1) * w + x]) a--;
      while (b < h - 1 && light[(b + 1) * w + x]) b++;
      run = Math.max(run, b - a + 1);
    }
    if (run >= 24) out.push({ ys: [y], x0, x1, u: run / 4, one: true });
  }
  return out;
}

/* ---------- bars ---------- */

// Upright lines that run the whole staff and stop at its edges (a stem runs on past the staff to its beam).
function drumBarLines(ink, light, w, st) {
  const u = st.u;
  const top = st.one ? st.ys[0] - 1.9 * u : st.ys[0], bot = st.one ? st.ys[0] + 1.9 * u : st.ys[st.ys.length - 1];
  const t = Math.round(top), b = Math.round(bot);
  const xs = [];
  for (let x = st.x0; x <= st.x1; x++) {
    let n = 0;
    for (let y = t; y <= b; y++) n += light[y * w + x];
    if (n < 0.97 * (b - t + 1)) continue;
    let above = 0, below = 0;
    for (let y = t - 2; y > t - 0.9 * u && light[y * w + x]; y--) above++;
    for (let y = b + 2; y < b + 0.9 * u && light[y * w + x]; y++) below++;
    if (above < 0.3 * u && below < 0.3 * u) xs.push(x);
  }
  const groups = [];
  for (const x of xs) {
    const g = groups[groups.length - 1];
    if (g && x - g[g.length - 1] <= 2) g.push(x); else groups.push([x]);
  }
  const out = [];
  for (const g of groups.filter((q) => q.length <= 0.5 * u)) {
    const x = g.reduce((a, c) => a + c, 0) / g.length;
    if (out.length && x - out[out.length - 1] < 4.5 * u) continue; // the clef or time signature isn't a bar
    out.push(x);
  }
  if (out.length && st.x1 - out[out.length - 1] > 4 * u) out.push(st.x1);
  return out;
}

/* ---------- noteheads ---------- */

// Ink with the stems, bar lines and beams taken away, so the noteheads and rests stand on their own.
function heads(ink, w, h, st) {
  const u = st.u;
  const y0 = Math.max(0, Math.round(st.ys[0] - 3.2 * u)), y1 = Math.min(h - 1, Math.round(st.ys[st.ys.length - 1] + 2.2 * u));
  const x0 = st.x0, x1 = st.x1, W = x1 - x0 + 1, H = y1 - y0 + 1;
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = ink[(y + y0) * w + x + x0];
  const at = (x, y) => (x >= 0 && x < W && y >= 0 && y < H ? m[y * W + x] : 0);
  const cut = new Uint8Array(W * H);
  // thin upright strokes at least 1.5 spaces long
  for (let x = 0; x < W; x++) {
    let s = -1;
    for (let y = 0; y <= H; y++) {
      if (y < H && at(x, y)) { if (s < 0) s = y; continue; }
      if (s >= 0 && y - s >= 1.5 * u) {
        for (let k = s; k < y; k++) {
          let l = 0, r = 0;
          while (at(x - l - 1, k)) l++;
          while (at(x + r + 1, k)) r++;
          if (l + r + 1 <= 4) cut[k * W + x] = 1;
        }
      }
      s = -1;
    }
  }
  // thick-ish horizontal strokes longer than a notehead (beams)
  for (let y = 0; y < H; y++) {
    let s = -1;
    for (let x = 0; x <= W; x++) {
      if (x < W && at(x, y)) { if (s < 0) s = x; continue; }
      if (s >= 0 && x - s >= 2.6 * u) {
        for (let k = s; k < x; k++) {
          let a = 0, b = 0;
          while (at(k, y - a - 1)) a++;
          while (at(k, y + b + 1)) b++;
          if (a + b + 1 <= 0.6 * u) cut[y * W + k] = 1;
        }
      }
      s = -1;
    }
  }
  // staff and ledger lines: a thin line with nothing just above or below it (a notehead crossing one keeps its strokes)
  const lineYs = [...st.ys];
  for (let k = 1; k <= 3; k++) lineYs.push(st.ys[0] - k * u, st.ys[st.ys.length - 1] + k * u);
  for (const ly of lineYs) {
    for (let y = Math.round(ly) - 1 - y0; y <= Math.round(ly) + 1 - y0; y++) {
      for (let x = 0; x < W; x++) if (at(x, y) && !at(x, y - 2) && !at(x, y + 2)) cut[y * W + x] = 1;
    }
  }
  for (let i = 0; i < m.length; i++) if (cut[i]) m[i] = 0;
  // pieces of ink
  const seen = new Uint8Array(W * H);
  const comps = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!m[y * W + x] || seen[y * W + x]) continue;
      const stack = [[x, y]];
      seen[y * W + x] = 1;
      let a = x, b = x, c = y, d = y, area = 0;
      const px = [];
      while (stack.length) {
        const [cx, cy] = stack.pop();
        area++; px.push(cx, cy);
        a = Math.min(a, cx); b = Math.max(b, cx); c = Math.min(c, cy); d = Math.max(d, cy);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const j = ny * W + nx;
          if (m[j] && !seen[j]) { seen[j] = 1; stack.push([nx, ny]); }
        }
      }
      comps.push({ x0: a + x0, x1: b + x0 + 1, y0: c + y0, y1: d + y0 + 1, w: b - a + 1, h: d - c + 1, area, px, ox: x0, oy: y0, W, m });
    }
  }
  // a cross head sitting on a staff line can be cut in two by the line removal: join the halves and put the line back
  for (let i = 0; i < comps.length; i++) {
    for (let j = 0; j < comps.length; j++) {
      const p = comps[i], q = comps[j];
      if (i === j || !p || !q || q.y0 < p.y1 || q.y0 - p.y1 > 3) continue;
      const over = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
      if (over < 0.7 * Math.max(p.w, q.w) || p.h > 0.8 * u || q.h > 0.8 * u || Math.max(p.y1, q.y1) - p.y0 > 1.4 * u) continue;
      const a = Math.min(p.x0, q.x0), b = Math.max(p.x1, q.x1);
      for (let y = p.y1 - y0; y < q.y0 - y0; y++) for (let x = a - x0; x < b - x0; x++) {
        const k = y * W + x;
        if (!m[k] && ink[(y + y0) * w + x + x0]) { m[k] = 1; p.px.push(x, y); p.area++; }
      }
      p.px.push(...q.px); p.area += q.area;
      p.x0 = a; p.x1 = b; p.y1 = Math.max(p.y1, q.y1); p.w = b - a; p.h = p.y1 - p.y0;
      comps[j] = null;
    }
  }
  // a ledger line sticks out either side of a head on it: trim its thin ends off
  for (const c of comps) {
    if (!c || c.w <= 1.4 * u || c.h > 1.4 * u) continue;
    const col = (x) => { let n = 0; for (let i = 0; i < c.px.length; i += 2) if (c.px[i] === x) n++; return n; };
    let a = c.x0 - x0, b = c.x1 - x0 - 1;
    while (b - a > 0.6 * u && col(a) <= 3) a++;
    while (b - a > 0.6 * u && col(b) <= 3) b--;
    c.x0 = a + x0; c.x1 = b + x0 + 1; c.w = b - a + 1;
  }
  return comps.filter(Boolean);
}

// Filled oval, cross, or circled cross.
function shapeOf(c) {
  const fill = c.area / (c.w * c.h);
  const has = (fx, fy, r = 1) => {
    const x = Math.round(c.x0 + fx * (c.w - 1)) - c.ox, y = Math.round(c.y0 + fy * (c.h - 1)) - c.oy;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (c.m[(y + dy) * c.W + x + dx]) return true;
    return false;
  };
  if (fill >= 0.55 && has(0.5, 0.5)) return 'fill';
  // a circled cross has its ring at the middle of the top and bottom edges, where a plain cross has nothing
  if (has(0.5, 0.08, 2) && has(0.5, 0.92, 2)) return 'circle';
  if (has(0.5, 0.5) && has(0.1, 0.1, 2) && has(0.9, 0.9, 2)) return 'x';
  return null;
}

// Half-spaces up from the bottom line (Guitar Pro's drum map: kick in the bottom space, snare in the
// third, hi-hat just above the staff, crash on the first ledger line above).
const DRUMS = {
  fill: { '-2': 'kick', '-1': 'kick', 0: 'kick', 1: 'kick', 2: 'lowfloortom', 3: 'floortom', 4: 'lowtom', 5: 'snare', 6: 'midtom', 7: 'hightom', 8: 'hightom', 9: 'snare' },
  x: { '-3': 'pedalhat', '-2': 'pedalhat', '-1': 'pedalhat', 5: 'sidestick', 6: 'ride', 7: 'ride', 8: 'ride', 9: 'hihat', 10: 'crash', 11: 'crash2', 12: 'crash2' },
  circle: { 8: 'ridebell', 9: 'openhat', 10: 'crash', 11: 'crash2' },
};
export const DRUM_IDS = {
  kick: 36, lowfloortom: 41, floortom: 43, lowtom: 45, snare: 38, midtom: 47, hightom: 48, pedalhat: 44, sidestick: 37,
  ride: 51, ridebell: 53, hihat: 42, openhat: 46, crash: 49, crash2: 57, shaker: 82, tambourine: 54,
};

/* ---------- strip ---------- */

export function readDrumStrip(ink, light, w, h, st, flipped, { piece = 'shaker' } = {}) {
  const u = st.u;
  const bl = drumBarLines(ink, light, w, st);
  if (bl.length < 2) return null;
  const top = st.ys[0], bot = st.ys[st.ys.length - 1];
  const comps = heads(ink, w, h, st);
  // the stem by a notehead: the longest thin upright run that touches it
  const stemOf = (c) => {
    let best = null;
    for (let x = c.x0 - 2; x <= c.x1 + 1; x++) {
      const yc = Math.round((c.y0 + c.y1) / 2);
      let a = yc, b = yc;
      // from inside the head, follow the column up and down
      for (let y = c.y0; y < c.y1; y++) if (ink[y * w + x]) { a = Math.min(a, y); b = Math.max(b, y); }
      if (!ink[a * w + x]) continue;
      while (a > 0 && ink[(a - 1) * w + x]) a--;
      while (b < h - 1 && ink[(b + 1) * w + x]) b++;
      if (b - a + 1 >= 2 * u && (!best || b - a > best.b - best.a)) best = { x, a, b };
    }
    return best;
  };
  const notes = [];
  for (const c of comps) {
    if (c.w < 0.65 * u || c.w > 1.7 * u || c.h < 0.6 * u || c.h > 1.4 * u) continue;
    const cy = (c.y0 + c.y1) / 2;
    if (bl.some((x) => c.x0 < x && c.x1 > x)) continue;
    const s = stemOf(c);
    let kind;
    if (st.one) { if (!s) continue; kind = piece; }
    else {
      const shape = shapeOf(c);
      if (!shape) continue;
      const pos = Math.round((bot - cy) / (u / 2));
      if (!s && !(shape === 'circle' && pos >= -2 && pos <= 2 && c.w > 1.1 * u)) continue; // stemless: only a whole note on the kick
      kind = s ? DRUMS[shape][pos] : 'kick';
      if (!kind) kind = shape === 'fill' ? (pos < 3 ? 'kick' : 'snare') : pos <= 0 ? 'pedalhat' : pos >= 10 ? 'crash' : 'hihat';
    }
    notes.push({ cx: (c.x0 + c.x1) / 2, cy, stem: s, drum: kind, used: c });
  }
  // a grace note (a small head before a beat) takes no time: leave it out of the rhythm
  const mid = (v) => v.sort((p, q) => p - q)[v.length >> 1] || 0;
  const mw = mid(notes.map((n) => n.used.w)), mh = mid(notes.map((n) => n.used.h));
  for (const n of notes) n.grace = (n.used.w < 0.8 * mw && n.used.h < 0.8 * mh) || n.used.w < 0.6 * mw; // (or its slash)
  // rests: pieces in the staff with no stem, tall and narrow (quarter, eighth, sixteenth) or a flat block (half)
  const rests = [];
  for (const c of comps) {
    if (notes.some((n) => n.used === c)) continue;
    if (notes.some((n) => n.grace && n.stem && c.x0 <= n.stem.x + 0.6 * u && c.x1 >= n.stem.x - 0.6 * u)) continue; // a grace note's slash isn't a rest
    const cy = (c.y0 + c.y1) / 2;
    if (cy < top - 0.5 * u || cy > bot + 0.5 * u || (st.one && Math.abs(cy - top) > 1.6 * u)) continue;
    if (bl.some((x) => Math.abs(x - (c.x0 + c.x1) / 2) < 0.6 * u) || c.x0 < st.x0 + 3 * u) continue; // (the clef at the start of a line isn't a rest)
    let len = 0;
    if (c.h >= 2.3 * u && c.h <= 3.4 * u && c.w >= 0.6 * u && c.w <= 1.2 * u) len = 4;
    else if (c.h >= 1.4 * u && c.h <= 2.2 * u && c.w >= 0.6 * u && c.w <= 1.2 * u) len = 2;
    else if (c.h >= 2.3 * u && c.h <= 3.4 * u && c.w > 1.2 * u && c.w <= 1.7 * u) len = 1;
    else if (c.h >= 0.35 * u && c.h <= 0.7 * u && c.w >= 0.9 * u && c.w <= 1.6 * u && c.area > 0.8 * c.w * c.h) len = Math.abs(cy - (st.one ? top : st.ys[2]) + 0.25 * u) < 0.5 * u ? 8 : 16;
    if (!len) continue;
    const isDot = (d) => d !== c && d.w <= 0.45 * u && d.h <= 0.45 * u && d.area >= 6;
    const dot = comps.find((d) => isDot(d) && d.x0 >= c.x1 && d.x0 - c.x1 <= 0.9 * u && d.y0 >= c.y0 - 0.5 * u && d.y1 <= c.y1 + 0.5 * u);
    // a second dot just after the first: double dotted (one and three quarters)
    const two = dot && comps.some((d) => d !== dot && isDot(d) && d.x0 >= dot.x1 && d.x0 - dot.x1 <= 0.6 * u && Math.abs(d.y0 + d.y1 - dot.y0 - dot.y1) <= 0.5 * u);
    rests.push({ cx: (c.x0 + c.x1) / 2, len: two ? len * 1.75 : dot ? len * 1.5 : len, rest: true, notes: [] });
  }
  const bars = [];
  for (let i = 0; i + 1 < bl.length; i++) {
    const cols = [];
    for (const n of notes.filter((q) => !q.grace && q.cx > bl[i] && q.cx < bl[i + 1])) {
      const c = cols.find((k) => Math.abs(k.sx - (n.stem?.x ?? n.cx)) <= 3);
      if (c) { if (!c.notes.some((q) => q.drum === n.drum)) c.notes.push({ drum: n.drum }); c.cx = Math.min(c.cx, n.cx); c.ys.push(n.cy); c.heads.push(n.used); }
      else cols.push({ cx: n.cx, sx: n.stem?.x ?? n.cx, stem: n.stem, ys: [n.cy], heads: [n.used], notes: [{ drum: n.drum }] });
    }
    for (const c of cols) {
      if (!c.stem) { c.len = 16; c.beamed = false; continue; } // a whole note (or a cymbal left to ring)
      // the beams sit at the far end of the stem; ugtab reads them below the staff, so an up stem is read upside down
      const { x, a, b } = c.stem;
      // only the part of the stem past its noteheads (a chord's heads would look like flags or dots)
      const ys = c.ys;
      const hiY = Math.min(...ys) - 0.6 * u, loY = Math.max(...ys) + 0.6 * u;
      const lines = [...st.ys, top - u, top - 2 * u, bot + u, bot + 2 * u]; // a stem ending by a staff line mustn't read it as a beam
      const r = hiY - a >= b - loY
        ? stemLength(flipped, w, { x, top: h - 1 - Math.round(hiY), bot: h - 1 - a, lines: lines.map((l) => h - 1 - l) }, u)
        : stemLength(ink, w, { x, top: Math.round(loY), bot: b, lines }, u);
      // in standard notation the dot sits just right of a notehead (not by the stem, as in tab)
      const plain = Number.isInteger(Math.log2(r.len)) ? r.len : r.len / 1.5;
      const dotted = c.heads.some((hd) => comps.some((d) => d.w <= 0.45 * u && d.h <= 0.45 * u && d.area >= 6 && d.x0 > hd.x1 && d.x0 - hd.x1 <= 0.9 * u
        && (d.y0 + d.y1) / 2 >= hd.y0 - 0.2 * u && (d.y0 + d.y1) / 2 <= hd.y1 + 0.2 * u));
      c.len = dotted ? plain * 1.5 : plain; c.beamed = r.beamed;
    }
    // two voices struck together (a cymbal stem up, the kick's stem down) are one beat; the shorter note sets the next
    cols.sort((p, q) => p.cx - q.cx);
    for (let k = cols.length - 1; k > 0; k--) {
      const p = cols[k - 1], q = cols[k];
      if (q.cx - p.cx > 0.5 * u) continue;
      for (const nt of q.notes) if (!p.notes.some((o) => o.drum === nt.drum)) p.notes.push(nt);
      p.len = Math.min(p.len, q.len);
      cols.splice(k, 1);
    }
    for (const r of rests) if (r.cx > bl[i] && r.cx < bl[i + 1] && !cols.some((c) => Math.abs(c.cx - r.cx) < 0.6 * u)) cols.push({ ...r });
    cols.sort((a, b) => a.cx - b.cx);
    bars.push({ x0: bl[i], x1: bl[i + 1], cols: cols.some((c) => !c.rest) ? cols : [] });
  }
  let hd = { sections: [], tempos: [] };
  try { hd = readHeading(ink, w, { ...st, ys: st.one ? [top - 2 * u, top - u, top, top + u] : st.ys }); } catch { /* no section names: the other parts have them */ }
  const barAt = (x, x1 = x) => {
    const mid = (x + x1) / 2;
    let k = 0;
    bars.forEach((b, i) => { if (b.x0 <= mid) k = i; });
    bars.forEach((b, i) => { if (Math.abs(b.x0 - mid) < Math.abs(bars[k].x0 - mid) && Math.abs(b.x0 - mid) <= (x1 - x) / 2 + 0.5 * u) k = i; });
    return bars[k];
  };
  for (const sec of hd.sections) Object.assign(barAt(sec.x, sec.x1), { heading: true, name: sec.name, numbered: sec.numbered });
  for (const t of hd.tempos) barAt(t.x).tempo = t.v;
  return { bars, drums: true, strings: 0 };
}

// The page upside down, so an up stem's beams can be read the way ugtab.js reads a down stem's.
export function flip(ink, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(ink.subarray(y * w, (y + 1) * w), (h - 1 - y) * w);
  return out;
}
