// Small pop-up menus (the library's ⋮, type, folder, + and helper menus). On a phone they sit at the
// bottom of the screen, like a sheet. Items: { k, label, hint, danger, check, disabled } or '-' (a line)
// or { stars: n } (a row of five stars, picked as 'star' with data-n).
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let el = null;

export function closeMenu() {
  if (!el) return;
  el.anchor?.setAttribute?.('aria-expanded', 'false');
  el.remove();
  el = null;
}

export const menuOpen = () => !!el;

function item(it) {
  if (it === '-') return '<hr>';
  if (it.stars !== undefined) {
    return `<div class="menu-stars" role="group" aria-label="Your ranking">${[1, 2, 3, 4, 5].map((n) => `<button data-m="star" data-n="${n}" class="star${n <= it.stars ? ' on' : ''}" title="${n} star${n > 1 ? 's' : ''}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>`;
  }
  const check = it.check === undefined ? '' : `<i class="menu-check" aria-hidden="true">${it.check ? '✓' : ''}</i>`;
  const role = it.check === undefined ? 'menuitem' : 'menuitemcheckbox" aria-checked="' + !!it.check;
  return `<button role="${role}" data-m="${escape(it.k)}" class="${it.danger ? 'danger' : ''}${check ? ' has-check' : ''}"${it.disabled ? ' disabled' : ''}>${check}<span>${escape(it.label)}${it.hint ? `<small>${escape(it.hint)}</small>` : ''}</span></button>`;
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
