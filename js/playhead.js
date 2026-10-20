// The playhead and the scrolling while a song plays (alphaTab's custom cursor and scroll
// handlers). Both move in one animation-frame loop rather than with CSS transitions, so
// they also glide with "reduce motion" on (Windows with animations off), where transitions
// are switched off and alphaTab's own cursor jumps ahead. The playhead is a rounded box around the notes of the beat playing, gliding to
// the next beat in exactly the time until it sounds, and never past it, so it can't run
// ahead of the music. The page scrolls continuously along with it: each line glides up
// while it plays so the next line is in place when it starts, with the line before still
// visible above.

const BOX = 24; // playhead width at zoom 1 (px)
const PAD = 9; // above the top and below the bottom string
const USER_PAUSE = 2500; // after you scroll yourself, the page waits this long (ms)

export function installPlayhead(api, scrollEl, scoreEl) {
  let head = null;
  let y = 0;
  let h = 0;
  let glide = null; // page scroll: { from, to, t0, ms }
  let move = null; // playhead: { from, to, t0, ms }
  let headX = 0;
  let raf = 0;
  let userUntil = 0;
  const scale = () => api.settings.display.scale || 1;
  const width = () => BOX * scale();

  function ensureHead(cursor) {
    const parent = cursor.element?.parentElement;
    if (!parent) return null;
    if (!head || head.parentElement !== parent) {
      head = document.createElement('div');
      head.className = 'fb-playhead';
      parent.append(head);
    }
    return head;
  }

  // Where the box goes vertically: around the staff of the shown track.
  function measure(beatBounds) {
    const staff = beatBounds.barBounds.visualBounds;
    y = staff.y - PAD * scale();
    h = staff.h + 2 * PAD * scale();
  }

  const at = (x) => `translate(${x - width() / 2}px, ${y}px)`;

  api.customCursorHandler = {
    onAttach() {},
    onDetach() { head?.remove(); head = null; },
    placeBeatCursor(cursor, beatBounds, x) {
      const el = ensureHead(cursor);
      if (!el) return;
      measure(beatBounds);
      move = null;
      headX = x;
      el.style.width = width() + 'px';
      el.style.height = h + 'px';
      el.style.borderRadius = 10 * scale() + 'px';
      el.style.transform = at(x);
    },
    placeBarCursor(cursor, beatBounds) {
      const bar = beatBounds.barBounds.masterBarBounds.visualBounds;
      cursor.setBounds(bar.x, bar.y, bar.w, bar.h);
    },
    transitionBeatCursor(cursor, _beatBounds, _fromX, toX, ms) {
      const el = ensureHead(cursor);
      if (!el) return;
      move = { from: headX, to: toX, t0: performance.now(), ms };
      if (!raf) raf = requestAnimationFrame(frame);
    },
  };

  /* ---------- scrolling ---------- */

  // Top of the score inside the scroll box.
  const offsetTop = () => {
    const box = scrollEl.getBoundingClientRect();
    return scoreEl.getBoundingClientRect().top - box.top + scrollEl.scrollTop;
  };

  // The scroll position for a spot on a line: x from the line's start (0) to its end (1)
  // moves from "this line second from the top" to "the next line second from the top".
  function targetFor(system, x) {
    const systems = api.renderer.boundsLookup?.staffSystems || [];
    const i = systems.indexOf(system);
    const top = system.realBounds.y;
    const next = systems[i + 1]?.realBounds.y ?? top + system.realBounds.h;
    const prevH = i > 0 ? top - systems[i - 1].realBounds.y : 0;
    const left = system.visualBounds.x;
    const frac = x == null ? 0 : Math.max(0, Math.min(1, (x - left) / Math.max(1, system.visualBounds.w)));
    // Room above the line: the line before it, but never more than 40% of the view.
    const room = Math.min(prevH + 8, scrollEl.clientHeight * 0.4);
    return Math.max(0, offsetTop() + top + (next - top) * frac - room);
  }

  const progress = (g, now) => (g.ms > 0 ? Math.min(1, (now - g.t0) / g.ms) : 1);

  function frame() {
    raf = 0;
    const now = performance.now();
    let more = false;
    if (move && head) {
      const k = progress(move, now);
      headX = move.from + (move.to - move.from) * k;
      head.style.transform = at(headX);
      if (k < 1) more = true; else move = null;
    }
    if (glide) {
      const k = progress(glide, now);
      if (now >= userUntil) {
        const want = glide.from + (glide.to - glide.from) * k;
        if (Math.abs(scrollEl.scrollTop - want) >= 0.5) scrollEl.scrollTop = want;
      }
      if (k < 1) more = true; else glide = null;
    }
    if (more) raf = requestAnimationFrame(frame);
  }

  function glideTo(from, to, ms) {
    glide = { from, to, t0: performance.now(), ms };
    if (!raf) raf = requestAnimationFrame(frame);
  }

  // Your own scrolling wins for a moment.
  const userScrolled = () => { userUntil = performance.now() + USER_PAUSE; };
  scrollEl.addEventListener('wheel', userScrolled, { passive: true });
  scrollEl.addEventListener('touchstart', userScrolled, { passive: true });
  scrollEl.addEventListener('keydown', userScrolled);
  scrollEl.addEventListener('mousedown', (e) => { if (e.target === scrollEl) userScrolled(); }); // the scrollbar

  api.customScrollHandler = {
    [Symbol.dispose]() {},
    // A jump (seek, section, loop start): straight to that spot.
    forceScrollTo(beatBounds) {
      const system = beatBounds.barBounds.masterBarBounds.staffSystemBounds;
      glide = null;
      userUntil = 0;
      scrollEl.scrollTo({ top: targetFor(system, beatBounds.onNotesX), behavior: 'smooth' });
    },
    // Every beat while playing: glide along with the playhead.
    onBeatCursorUpdating(startBeat, _endBeat, _mode, startX, endX, ms) {
      const system = startBeat.barBounds.masterBarBounds.staffSystemBounds;
      const from = targetFor(system, startX);
      const to = targetFor(system, endX);
      // Coming from somewhere else (a jump, the end of a line): start where we are now.
      const now = scrollEl.scrollTop;
      glideTo(Math.abs(now - from) > 4 && performance.now() >= userUntil ? now : from, to, Math.max(ms, 1));
    },
  };

  return {
    // Brings a bar's line into place (sections): second from the top, as when playing.
    scrollToBar(masterIndex) {
      const systems = api.renderer.boundsLookup?.staffSystems;
      const system = systems?.find((s) => s.bars.some((b) => b.index === masterIndex));
      if (!system) return;
      glide = null;
      userUntil = 0;
      scrollEl.scrollTo({ top: targetFor(system, null), behavior: 'smooth' });
    },
  };
}
