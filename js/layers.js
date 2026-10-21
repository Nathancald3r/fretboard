// Android Back closes what is on top (a sheet, the ⚙ menu, the tempo or video pop-up, the drawer, full
// screen) before it leaves the page. Each layer that opens adds one history entry; Back (popstate)
// closes the top layer. Layers are detected from the page itself, so the code that opens them is unchanged.
const BODY_LAYERS = [
  ['drawer', 'drawer-open', () => document.getElementById('dr-close').click()],
  ['more', 'more-open', () => document.getElementById('pl-more').click()],
  ['tempo', 'tempo-open', () => document.getElementById('pl-tempo-open').click()],
  ['video', 'video-open', () => document.getElementById('pa-video-close').click()],
  ['focus', 'focus', () => document.getElementById('pl-focus').click()],
];

let stack = []; // names, bottom to top
let skipPop = 0;

const openNow = () => {
  const on = new Set(BODY_LAYERS.filter(([, cls]) => document.body.classList.contains(cls)).map(([n]) => n));
  if (document.querySelector('.sheet:not([hidden])')) on.add('sheet');
  return on;
};

const close = (name) => {
  if (name === 'sheet') document.querySelector('.sheet:not([hidden]) [data-close]')?.click();
  else BODY_LAYERS.find(([n]) => n === name)?.[2]();
};

function sync() {
  const on = openNow();
  for (const name of on) {
    if (!stack.includes(name)) { stack.push(name); history.pushState({ fbLayer: name }, ''); }
  }
  for (const name of [...stack]) {
    if (on.has(name)) continue;
    const top = stack[stack.length - 1] === name;
    stack = stack.filter((n) => n !== name);
    if (top) { skipPop++; history.back(); } // closed from the screen: drop its history entry too
  }
}

/** Forget open layers when the page changes (their history entries stay, as harmless duplicates). */
export function resetLayers() {
  stack = [];
  for (const [, cls] of BODY_LAYERS) document.body.classList.remove(cls);
  document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; });
  document.querySelectorAll('[data-sheet-btn].on').forEach((b) => b.classList.remove('on'));
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* ignore */ }
  document.getElementById('pl-focus')?.setAttribute('aria-pressed', 'false');
}

export function initLayers() {
  const mo = new MutationObserver(() => queueMicrotask(sync));
  mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.querySelectorAll('.sheet').forEach((s) => mo.observe(s, { attributes: true, attributeFilter: ['hidden'] }));
  // Tapping the tab (or anywhere outside the sheet and the buttons that open it) closes an open sheet.
  document.addEventListener('pointerdown', (e) => {
    if (!document.querySelector('.sheet:not([hidden]):not(#ed-sheet)')) return; // the Edit sheet stays open while you tap notes
    if (e.target.closest('.sheet, .sheet-btns, [data-sheet-btn], #pl-more, .dock, dialog, .toast')) return;
    if (e.target.closest('#pl-score, #pl-viewport, .at-surface, #alphatab')) close('sheet');
  }, true);
  window.addEventListener('popstate', () => {
    if (skipPop > 0) { skipPop--; return; }
    const top = stack.pop();
    if (top) close(top);
  });
}
