// Reads the little bit of text above a Tab Pro staff: the section name ("Chorus", "Verse 2")
// and the tempo mark ("♩ = 72"). The words are matched against the usual section names drawn
// in a bold serif font, so only those names are recognised; anything else is left unnamed.

const WORDS = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Interlude', 'Break', 'Outro', 'Instrumental', 'Tag',
  'Turnaround', 'Solo', 'Refrain', 'Ending', 'Coda', 'Vamp', 'Hook', 'Riff', 'Lead', 'Fill', 'Jam', 'Tag', 'Post-Chorus', 'Channel'];
const FONT = 'bold 40px "Latin Modern Roman", "CMU Serif", Georgia, "Times New Roman", serif';
const GW = 48, GH = 14; // comparison grid
// The tempo digits in Tab Pro PDFs look slightly different from any system font, so a few seen ones are kept.
const DIGIT_SAMPLES = [['7', '900090000900009000090000900090000900009000090000900090000900009000090000900090000900009000000000900090000900009000090000900090000900009000000000900000000000000000000000000000000900009000000000900000000000000000000000000090000900000000000000000000000000000000000000000090000900000000000000000000000000000000000000900090000000000000000000000000000000000000090000900090000000000000000000000000000000000000090000900090000000000000000000000000000000009000090000900090000000000000000000000000000000009000090000900090000000000000000000000000000000009000090000900090000000000000000000000000000900009000090000900090000000000000000000000000000000009000090000900000000000000000000000'], ['2', '000000009000090009000900009000900090000900000000000090009000000000000000000000900090000900090000000090009000090000000000000000900090000900090000000090009000090009000000000000900090000900090000000090009000090009000000000000900090000900090000000000009000090000000000009000900090000900000000000000000000000000000000009000900090000900000000000000000000000000000900009000900000000000000000000000000000000009000900009000000000000000090000000000000000090009000000000000000000000900090000000000009000090009000000000000000000000900090000000090009000090009000900009000900090000900090000000090009000090009000900009000900090000900090000900090009000090009000900009000900090000900090000']];

function labelRegion(ink, w, x0, x1, y0, y1) {
  const seen = new Uint8Array(w * (y1 + 1));
  const comps = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      if (!ink[i] || seen[i]) continue;
      const px = [];
      const stack = [[x, y]];
      seen[i] = 1;
      let a = x, b = x, c = y, d = y;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        px.push([cx, cy]);
        a = Math.min(a, cx); b = Math.max(b, cx); c = Math.min(c, cy); d = Math.max(d, cy);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
            const j = ny * w + nx;
            if (ink[j] && !seen[j]) { seen[j] = 1; stack.push([nx, ny]); }
          }
        }
      }
      comps.push({ x0: a, x1: b + 1, y0: c, y1: d + 1, w: b - a + 1, h: d - c + 1, px });
    }
  }
  return comps;
}

// Ink inside a box, averaged down to a GW x GH grid.
function grid(pixels, bx, by, bw, bh) {
  const g = new Float32Array(GW * GH);
  const n = new Float32Array(GW * GH);
  for (const [x, y] of pixels) {
    const gx = Math.min(GW - 1, Math.floor(((x - bx) / bw) * GW));
    const gy = Math.min(GH - 1, Math.floor(((y - by) / bh) * GH));
    g[gy * GW + gx]++;
  }
  const cellArea = (bw / GW) * (bh / GH);
  for (let i = 0; i < g.length; i++) g[i] = Math.min(1, g[i] / Math.max(1, cellArea));
  return g;
}

const cache = new Map();
function rendered(text) {
  if (cache.has(text)) return cache.get(text);
  const c = document.createElement('canvas');
  c.width = 40 * text.length + 40; c.height = 80;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000'; ctx.font = FONT; ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 10, 50);
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  const px = [];
  let a = width, b = 0, t = height, d = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4] < 140) { px.push([x, y]); a = Math.min(a, x); b = Math.max(b, x); t = Math.min(t, y); d = Math.max(d, y); }
    }
  }
  const out = px.length ? grid(px, a, t, b - a + 1, d - t + 1) : null;
  cache.set(text, out);
  return out;
}

const dist = (p, q) => {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += Math.abs(p[i] - q[i]);
  return s / p.length;
};

