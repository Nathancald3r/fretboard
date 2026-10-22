// Live drum kit: a five-piece kit with cymbals, seen from above the drummer's seat, drawn as
// SVG on a clear background. The pieces hit on the beat under the cursor light up with their names
// (and which foot, for the pedals); the next beat's pieces get a dashed ring.
const NS = 'http://www.w3.org/2000/svg';

let host = null;
let svg = null;
let pieces = null; // id -> { g, glow, ring, label: [x, y] }
let tags = null;

const el = (name, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
};

// General MIDI drum notes -> the piece of the kit and what to call the hit.
const KIT = {
  35: ['kick', 'Kick · right foot'], 36: ['kick', 'Kick · right foot'],
  37: ['snare', 'Snare · side stick'], 38: ['snare', 'Snare'], 40: ['snare', 'Snare'], 39: ['snare', 'Hand clap'],
  91: ['snare', 'Snare · rim shot'],
  42: ['hihat', 'Hi-hat · closed'], 46: ['hihat', 'Hi-hat · open'], 44: ['hhpedal', 'Hi-hat pedal · left foot'],
  41: ['floor', 'Floor tom'], 43: ['floor', 'Floor tom'], 45: ['tom2', 'Mid tom'], 47: ['tom2', 'Mid tom'],
  48: ['tom1', 'High tom'], 50: ['tom1', 'High tom'],
  49: ['crash', 'Crash'], 57: ['crash2', 'Crash 2'], 55: ['crash2', 'Splash'], 52: ['crash2', 'China'],
  51: ['ride', 'Ride'], 59: ['ride', 'Ride'], 53: ['ride', 'Ride · bell'],
};
const EXTRA = { 54: 'Tambourine', 56: 'Cowbell', 58: 'Vibraslap', 60: 'Bongo high', 61: 'Bongo low', 62: 'Conga (muted)',
  63: 'Conga high', 64: 'Conga low', 69: 'Cabasa', 70: 'Maracas', 75: 'Claves', 76: 'Wood block', 77: 'Wood block',
  81: 'Triangle', 80: 'Triangle', 82: 'Shaker', 84: 'Bell tree' };
// Guitar Pro 7 drum ids above 90 and the MIDI note each one sounds.
const GP7 = { 91: 37, 92: 46, 93: 51, 94: 51, 95: 55, 96: 52, 97: 49, 98: 57, 99: 56, 100: 56, 101: 56, 102: 56, 103: 56,
  104: 60, 105: 60, 106: 61, 107: 61, 108: 64, 109: 64, 110: 63, 111: 54, 112: 54, 113: 54, 114: 43, 115: 49, 116: 49,
  117: 69, 118: 70, 119: 70, 120: 70, 122: 82, 123: 84, 124: 62, 125: 62, 126: 59, 127: 59 };

/** The MIDI drum note of an articulation id (a track's own list is used first by the caller). */
export function drumMidi(id) {
  if (id === 91) return 91; // a rim shot sounds like a snare, but is named apart
  return GP7[id] ?? id;
}

/** What is hit for a MIDI drum note: { piece, name } (piece null: not part of the drawn kit). */
export function drumHit(midi) {
  const k = KIT[midi];
  if (k) return { piece: k[0], name: k[1] };
  return { piece: null, name: EXTRA[midi] || 'Percussion' };
}

export function initDrumView(element) {
  host = element;
}

const defs = () => el('defs', {},
  grad('dk-head', 'radial', [[0, '#ffffff'], [0.75, '#f3f5f7'], [1, '#d9dde2']], { cx: '45%', cy: '42%', r: '60%' }),
  grad('dk-chrome', 'linear', [[0, '#f4f6f8'], [0.35, '#9aa1ab'], [0.55, '#e8ebee'], [1, '#6c727c']], { x1: 0, y1: 0, x2: 1, y2: 1 }),
  grad('dk-shell', 'linear', [[0, '#120f0e'], [0.3, '#3a2a22'], [0.5, '#5a4033'], [0.7, '#33251e'], [1, '#0f0c0b']], { x1: 0, y1: 0, x2: 1, y2: 0 }),
  grad('dk-brass', 'radial', [[0, '#f1dc95'], [0.2, '#d8bb63'], [0.55, '#c7a44a'], [0.85, '#b38f37'], [1, '#8f6f22']], { cx: '50%', cy: '50%', r: '50%' }),
  grad('dk-bell', 'radial', [[0, '#fff3c4'], [0.55, '#e3c46b'], [1, '#a9852c']], { cx: '40%', cy: '35%', r: '70%' }),
  grad('dk-sheen', 'linear', [[0, '#ffffff00'], [0.42, '#ffffff00'], [0.5, '#ffffff66'], [0.58, '#ffffff00'], [1, '#ffffff00']], { x1: 0, y1: 0, x2: 1, y2: 1 }),
  grad('dk-pedal', 'linear', [[0, '#1a1b1e'], [0.5, '#3b3e44'], [1, '#141518']], { x1: 0, y1: 0, x2: 1, y2: 0 }),
  el('filter', { id: 'dk-soft', x: '-20%', y: '-20%', width: '140%', height: '150%' },
    el('feDropShadow', { dx: 3, dy: 7, stdDeviation: 6, 'flood-color': '#000', 'flood-opacity': 0.5 })),
);

