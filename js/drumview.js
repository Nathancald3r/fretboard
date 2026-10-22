// Live drum kit: a five-piece kit with cymbals, seen from the drummer's seat, drawn as SVG on
// a clear background. The pieces hit on the beat under the cursor light up with their names
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
  49: ['crash', 'Crash'], 57: ['crash2', 'Crash 2'], 55: ['splash', 'Splash'], 52: ['china', 'China'],
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
  grad('dk-head', 'radial', [[0, '#fbf9f3'], [0.7, '#ece6d8'], [1, '#cfc6b3']], { cx: '45%', cy: '40%', r: '65%' }),
  grad('dk-chrome', 'linear', [[0, '#f4f6f8'], [0.35, '#9aa1ab'], [0.55, '#e8ebee'], [1, '#6c727c']], { x1: 0, y1: 0, x2: 1, y2: 1 }),
  grad('dk-shell', 'linear', [[0, '#3a0d10'], [0.18, '#8e1d22'], [0.42, '#d0444a'], [0.6, '#9a2228'], [1, '#2c0a0c']], { x1: 0, y1: 0, x2: 1, y2: 0 }),
  grad('dk-bronze', 'radial', [[0, '#f6dc8e'], [0.22, '#d9ab4c'], [0.6, '#b98428'], [0.92, '#8d5f19'], [1, '#6b4612']], { cx: '50%', cy: '50%', r: '50%' }),
  grad('dk-bell', 'radial', [[0, '#fff1c2'], [0.6, '#e2b65a'], [1, '#a7741f']], { cx: '40%', cy: '35%', r: '70%' }),
  grad('dk-shine', 'linear', [[0, '#ffffff00'], [0.5, '#ffffff8c'], [1, '#ffffff00']], { x1: 0, y1: 0, x2: 1, y2: 0 }),
  grad('dk-pedal', 'linear', [[0, '#2b2e33'], [0.5, '#5b6069'], [1, '#24272b']], { x1: 0, y1: 0, x2: 1, y2: 0 }),
  el('filter', { id: 'dk-soft', x: '-20%', y: '-20%', width: '140%', height: '160%' },
    el('feDropShadow', { dx: 0, dy: 6, stdDeviation: 5, 'flood-color': '#000', 'flood-opacity': 0.45 })),
);

function grad(id, type, stops, attrs) {
  const g = el(type === 'radial' ? 'radialGradient' : 'linearGradient', { id, ...attrs });
  for (const [o, c] of stops) g.append(el('stop', { offset: o, 'stop-color': c.slice(0, 7), 'stop-opacity': c.length > 7 ? parseInt(c.slice(7), 16) / 255 : 1 }));
  return g;
}

// A drum seen from above and a little behind: shell going down, chrome hoop, coated head, lugs.
function drum(id, cx, cy, rx, ry, depth) {
  const g = el('g', { class: 'dk-piece', 'data-piece': id, filter: 'url(#dk-soft)' });
  g.append(el('path', { d: `M${cx - rx},${cy} L${cx - rx},${cy + depth} A${rx},${ry} 0 0 0 ${cx + rx},${cy + depth} L${cx + rx},${cy} Z`, fill: 'url(#dk-shell)' }));
  for (let i = 1; i < 8; i++) { // lugs round the visible front of the shell
    const a = Math.PI * (i / 8);
    const x = cx - Math.cos(a) * rx * 0.97;
    const y = cy + Math.sin(a) * ry + depth * 0.35;
    g.append(el('rect', { x: x - 3, y, width: 6, height: Math.max(8, depth * 0.3), rx: 3, fill: 'url(#dk-chrome)' }));
  }
  g.append(el('ellipse', { cx, cy: cy + depth, rx, ry, fill: 'none', stroke: '#00000055', 'stroke-width': 2, 'stroke-dasharray': `0 ${Math.PI * rx} ${Math.PI * rx * 2}` }));
  g.append(el('ellipse', { cx, cy, rx: rx + 3, ry: ry + 2, fill: 'url(#dk-chrome)' }));
  g.append(el('ellipse', { cx, cy, rx: rx - 3, ry: ry - 3, fill: 'url(#dk-head)' }));
  g.append(el('ellipse', { cx: cx - rx * 0.12, cy: cy - ry * 0.15, rx: rx * 0.55, ry: ry * 0.45, fill: '#ffffff', opacity: 0.25 }));
  for (let i = 0; i < 10; i++) { // tension rods on the hoop
    const a = (i / 10) * Math.PI * 2;
    g.append(el('circle', { cx: cx + Math.cos(a) * (rx + 1), cy: cy + Math.sin(a) * (ry + 1), r: 2.6, fill: '#4a4f57' }));
  }
  return finish(g, id, el('ellipse', { cx, cy, rx: rx - 3, ry: ry - 3 }), el('ellipse', { cx, cy, rx: rx + 9, ry: ry + 8 }), [cx, cy - ry - 12]);
}