function best(g, options) {
  let top = [Infinity, null];
  for (const o of options) {
    const r = rendered(o);
    if (!r) continue;
    const d = dist(g, r);
    if (d < top[0]) top = [d, o];
  }
  return top;
}

const group = (items, key, gap) => {
  const out = [];
  for (const it of [...items].sort((a, b) => key(a) - key(b))) {
    const last = out[out.length - 1];
    if (last && key(it) - last.end <= gap) { last.items.push(it); last.end = Math.max(last.end, key === ((c) => c.x0) ? it.x1 : it.y1); }
    else out.push({ items: [it], end: key === ((c) => c.x0) ? it.x1 : it.y1 });
  }
  return out;
};

/**
 * @returns {{ sections: {name: string, x: number, numbered: boolean}[], tempos: {v: number, x: number}[] }}
 */
export function readHeading(ink, w, st, { debug = null } = {}) {
  const u = st.u;
  const y0 = Math.max(0, Math.round(st.ys[0] - 3.6 * u)), y1 = Math.round(st.ys[0] - 0.9 * u);
  const comps = labelRegion(ink, w, st.x0, st.x1, y0, y1).filter((c) => {
    const cy = (c.y0 + c.y1) / 2;
    return cy >= y0 && cy <= y1 && c.w <= 1.4 * u && c.h <= 1.1 * u && c.px.length >= 6;
  });
  const lines = [];
  for (const c of comps.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))) {
    const cy = (c.y0 + c.y1) / 2;
    const line = lines.find((l) => Math.abs(l.cy - cy) < 0.45 * u);
    if (line) { line.items.push(c); line.cy = (line.cy * (line.items.length - 1) + cy) / line.items.length; }
    else lines.push({ cy, items: [c] });
  }
  const sections = [], tempos = [];
  for (const line of lines) {
    const items = line.items.sort((a, b) => a.x0 - b.x0);
    if (debug && lines.length) debug.push({ line: items.map((c) => [c.x0, c.w, c.h]) });
    const words = [];
    for (const c of items) {
      const last = words[words.length - 1];
      if (last && c.x0 - last.x1 <= 0.4 * u) { last.items.push(c); last.x1 = Math.max(last.x1, c.x1); }
      else words.push({ items: [c], x1: c.x1 });
    }
    const boxes = words.map((wd) => {
      const px = wd.items.flatMap((c) => c.px);
      const a = Math.min(...wd.items.map((c) => c.x0)), b = Math.max(...wd.items.map((c) => c.x1));
      const t = Math.min(...wd.items.map((c) => c.y0)), d = Math.max(...wd.items.map((c) => c.y1));
      return { px, a, b, t, d, w: b - a, h: d - t, n: wd.items.length };
    });
    // tempo mark: a note, "=", then digits
    const eq = items.findIndex((c, i) => c.w > 0.3 * u && c.h < 0.2 * u && items[i + 1] && items[i + 1].h < 0.2 * u);
    if (eq >= 0) {
      const digits = items.slice(eq + 2).sort((a, b) => a.x0 - b.x0);
      let txt = '';
      for (const c of digits) {
        const gr = grid(c.px, c.x0, c.y0, c.w, c.h);
        let [d, ch] = best(gr, '0123456789'.split(''));
        for (const [sc, sg] of DIGIT_SAMPLES) {
          const dd = dist(gr, Float32Array.from(sg, (v) => +v / 9));
          if (dd < d) { d = dd; ch = sc; }
        }
        if (debug) debug.push({ digit: ch, d });
        txt += ch;
      }
      const v = Number(txt);
      if (txt && v >= 30 && v <= 300) tempos.push({ v, x: items[eq].x0 });
      continue;
    }
    // section name: first recognised word, plus a number after it
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.h < 0.45 * u) continue;
      const [d, wd] = best(grid(bx.px, bx.a, bx.t, bx.w, bx.h), WORDS);
      if (debug) debug.push({ word: wd, d, w: bx.w });
      if (d < 0.225) {
        const next = boxes[i + 1];
        // "Verse 1": the number is counted by the caller
        sections.push({ name: wd, x: bx.a, numbered: !!(next && next.n === 1 && next.w < 0.9 * u && next.h > 0.55 * u) });
      }
    }
  }
  return { sections, tempos };
}
