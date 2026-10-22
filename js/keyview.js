// Live keyboard: like the fretboard pane, but for keys, synths, vocals and every other pitched
// part. The notes of the beat under the cursor are filled in, the next beat's are outlined.
const NS = 'http://www.w3.org/2000/svg';
const BLACK = [1, 3, 6, 8, 10]; // pitch classes of the black keys

let host = null;
let geometry = null; // { lo, hi, key(m) -> { x, w, black } }
let layer = null;
let nameOf = (m) => String(m);

const el = (name, attrs) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const isBlack = (m) => BLACK.includes(((m % 12) + 12) % 12);

export function initKeyView(element) {
  host = element;
}

/**
 * The keyboard range for a part: whole octaves from C to B around its notes, at least two.
 * @param pitches MIDI note numbers the part plays
 */
export function keyRange(pitches) {
  if (!pitches.length) return { lo: 48, hi: 83 };
  let lo = Math.floor(Math.min(...pitches) / 12) * 12;
  let hi = Math.floor(Math.max(...pitches) / 12) * 12 + 11;
  while (hi - lo + 1 < 24) { if (lo >= 48) lo -= 12; else hi += 12; }
  if (hi - lo + 1 > 88) { lo = Math.max(lo, 21); hi = Math.min(hi, 108); }
  return { lo, hi };
}

/** Draws the keys from lo to hi (MIDI); names(m) gives a note's name ("C4"). null clears it. */
export function setKeys(range, names) {
  if (!host) return;
  host.textContent = '';
  geometry = null;
  if (!range) return;
  if (names) nameOf = names;
  const { lo, hi } = range;
  const whites = [];
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
  const w = 1000, h = 130, left = 6, top = 4;
  const ww = (w - 2 * left) / whites.length;
  const bw = ww * 0.6, bh = (h - top) * 0.6;
  const keys = new Map();
  whites.forEach((m, i) => keys.set(m, { x: left + i * ww, w: ww, black: false }));
  for (let m = lo; m <= hi; m++) {
    if (!isBlack(m)) continue;
    const below = keys.get(m - 1);
    if (below) keys.set(m, { x: below.x + ww - bw / 2, w: bw, black: true });
  }
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, class: 'kv-keys', role: 'img', 'aria-label': 'Keyboard' });
  for (const [m, k] of keys) {
    if (k.black) continue;
    svg.append(el('rect', { x: k.x + 0.5, y: top, width: k.w - 1, height: h - top - 2, rx: 3, class: 'kv-white' }));
    if (m % 12 === 0) { // label every C so you can find your place
      const t = el('text', { x: k.x + k.w / 2, y: h - 9, class: 'kv-c' });
      t.textContent = nameOf(m);
      svg.append(t);
    }
  }
  for (const [, k] of keys) if (k.black) svg.append(el('rect', { x: k.x, y: top, width: k.w, height: bh, rx: 2, class: 'kv-black' }));
  layer = el('g', {});
  svg.append(layer);
  host.append(svg);
  geometry = { lo, hi, keys, top, h, bh };
}

/** now / next: MIDI note numbers. */
export function showKeys(now = [], next = []) {
  if (!geometry || !layer) return;
  const { keys, top, h, bh } = geometry;
  layer.textContent = '';
  const mark = (m, cls) => {
    const k = keys.get(m);
    if (!k) return;
    const g = el('g', { class: cls + (k.black ? ' kv-on-black' : '') });
    const height = k.black ? bh : h - top - 2;
    g.append(el('rect', { x: k.x + (k.black ? 0 : 0.5), y: top, width: k.black ? k.w : k.w - 1, height, rx: 3 }));
    const t = el('text', { x: k.x + k.w / 2, y: top + height - 10 });
    t.textContent = nameOf(m).replace(/-?\d+$/, '');
    g.append(t);
    layer.append(g);
  };
  const nowSet = new Set(now);
  for (const m of new Set(next)) if (!nowSet.has(m)) mark(m, 'kv-next');
  for (const m of nowSet) mark(m, 'kv-now');
}
