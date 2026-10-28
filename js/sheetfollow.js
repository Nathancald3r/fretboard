// Lights the line being sung and scrolls the sheet along with the video, smoothly. The times and the
// maths are in js/sheetsync.js; this only touches the page.
import { positionAt, follow } from './sheetsync.js';

const HOLD_MS = 3500; // after you scroll by hand the sheet leaves the scrolling to you for a while
const TOP = 0.35; // the lit line sits this far down the screen

export function createFollower({ body, now, canScroll = () => true }) {
  let chain = [];
  let targets = [];
  let last = 0;
  let on = false;
  let running = false;
  let lit = '';
  let cur = null; // where the eased scroll is now (null: take the page's own)
  let holdUntil = 0;
  let lastW = 0;
  const cache = new Map();

  const hold = () => { holdUntil = performance.now() + HOLD_MS; cur = null; };
  window.addEventListener('wheel', hold, { passive: true });
  window.addEventListener('touchstart', hold, { passive: true });
  window.addEventListener('keydown', (e) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) hold(); });

  const keyOf = (t) => (t ? (t.u != null ? `u${t.u}` : `b${t.b}`) : '');
  const elsOf = (t) => {
    const k = keyOf(t);
    if (!k) return [];
    if (!cache.has(k)) cache.set(k, [...body.querySelectorAll(t.u != null ? `[data-i="${t.u}"]` : `.tx-rep[data-b~="${t.b}"]`)]);
    return cache.get(k);
  };
  const topOf = (t) => {
    const e = elsOf(t)[0];
    return e ? e.getBoundingClientRect().top + window.scrollY : null;
  };

  function light(t) {
    const k = keyOf(t);
    if (k === lit) return;
    body.querySelectorAll('.now').forEach((e) => e.classList.remove('now'));
    elsOf(t).forEach((e) => e.classList.add('now'));
    lit = k;
  }

  // snap: jump to the place (a seek, or paused) instead of easing there; at: a video time to use instead of the clock's
  function update(snap = false, at = null) {
    const w = performance.now();
    const dt = lastW ? Math.min(0.25, (w - lastW) / 1000) : 0;
    lastW = w;
    const pos = on ? positionAt(chain, at ?? now(), last) : null;
    if (pos == null) { light(null); return; }
    const u = Math.floor(pos);
    light(targets[u]);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max <= 4 || w < holdUntil || !canScroll()) { cur = null; return; } // it all fits, or you are driving
    const y0 = topOf(targets[u]);
    if (y0 == null) return;
    const y1 = targets[u + 1] ? topOf(targets[u + 1]) : null;
    // between two lines the scroll glides from one to the other (it only steps when the next line is further up)
    const y = y0 + (y1 != null && y1 >= y0 ? (pos - u) * (y1 - y0) : 0);
    const want = Math.max(0, Math.min(max, y - window.innerHeight * TOP));
    if (cur == null || snap) cur = snap ? want : window.scrollY;
    cur = follow(cur, want, dt);
    if (Math.abs(cur - window.scrollY) >= 0.5 || snap) window.scrollTo(0, cur);
  }

  function loop() {
    if (!running) return;
    update();
    requestAnimationFrame(loop);
  }

  return {
    // after each render: the times that fit, where each line is shown, the number of the last line
    set(next) {
      chain = next.chain || [];
      targets = next.targets || [];
      last = next.last ?? Math.max(0, targets.length - 1);
      cache.clear();
      lit = '';
      cur = null;
    },
    enable(v) {
      on = !!v;
      if (!on) { this.stop(); light(null); }
    },
    start() { if (on && !running) { running = true; lastW = 0; cur = null; requestAnimationFrame(loop); } },
    stop() { running = false; },
    update,
    get active() { return on; },
  };
}