function grad(id, type, stops, attrs) {
  const g = el(type === 'radial' ? 'radialGradient' : 'linearGradient', { id, ...attrs });
  for (const [o, c] of stops) g.append(el('stop', { offset: o, 'stop-color': c.slice(0, 7), 'stop-opacity': c.length > 7 ? parseInt(c.slice(7), 16) / 255 : 1 }));
  return g;
}

// A drum seen from above: a dark shell just showing below the black hoop, a white coated
// head, and chrome lugs round the edge.
function drum(id, cx, cy, r, lugs = 8) {
  const g = el('g', { class: 'dk-piece', 'data-piece': id, filter: 'url(#dk-soft)' });
  g.append(el('circle', { cx, cy: cy + 7, r: r + 2, fill: 'url(#dk-shell)' }));
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * Math.PI * 2 + Math.PI / lugs;
    const x = cx + Math.cos(a) * (r + 5);
    const y = cy + 4 + Math.sin(a) * (r + 5);
    g.append(el('rect', { x: x - 3.5, y: y - 7, width: 7, height: 14, rx: 2.5, fill: 'url(#dk-chrome)', transform: `rotate(${(a * 180) / Math.PI + 90} ${x} ${y})` }));
  }
  g.append(el('circle', { cx, cy, r: r + 3, fill: '#16171a', stroke: '#9aa1ab', 'stroke-width': 1.2 }));
  g.append(el('circle', { cx, cy, r: r - 2, fill: 'url(#dk-head)' }));
  for (let i = 0; i < lugs; i++) { // tension rods on the hoop
    const a = (i / lugs) * Math.PI * 2 + Math.PI / lugs;
    g.append(el('circle', { cx: cx + Math.cos(a) * (r + 0.5), cy: cy + Math.sin(a) * (r + 0.5), r: 2.2, fill: '#c9ced5' }));
  }
  return finish(g, id, el('circle', { cx, cy, r: r - 2 }), el('circle', { cx, cy, r: r + 12 }), [cx, cy - r - 14]);
}

// A brass cymbal from above: lathe grooves, a bell, the felt and nut, and a streak of light.
function cymbal(id, cx, cy, r) {
  const g = el('g', { class: 'dk-piece', 'data-piece': id, filter: 'url(#dk-soft)' });
  g.append(el('circle', { cx, cy, r, fill: 'url(#dk-brass)', stroke: '#7d6020', 'stroke-width': 1 }));
  for (let k = 0.3; k < 0.98; k += 0.045) g.append(el('circle', { cx, cy, r: r * k, fill: 'none', stroke: '#6b5114', 'stroke-opacity': 0.13, 'stroke-width': 1 }));
  g.append(el('circle', { cx, cy, r: r * 0.82, fill: 'none', stroke: '#fff3c8', 'stroke-opacity': 0.25, 'stroke-width': 2 }));
  g.append(el('circle', { cx, cy, r, fill: 'url(#dk-sheen)' }));
  g.append(el('circle', { cx, cy, r: r * 0.24, fill: 'url(#dk-bell)', stroke: '#8a6a22', 'stroke-width': 0.8 }));
  g.append(el('circle', { cx, cy, r: 6, fill: '#2b2b2b' }), el('circle', { cx, cy, r: 2.5, fill: '#c9ced5' }));
  return finish(g, id, el('circle', { cx, cy, r }), el('circle', { cx, cy, r: r + 10 }), [cx, cy - r - 12]);
}

function finish(g, id, glowShape, ringShape, label) {
  glowShape.setAttribute('class', 'dk-glow');
  ringShape.setAttribute('class', 'dk-ring');
  g.append(glowShape, ringShape);
  pieces.set(id, { g, label });
  return g;
}

// A stand from above: three legs with rubber feet round a hub.
function tripod(cx, cy, len, turn = 0) {
  const g = el('g', { class: 'dk-stand-g' });
  for (let i = 0; i < 3; i++) {
    const a = turn + (i / 3) * Math.PI * 2;
    const x = cx + Math.cos(a) * len, y = cy + Math.sin(a) * len;
    g.append(el('line', { x1: cx, y1: cy, x2: x, y2: y, class: 'dk-stand' }), el('circle', { cx: x, cy: y, r: 6, fill: '#1b1c1f' }));
  }
  g.append(el('circle', { cx, cy, r: 6, fill: 'url(#dk-chrome)' }));
  return g;
}
const arm = (x1, y1, x2, y2) => el('line', { x1, y1, x2, y2, class: 'dk-stand' });