// A cymbal: bronze with lathe rings, a bell and a streak of light; stands drawn separately.
function cymbal(id, cx, cy, rx, ry, { lift = 0 } = {}) {
  const g = el('g', { class: 'dk-piece', 'data-piece': id, filter: 'url(#dk-soft)' });
  const y = cy - lift;
  g.append(el('ellipse', { cx, cy: y, rx, ry, fill: 'url(#dk-bronze)', stroke: '#5b3b0e', 'stroke-width': 1 }));
  for (let k = 0.28; k < 1; k += 0.07) g.append(el('ellipse', { cx, cy: y, rx: rx * k, ry: ry * k, fill: 'none', stroke: '#5a3a0a', 'stroke-opacity': 0.16, 'stroke-width': 1 }));
  g.append(el('ellipse', { cx, cy: y, rx: rx * 0.95, ry: ry * 0.25, fill: 'url(#dk-shine)', transform: `rotate(-12 ${cx} ${y})`, opacity: 0.7 }));
  g.append(el('ellipse', { cx, cy: y, rx: rx * 0.2, ry: ry * 0.24, fill: 'url(#dk-bell)', stroke: '#7a5418', 'stroke-width': 0.8 }));
  g.append(el('ellipse', { cx, cy: y - 1, rx: 4, ry: 3, fill: '#2a2a2a' })); // felt and wing nut
  return finish(g, id, el('ellipse', { cx, cy: y, rx, ry }), el('ellipse', { cx, cy: y, rx: rx + 9, ry: ry + 7 }), [cx, y - ry - 12]);
}

function finish(g, id, glowShape, ringShape, label) {
  glowShape.setAttribute('class', 'dk-glow');
  ringShape.setAttribute('class', 'dk-ring');
  g.append(glowShape, ringShape);
  pieces.set(id, { g, label });
  return g;
}

const stand = (x1, y1, x2, y2) => el('line', { x1, y1, x2, y2, class: 'dk-stand' });

function pedal(id, cx, y, label) {
  const g = el('g', { class: 'dk-piece', 'data-piece': id });
  g.append(el('path', { d: `M${cx - 22},${y + 70} L${cx - 16},${y} L${cx + 16},${y} L${cx + 22},${y + 70} Z`, fill: 'url(#dk-pedal)', stroke: '#15171a', 'stroke-width': 1.5 }));
  for (let i = 1; i < 6; i++) g.append(el('line', { x1: cx - 15 - i * 0.8, x2: cx + 15 + i * 0.8, y1: y + i * 11, y2: y + i * 11, stroke: '#ffffff22', 'stroke-width': 1.5 }));
  g.append(el('rect', { x: cx - 26, y: y + 66, width: 52, height: 10, rx: 4, fill: '#33373d' }));
  return finish(g, id, el('path', { d: `M${cx - 22},${y + 70} L${cx - 16},${y} L${cx + 16},${y} L${cx + 22},${y + 70} Z` }),
    el('rect', { x: cx - 32, y: y - 8, width: 64, height: 92, rx: 10 }), label);
}

function build() {
  pieces = new Map();
  svg = el('svg', { viewBox: '55 150 900 455', class: 'dk-kit', role: 'img', 'aria-label': 'Drum kit, seen from the drummer’s seat' });
  svg.append(defs());
  // the kick, seen along its top as it points away from you, with the toms on it
  const kick = el('g', { class: 'dk-piece', 'data-piece': 'kick', filter: 'url(#dk-soft)' });
  kick.append(el('path', { d: 'M352,520 L386,330 L614,330 L648,520 Z', fill: 'url(#dk-shell)' }));
  kick.append(el('path', { d: 'M386,330 L614,330', stroke: 'url(#dk-chrome)', 'stroke-width': 9, 'stroke-linecap': 'round' }));
  kick.append(el('ellipse', { cx: 500, cy: 520, rx: 152, ry: 26, fill: 'url(#dk-chrome)' }));
  kick.append(el('ellipse', { cx: 500, cy: 516, rx: 144, ry: 19, fill: 'url(#dk-head)' }));
  for (const x of [372, 628]) kick.append(el('rect', { x: x - 4, y: 400, width: 8, height: 60, rx: 4, fill: 'url(#dk-chrome)' }));
  kick.append(el('rect', { x: 494, y: 470, width: 12, height: 50, rx: 3, fill: '#c9ccd2' })); // beater shaft
  kick.append(el('ellipse', { cx: 500, cy: 470, rx: 16, ry: 10, fill: '#ece8de', stroke: '#555', 'stroke-width': 1 })); // beater
  finish(kick, 'kick', el('path', { d: 'M352,520 L386,330 L614,330 L648,520 Z' }), el('path', { d: 'M340,532 L378,320 L622,320 L660,532 Z' }), [500, 470]);
  svg.append(kick);
  svg.append(drum('tom1', 410, 278, 82, 40, 30), drum('tom2', 590, 278, 90, 43, 32));
  svg.append(drum('snare', 320, 430, 118, 54, 26), drum('floor', 735, 438, 132, 62, 58));
  svg.append(pedal('hhpedal', 160, 412, [160, 520]), pedal('kickpedal', 500, 525, [500, 513]));
  // cymbals hang over the drums (no stands drawn), which keeps the kit compact
  svg.append(cymbal('hihat', 172, 372, 100, 32), cymbal('crash', 292, 262, 122, 40), cymbal('splash', 500, 222, 55, 18),
    cymbal('crash2', 645, 235, 100, 33), cymbal('china', 862, 282, 70, 23), cymbal('ride', 805, 362, 140, 46));
  pieces.get('kickpedal').joinsKick = true;
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
  const t = el('text', { x, y: y - 8, class: 'dk-tag-text' });
  t.textContent = text;
  const w = text.length * 12.5 + 28;
  tags.append(el('rect', { x: x - w / 2, y: y - 36, width: w, height: 38, rx: 19, class: 'dk-tag' }), t);
}
