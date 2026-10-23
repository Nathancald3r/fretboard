// Reads the little bit of text above a Tab Pro staff: the section name ("Chorus", "Verse 2")
// and the tempo mark ("♩ = 72"). The words are matched against the usual section names drawn
// in a bold serif font, so only those names are recognised; anything else is left unnamed.

const WORDS = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Interlude', 'Break', 'Outro', 'Instrumental', 'Tag',
  'Turnaround', 'Solo', 'Refrain', 'Ending', 'Coda', 'Vamp', 'Hook', 'Riff', 'Lead', 'Fill', 'Jam', 'Tag', 'Post-Chorus', 'Channel'];
// each name without its first letter or two (cut at the picture's left edge) -> the name
const CUT = new Map(WORDS.flatMap((wd) => [1, 2].map((k) => [wd.slice(k), wd]).filter(([s]) => s.length >= 4 && /^[a-z]/.test(s))));
const FONT ='bold 40px "Latin Modern Roman", "CMU Serif", Georgia, "Times New Roman", serif';
const GW = 48, GH = 14; // comparison grid

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

// The bold digits UG prints over a multi-bar rest, as 10x14 ink grids of their bounding box (0-9 per
// cell) plus width/height. 1 2 3 4 6 7 8 are averaged from real Tab Pro printouts; the others are drawn
// from a similar font (Century Schoolbook Bold), so they match less closely.
const REST_DIGITS = [
  ['0', 0.682, '00595575000990005950599000599059500009909950000999995000099999500009999950000999995000099959500009905950002990099000595000950079200009995000', false],
  ['1', 0.663, '00299980000189999000039999900029999990007828999000961899900020189990000018999000001899900000189990000018999000001999900036699997653999999997', true],
  ['2', 0.724, '02789986102970059981699702999689991299976998049995087108998000007998300058852015059400005939963100866889976891850899997095018999306400288300', true],
  ['3', 0.717, '05999995106950179980999002999599920199955980059992009999995003999998000000079980292002999989910199999992019997797005999029655999500299999000', true],
  ['4', 0.864, '00499981000069998000008999300000999700000299828500059928950008954995004970699500792079950099999999981444799742000069950000468998650079999999', true],
  ['5', 0.636, '00955555900099999700009999900009000000000900000000097557950059000099902500000995252000099999900009999990000999995000099029200297000099990000', false],
  ['6', 0.783, '00289996100399515970089600899339940089936993005960899558860089998899509997007995899500699869940039993995005995069800897002797697200007986000', true],
  ['7', 0.717, '52699200689999994087999999999597579999949200144980900000595000000189300000059800000009970000006993000005999100001999900000599993000079779100', true],
  ['8', 0.750, '00259952000797557920299000079059900005995997500790099999797005999999500997999990592002799999000009995900000599297000299505999999200009999000', true],
  ['9', 0.682, '00795575002970002970995000099099500009959950000999997000299959900099990579992999000000099509900009905999005970599900595029900595000059990000', false],
].map(([ch, ar, s, real]) => ({ ch, ar, real, g: Float32Array.from(s, (v) => +v / 9) }));
const DGX = 10, DGY = 14;

function restDigit(c) {
  const g = new Float32Array(DGX * DGY), n = new Float32Array(DGX * DGY);
  const on = new Set(c.px.map(([x, y]) => (y - c.y0) * c.w + (x - c.x0)));
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const k = Math.min(DGY - 1, Math.floor((y / c.h) * DGY)) * DGX + Math.min(DGX - 1, Math.floor((x / c.w) * DGX));
      n[k]++;
      if (on.has(y * c.w + x)) g[k]++;
    }
  }
  for (let i = 0; i < g.length; i++) g[i] = n[i] ? g[i] / n[i] : 0;
  let top = [Infinity, null, false];
  for (const t of REST_DIGITS) {
    let d = 0;
    for (let i = 0; i < g.length; i++) d += Math.abs(g[i] - t.g[i]);
    d = d / g.length + 0.5 * Math.abs(c.w / c.h - t.ar);
    if (d < top[0]) top = [d, t.ch, t.real];
  }
  return [...top, g];
}

/**
 * The bold number over a multi-bar rest ("16" = sixteen bars of rest), read from the ink above the
 * staff over x0..x1. Returns 0 when there is none.
 */
export function readRestCount(ink, w, st, x0, x1, { debug = null } = {}) {
  const u = st.u;
  const y0 = Math.max(0, Math.round(st.ys[0] - 2.8 * u)), y1 = Math.round(st.ys[0] - 0.15 * u);
  const comps = labelRegion(ink, w, Math.max(st.x0, Math.round(x0)), Math.min(st.x1, Math.round(x1)), y0, y1)
    .filter((c) => c.h >= 0.9 * u && c.h <= 2 * u && c.w <= 1.6 * u && c.px.length >= 10 && c.y1 >= st.ys[0] - 1.2 * u)
    .sort((a, b) => a.x0 - b.x0);
  if (!comps.length || comps.length > 3) return 0;
  let txt = '';
  for (const c of comps) {
    const [d, ch, real, g] = restDigit(c);
    if (debug) debug.push({ ch, d, w: c.w, h: c.h, g: Array.from(g, (v) => Math.min(9, Math.round(v * 9))).join('') });
    if (d > (real ? 0.25 : 0.4)) return 0; // not a digit after all
    txt += ch;
  }
  const n = Number(txt);
  return n >= 2 && n <= 400 ? n : 0;
}

/**
 * @returns {{ sections:{name: string, x: number, x1: number, numbered: boolean}[], tempos: {v: number, x: number}[] }}
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
      // read like a multi-bar rest's count (UG's own digit shapes; matching a system font read
      // How He Loves' 75 as 26 and When I Go Down's 68 as 66)
      let last = null;
      for (const c of digits) {
        const [d, ch] = restDigit(c);
        if (debug) debug.push({ digit: ch, d });
        if (d > 0.6) continue; // not a digit
        if (last && c.x0 - last.x1 > 0.3 * u) break; // the number ends at a gap (a multi-bar rest's count can sit just after it)
        txt += ch;
        last = c;
      }
      const v = Number(txt);
      if (txt && v >= 30 && v <= 300) tempos.push({ v, x: items[eq].x0 });
      continue;
    }
    // a line of many words may be the previous line's lyrics (in tab view they sit just above this
    // staff): there a name must match closely ("loves" read as "Vamp" at 0.22)
    const near = boxes.length > 4 ? 0.19 : 0.225;
    // section name: first recognised word, plus a number after it
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.h < 0.45 * u) continue;
      // a name centred on a line's first bar line runs off UG's picture: its first letter is cut ("horus")
      const cut = bx.a <= st.x0 + 0.3 * u;
      let [d, wd] = best(grid(bx.px, bx.a, bx.t, bx.w, bx.h), cut ? [...WORDS, ...CUT.keys()] : WORDS);
      const part = CUT.has(wd);
      if (part) wd = CUT.get(wd);
      if (debug) debug.push({ word: wd, d, w: bx.w });
      if (d < (part ? near + 0.025 : near)) { // a cut name matches less closely ("horus": 0.228)
        const next = boxes[i + 1];
        // "Verse 1": the number is counted by the caller
        sections.push({ name: wd, x: bx.a, x1: bx.b, numbered: !!(next && next.n === 1 && next.w < 0.9 * u && next.h > 0.55 * u) });
      }
    }
  }
  return { sections, tempos };
}
