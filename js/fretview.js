// Live fretboard: the notes of the beat under the cursor (filled) and the next beat
// (outlined) on a guitar or bass neck, drawn as SVG under the score.
const NS = 'http://www.w3.org/2000/svg';
const INLAYS = [3, 5, 7, 9, 15, 17, 19, 21];

let host = null;
let geometry = null; // { strings, frets, capo, x(f), y(s) }
let layer = null;

const el = (name, attrs) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

export function initFretView(element) {
  host = element;
}

/**
 * Draws an empty neck. strings: count (from the staff's tuning), frets: highest fret to
 * show, names: string names low → high, capo: fret or 0. null clears it.
 */
export function setNeck(neck) {
  if (!host) return;
  host.textContent = '';
  geometry = null;
  if (!neck) return;
  const { strings, frets, names = [], capo = 0 } = neck;
  const w = 1000, h = 30 + strings * 16, left = 34, right = 10, top = 16, nut = left + 18;
  const fretW = (w - nut - right) / frets;
  const x = (f) => (f === 0 ? left + 8 : nut + (f - 0.5) * fretW);
  const y = (s) => top + (strings - s) * ((h - top - 12) / (strings - 1 || 1)); // string 1 (lowest) at the bottom
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, class: 'fv-neck', role: 'img', 'aria-label': 'Fretboard' });
  svg.append(el('rect', { x: nut, y: top - 6, width: w - nut - right, height: y(1) - top + 12, class: 'fv-wood', rx: 3 }));
  for (const f of INLAYS) if (f <= frets) svg.append(el('circle', { cx: nut + (f - 0.5) * fretW, cy: (top + y(1)) / 2, r: 5, class: 'fv-inlay' }));
  if (frets >= 12) {
    const cx = nut + 11.5 * fretW;
    const span = y(1) - top;
    svg.append(el('circle', { cx, cy: top + span * 0.25, r: 5, class: 'fv-inlay' }), el('circle', { cx, cy: top + span * 0.75, r: 5, class: 'fv-inlay' }));
  }
  for (let f = 1; f <= frets; f++) svg.append(el('line', { x1: nut + f * fretW, x2: nut + f * fretW, y1: top - 6, y2: y(1) + 6, class: 'fv-fret' }));
  svg.append(el('line', { x1: nut, x2: nut, y1: top - 6, y2: y(1) + 6, class: 'fv-nut' }));
  for (let s = 1; s <= strings; s++) {
    svg.append(el('line', { x1: left + 16, x2: w - right, y1: y(s), y2: y(s), class: 'fv-string', 'stroke-width': 2.4 - (s / strings) * 1.4 }));
    const label = el('text', { x: 10, y: y(s) + 4, class: 'fv-label' });
    label.textContent = names[s - 1] || '';
    svg.append(label);
  }
  for (const f of [3, 5, 7, 9, 12, 15, 17, 19, 21, 24]) {
    if (f > frets) continue;
    const t = el('text', { x: nut + (f - 0.5) * fretW, y: h - 1, class: 'fv-num' });
    t.textContent = f;
    svg.append(t);
  }
  if (capo > 0 && capo <= frets) {
    svg.append(el('rect', { x: nut + (capo - 0.5) * fretW - 6, y: top - 8, width: 12, height: y(1) - top + 16, rx: 6, class: 'fv-capo' }));
  }
  layer = el('g', {});
  svg.append(layer);
  host.append(svg);
  geometry = { strings, frets, x, y, capo };
}

/** now / next: [{ string (1 = lowest), fret }] — frets relative to the capo, as in the tab. */
export function showNotes(now = [], next = []) {
  if (!geometry || !layer) return;
  const { x, y, frets, capo } = geometry;
  layer.textContent = '';
  const dot = (n, cls) => {
    const f = n.fret + capo;
    if (n.string < 1 || n.string > geometry.strings || f > frets) return;
    const g = el('g', { class: cls });
    const cx = n.fret === 0 && capo ? x(capo) + 14 : x(f);
    g.append(el('circle', { cx, cy: y(n.string), r: 10 }));
    const t = el('text', { x: cx, y: y(n.string) + 4 });
    t.textContent = n.fret; // the tab's number (relative to the capo)
    g.append(t);
    layer.append(g);
  };
  const nowKeys = new Set(now.map((n) => `${n.string}.${n.fret}`));
  for (const n of next) if (!nowKeys.has(`${n.string}.${n.fret}`)) dot(n, 'fv-next');
  for (const n of now) dot(n, 'fv-now');
}
