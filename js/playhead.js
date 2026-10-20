// The playhead (alphaTab's custom cursor handler): a box around the notes of the beat
// playing, pointed at the bottom, drawn behind the notes so it never covers a number. It
// glides to the next beat in exactly the time until that beat sounds and never past it, so
// it can't run ahead of the music. It moves in an animation-frame loop rather than with a
// CSS transition, so it also glides with "reduce motion" on (Windows with animations off),
// where transitions are switched off and alphaTab's own cursor jumps ahead.

const BOX = 24; // smallest playhead width at zoom 1 (px)
const SIDE = 7; // room beside the widest number of the beat
const TOP = 4; // above the top string (chord names and bar numbers sit just above)
const BOTTOM = 7; // below the bottom string, before the point starts
const POINT = 10; // how far the point reaches down
const RADIUS = 8;
const SVG = 'http://www.w3.org/2000/svg';

export function installPlayhead(api) {
  let head = null;
  let shape = null;
  let y = 0;
  let w = 0;
  let move = null; // { from, to, t0, ms }
  let headX = 0;
  let raf = 0;
  const scale = () => api.settings.display.scale || 1;

  function ensureHead(cursor) {
    const parent = cursor.element?.parentElement;
    if (!parent) return null;
    if (!head || head.parentElement !== parent) {
      head = document.createElement('div');
      head.className = 'fb-playhead';
      const svg = document.createElementNS(SVG, 'svg');
      shape = document.createElementNS(SVG, 'path');
      svg.append(shape);
      head.append(svg);
      parent.append(head);
    }
    return head;
  }

  // Size and shape: around the staff of the shown track, wide enough for the beat's numbers.
  function draw(el, beatBounds) {
    const s = scale();
    const staff = beatBounds.barBounds.visualBounds;
    w = Math.max(BOX * s, (beatBounds.visualBounds?.w || 0) + 2 * SIDE * s);
    y = staff.y - TOP * s;
    const body = staff.h + (TOP + BOTTOM) * s;
    const h = body + POINT * s;
    const r = RADIUS * s;
    const i = 1; // half the stroke
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.firstChild.setAttribute('viewBox', `0 0 ${w} ${h}`);
    shape.setAttribute('d', `M${r} ${i}H${w - r}A${r - i} ${r - i} 0 0 1 ${w - i} ${r}V${body}`
      + `L${w / 2} ${h - i}L${i} ${body}V${r}A${r - i} ${r - i} 0 0 1 ${r} ${i}Z`);
  }

  const at = (x) => `translate(${x - w / 2}px, ${y}px)`;

  function frame() {
    raf = 0;
    if (!move || !head) return;
    const k = move.ms > 0 ? Math.min(1, (performance.now() - move.t0) / move.ms) : 1;
    headX = move.from + (move.to - move.from) * k;
    head.style.transform = at(headX);
    if (k < 1) raf = requestAnimationFrame(frame); else move = null;
  }

  api.customCursorHandler = {
    onAttach() {},
    onDetach() { head?.remove(); head = null; },
    placeBeatCursor(cursor, beatBounds, x) {
      const el = ensureHead(cursor);
      if (!el) return;
      draw(el, beatBounds);
      move = null;
      headX = x;
      el.style.transform = at(x);
    },
    placeBarCursor(cursor, beatBounds) {
      const bar = beatBounds.barBounds.masterBarBounds.visualBounds;
      cursor.setBounds(bar.x, bar.y, bar.w, bar.h);
    },
    transitionBeatCursor(cursor, _beatBounds, _fromX, toX, ms) {
      if (!ensureHead(cursor)) return;
      move = { from: headX, to: toX, t0: performance.now(), ms };
      if (!raf) raf = requestAnimationFrame(frame);
    },
  };
}
