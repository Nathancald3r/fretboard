// A shaker (or tambourine) in the hand: on each hit it moves down or up, with the stroke and
// the count named beside it, so you can shake along. Shown in "How to play" for a percussion
// track that has only hand percussion.
const NS = 'http://www.w3.org/2000/svg';

let host = null;
let svg = null;
let hand = null; // the moving group
let word = null;
let count = null;
let upcoming = null;
let arrowUp = null;
let arrowDown = null;
let at = 'down'; // where the shaker is now

const el = (name, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
};

const Y = { up: -46, down: 46 };

export function initShakerView(element) {
  host = element;
}

// Hand percussion that is shaken: its strokes go down and up.
export const SHAKEN = new Set([82, 54, 70, 69]); // shaker, tambourine, maracas, cabasa

function build(name) {
  svg = el('svg', { viewBox: '0 0 520 300', class: 'sk-view', role: 'img', 'aria-label': `${name}: shake down or up on each note` });
  const g = (id, stops, attrs) => {
    const lg = el('linearGradient', { id, ...attrs });
    for (const [o, c] of stops) lg.append(el('stop', { offset: o, 'stop-color': c }));
    return lg;
  };
  svg.append(el('defs', {},
    g('sk-body', [[0, '#7a2e0e'], [0.25, '#e0802f'], [0.5, '#ffc46b'], [0.75, '#d9702a'], [1, '#6b250b']], { x1: 0, y1: 0, x2: 0, y2: 1 }),
    g('sk-cap', [[0, '#3a3f47'], [0.5, '#c9ced6'], [1, '#2e3238']], { x1: 0, y1: 0, x2: 0, y2: 1 }),
    el('filter', { id: 'sk-soft', x: '-20%', y: '-40%', width: '140%', height: '180%' },
      el('feDropShadow', { dx: 0, dy: 6, stdDeviation: 5, 'flood-color': '#000', 'flood-opacity': 0.45 }))));
  // the track it moves along: a faint line with the two ends marked
  svg.append(el('line', { x1: 150, y1: 150 + Y.up, x2: 150, y2: 150 + Y.down, class: 'sk-rail' }));
  arrowUp = el('path', { d: 'M150,62 l-16,22 h32 z', class: 'sk-arrow' });
  arrowDown = el('path', { d: 'M150,238 l-16,-22 h32 z', class: 'sk-arrow' });
  svg.append(arrowUp, arrowDown);
  // the shaker: a tube with metal end caps, a few beads seen through a window, held level
  hand = el('g', { class: 'sk-hand', filter: 'url(#sk-soft)' });
  hand.append(
    el('rect', { x: 60, y: 128, width: 180, height: 44, rx: 22, fill: 'url(#sk-body)' }),
    el('rect', { x: 52, y: 126, width: 22, height: 48, rx: 9, fill: 'url(#sk-cap)' }),
    el('rect', { x: 226, y: 126, width: 22, height: 48, rx: 9, fill: 'url(#sk-cap)' }),
    el('rect', { x: 110, y: 141, width: 80, height: 18, rx: 9, fill: '#2a1206', opacity: 0.55 }),
  );
  for (const [x, y] of [[120, 150], [134, 147], [148, 152], [162, 148], [176, 151]]) hand.append(el('circle', { cx: x, cy: y, r: 4, fill: '#f3e3c0' }));
  hand.append(el('rect', { x: 78, y: 133, width: 144, height: 7, rx: 3.5, fill: '#ffffff', opacity: 0.28 }));
  svg.append(hand);
  word = el('text', { x: 300, y: 150, class: 'sk-word' });
  count = el('text', { x: 302, y: 196, class: 'sk-count' });
  upcoming = el('text', { x: 302, y: 232, class: 'sk-next' });
  const title = el('text', { x: 302, y: 98, class: 'sk-name' });
  title.textContent = name;
  svg.append(title, word, count, upcoming);
  at = 'down';
  hand.style.transform = `translateY(${Y.down}px)`;
}

/** Shows the shaker (name: what it is) or clears it. */
export function setShaker(on, name = 'Shaker') {
  if (!host) return;
  host.textContent = '';
  svg = null;
  if (!on) return;
  build(name);
  host.append(svg);
}

/**
 * dir: 'down' | 'up' for a hit now (null: nothing on this beat); next: the next hit's stroke;
 * label: the count ("2 &"); ms: how long the stroke takes.
 */
export function showShake(dir, next, label = '', ms = 150) {
  if (!svg) return;
  upcoming.textContent = next ? `then ${next === 'down' ? 'down' : 'up'}` : '';
  if (!dir) { word.textContent = ''; count.textContent = ''; arrowUp.classList.remove('sk-on'); arrowDown.classList.remove('sk-on'); return; }
  word.textContent = dir === 'down' ? 'Down' : 'Up';
  count.textContent = label;
  arrowDown.classList.toggle('sk-on', dir === 'down');
  arrowUp.classList.toggle('sk-on', dir === 'up');
  // two hits the same way in a row: the hand comes back first, so it still reads as a stroke
  const from = dir === at ? (dir === 'down' ? Y.up : Y.down) : Y[at];
  hand.animate?.([{ transform: `translateY(${from}px)` }, { transform: `translateY(${Y[dir]}px)` }], { duration: Math.max(60, Math.min(220, ms)), easing: 'cubic-bezier(.3,.7,.3,1)' });
  hand.style.transform = `translateY(${Y[dir]}px)`;
  at = dir;
}
