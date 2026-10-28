// Small pop-up menus (the library's ⋮, type, folder, + and helper menus). On a phone they sit at the
// bottom of the screen, like a sheet. Items: { k, label, hint, danger, check, disabled } or '-' (a line)
// or { stars: n } (a row of five stars, picked as 'star' with data-n) or { head, sub } (a title that does nothing).
// An item can also have icon: a key of ICONS.
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let el = null;

export function closeMenu() {
  if (!el) return;
  el.anchor?.setAttribute?.('aria-expanded', 'false');
  el.remove();
  el = null;
}

export const menuOpen = () => !!el;

// Small line icons for a menu's items ({ icon: 'folder' }), so the labels line up in one column.
const svg = (d) => `<svg class="mi" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ICONS = {
  setlist: svg('<path d="M4 6h11M4 12h11M4 18h6M18 14v6M15 17h6"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  share: svg('<path d="M12 15V4M8 8l4-4 4 4M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>'),
  chords: svg('<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>'),
  edit: svg('<path d="M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19z"/><path d="M14 7l3 3"/>'),
  text: svg('<path d="M5 6h14M5 12h14M5 18h9"/>'),
  version: svg('<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>'),
  split: svg('<path d="M12 3v6M12 9 6 15M12 9l6 6M6 15v6M18 15v6"/>'),
  archive: svg('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>'),
  restore: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>'),
  retry: svg('<path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5"/>'),
  ask: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
};

function item(it) {
  if (it === '-') return '<hr>';
  if (it.head !== undefined) return `<div class="menu-head"><b>${escape(it.head)}</b>${it.sub ? `<small>${escape(it.sub)}</small>` : ''}</div>`;
  if (it.stars !== undefined) {
    return `<div class="menu-stars" role="group" aria-label="Your ranking">${[1, 2, 3, 4, 5].map((n) => `<button data-m="star" data-n="${n}" class="star${n <= it.stars ? ' on' : ''}" title="${n} star${n > 1 ? 's' : ''}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>`;
  }
  const check = it.check === undefined ? '' : `<i class="menu-check" aria-hidden="true">${it.check ? '✓' : ''}</i>`;
  const icon = it.icon ? ICONS[it.icon] || '' : '';
  const role = it.check === undefined ? 'menuitem' : 'menuitemcheckbox" aria-checked="' + !!it.check;
  return `<button role="${role}" data-m="${escape(it.k)}" class="${it.danger ? 'danger' : ''}${check ? ' has-check' : ''}${icon ? ' has-icon' : ''}"${it.disabled ? ' disabled' : ''}>${check}${icon}<span>${escape(it.label)}${it.hint ? `<small>${escape(it.hint)}</small>` : ''}</span></button>`;
}

/** Opens a menu under an element (or at { x, y }); onPick(key, button). Pressing the same element again closes it. */
export function popMenu(at, items, onPick) {
  const same = el && at instanceof Element && el.anchor === at;
  closeMenu();
  if (same) return;
  el = document.createElement('div');
  el.className = 'card-menu' + (at instanceof Element ? '' : ' ctx-menu');
  el.setAttribute('role', 'menu');
  el.anchor = at instanceof Element ? at : null;
  el.innerHTML = items.filter(Boolean).map(item).join('');
  document.body.append(el);
  let x, y;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    x = r.right - el.offsetWidth > 8 && r.left + el.offsetWidth > innerWidth - 8 ? r.right - el.offsetWidth : r.left;
    y = r.bottom + 4;
    if (y + el.offsetHeight > innerHeight - 8) y = Math.max(8, r.top - el.offsetHeight - 4);
    at.setAttribute('aria-expanded', 'true');
  } else {
    ({ x, y } = at);
  }
  Object.assign(el.style, { left: Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8)) + 'px', top: Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8)) + 'px' });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b || b.disabled) return;
    closeMenu();
    onPick(b.dataset.m, b);
  });
  if (matchMedia('(pointer: fine)').matches) el.querySelector('button:not(:disabled)')?.focus();
}

document.addEventListener('pointerdown', (e) => {
  if (el && !e.target.closest('.card-menu') && !(el.anchor && el.anchor.contains(e.target)) && !e.target.closest('[data-act=menu]')) closeMenu();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el) { e.stopPropagation(); closeMenu(); } }, true);
window.addEventListener('hashchange', closeMenu);