// A foot pedal from above: the footboard and heel plate.
function pedal(id, cx, cy, angle, label) {
  const g = el('g', { class: 'dk-piece', 'data-piece': id });
  const t = `rotate(${angle} ${cx} ${cy})`;
  const board = `M${cx - 15},${cy - 48} L${cx + 15},${cy - 48} L${cx + 18},${cy + 34} L${cx - 18},${cy + 34} Z`;
  g.append(el('path', { d: board, fill: 'url(#dk-pedal)', stroke: '#0b0b0c', 'stroke-width': 1.5, transform: t }));
  g.append(el('rect', { x: cx - 19, y: cy + 34, width: 38, height: 16, rx: 3, fill: '#2a2c30', transform: t }));
  g.append(el('rect', { x: cx - 8, y: cy - 60, width: 16, height: 14, rx: 3, fill: 'url(#dk-chrome)', transform: t }));
  const glow = el('path', { d: board, transform: t });
  const ring = el('rect', { x: cx - 28, y: cy - 68, width: 56, height: 128, rx: 12, transform: t });
  return finish(g, id, glow, ring, label);
}

function build() {
  pieces = new Map();
  svg = el('svg', { viewBox: '70 40 1010 730', class: 'dk-kit', role: 'img', 'aria-label': 'Drum kit, seen from above the drummer’s seat' });
  svg.append(defs());
  // stands and their arms, under everything
  svg.append(tripod(330, 360, 62, 0.4), arm(330, 360, 320, 200), tripod(250, 610, 58, 1.2), arm(250, 610, 205, 425),
    tripod(915, 410, 70, 0.2), arm(915, 410, 875, 220),
    arm(858, 555, 745, 660), arm(858, 555, 965, 640), arm(858, 555, 870, 742),
    tripod(590, 120, 50, 0.6), arm(590, 120, 590, 150));
  // the kick runs away from you under the toms; you see its shell and the batter head nearest you
  const kick = el('g', { class: 'dk-piece', 'data-piece': 'kick', filter: 'url(#dk-soft)' });
  kick.append(el('rect', { x: 490, y: 300, width: 180, height: 230, rx: 10, fill: 'url(#dk-shell)' }));
  kick.append(el('rect', { x: 548, y: 300, width: 64, height: 70, rx: 6, fill: 'url(#dk-chrome)', opacity: 0.85 })); // tom mount
  for (const x of [470, 690]) kick.append(el('rect', { x: x - 5, y: 470, width: 10, height: 26, rx: 4, fill: 'url(#dk-chrome)' }));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    kick.append(el('circle', { cx: 580 + Math.cos(a) * 124, cy: 535 + Math.sin(a) * 104, r: 3, fill: '#c9ced5' }));
  }
  kick.append(el('ellipse', { cx: 580, cy: 535, rx: 128, ry: 108, fill: '#141518', stroke: '#9aa1ab', 'stroke-width': 1.2 }));
  kick.append(el('ellipse', { cx: 580, cy: 535, rx: 120, ry: 100, fill: 'url(#dk-head)' }));
  finish(kick, 'kick', el('ellipse', { cx: 580, cy: 535, rx: 120, ry: 100 }), el('ellipse', { cx: 580, cy: 535, rx: 138, ry: 118 }), [580, 575]);
  svg.append(kick);
  svg.append(drum('tom1', 487, 330, 64, 6), drum('tom2', 695, 335, 76, 8), drum('snare', 350, 482, 86, 10), drum('floor', 858, 555, 98, 8));
  svg.append(pedal('kickpedal', 580, 700, 0, [580, 700]), pedal('hhpedal', 300, 670, -28, [300, 670]));
  pieces.get('hhpedal').label = [215, 640];
  svg.append(cymbal('crash2', 590, 150, 68), cymbal('crash', 322, 198, 122), cymbal('ride', 876, 218, 152), cymbal('hihat', 203, 422, 112));
  tags = el('g', { class: 'dk-tags' });
  svg.append(tags);
}

/** Shows the empty kit (on) or clears it. */
export function setKit(on) {
  if (!host) return;
  host.textContent = '';
  svg = null;
  if (!on) return;
  build();
  host.append(svg);
}

/** now / next: MIDI drum notes. */
export function showDrums(now = [], next = []) {
  if (!svg) return;
  tags.textContent = '';
  for (const p of pieces.values()) p.g.classList.remove('dk-now', 'dk-next');
  const light = (piece, cls) => {
    pieces.get(piece)?.g.classList.add(cls);
    if (piece === 'kick') pieces.get('kickpedal')?.g.classList.add(cls);
    if (piece === 'hhpedal') pieces.get('hihat')?.g.classList.add(cls);
  };
  for (const m of next) { const h = drumHit(m); if (h.piece) light(h.piece, 'dk-next'); }
  const extras = [];
  const named = new Map();
  for (const m of now) {
    const h = drumHit(m);
    if (!h.piece) { if (!extras.includes(h.name)) extras.push(h.name); continue; }
    light(h.piece, 'dk-now');
    named.set(h.piece, h.name);
  }
  for (const [piece, name] of named) tag(pieces.get(piece).label, name);
  if (extras.length) tag([500, 30], extras.join(' · '));
}

function tag([x, y], text) {
  const t = el('text', { x, y: y - 12, class: 'dk-tag-text' });
  t.textContent = text;
  const w = text.length * 18 + 40;
  tags.append(el('rect', { x: x - w / 2, y: y - 52, width: w, height: 54, rx: 27, class: 'dk-tag' }), t);
}
