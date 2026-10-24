// The ☰ side drawer, reachable from every view: the song library (drawn by app.js) and setlists.
import { listSongs, getSong, getValue, setValue } from './db.js';
import { dateText } from './sharecore.js';

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ACTIVE_KEY = 'fretboard-setlist';

let setlists = [];
let songs = [];
let tab = 'songs';
let openList = null; // setlist id shown in the drawer
let activeList = null; // setlist being played through (id)
try { activeList = Number(localStorage.getItem(ACTIVE_KEY)) || null; } catch { /* ignore */ }

const currentSongId = () => {
  const [name, id] = location.hash.slice(1).split('/');
  return name === 'song' ? Number(id) : null;
};

async function loadSetlists() {
  setlists = (await getValue('setlists')) || [];
}

async function saveSetlists() {
  await setValue('setlists', setlists);
  renderDrawer();
  window.dispatchEvent(new Event('setlistschange'));
}

async function loadSongs() {
  // Only the fields the lists need (the score bytes stay out of memory here).
  songs = (await listSongs()).map(({ id, title, artist }) => ({ id, title, artist }));
}

function songRow(s, extra = '') {
  const cur = s.id === currentSongId() ? ' current' : '';
  return `<li class="dr-song${cur}" data-id="${escape(s.id)}">
    <a href="#song/${escape(s.id)}"><b>${escape(s.title)}</b><span>${escape(s.artist || '')}</span></a>${extra}</li>`;
}

function renderDrawer() {
  document.querySelectorAll('[data-dr-tab]').forEach((b) => b.classList.toggle('on', b.dataset.drTab === tab));
  $('dr-songs').hidden = tab !== 'songs';
  $('dr-body').hidden = tab === 'songs';
  if (tab === 'songs') { window.dispatchEvent(new Event('fblibrary')); return; } // app.js draws the library
  const body = $('dr-body');
  const list = setlists.find((l) => l.id === openList);
  if (!list) {
    body.innerHTML = `
      <form id="dr-new" class="row"><input id="dr-new-name" placeholder="New setlist name" maxlength="60" required><button class="small primary">Create</button></form>
      <ul class="dr-list">${setlists.map((l) => `<li class="dr-set${l.id === activeList ? ' current' : ''}" data-set="${escape(l.id)}">
        <a href="#" data-open-set="${escape(l.id)}"><b>${escape(l.name)}</b><span>${l.songIds.length} song${l.songIds.length === 1 ? '' : 's'}</span></a></li>`).join('')}</ul>
      ${setlists.length ? '' : '<p class="muted small-text">Setlists keep songs in the order you want to practise or play them. In a setlist the player shows Previous / Next.</p>'}`;
    return;
  }
  const items = list.songIds.map((id) => songs.find((s) => s.id === id)).filter(Boolean);
  body.innerHTML = `
    <div class="row spread"><button class="small ghost" data-back>‹ Setlists</button>
      <span class="row"><button class="small ghost" data-share-set title="Send all its songs, in order and in their keys, to MusicStand or anyone">⤴ Share</button><button class="small ghost" data-rename-set>Rename</button><button class="small ghost danger" data-delete-set>Delete</button></span></div>
    <h3 class="dr-title">${escape(list.name)}</h3>
    ${list.date ? `<p class="muted small-text dr-date">${escape(dateText(list.date))}</p>` : ''}
    <div class="row">
      ${items.length ? `<a class="button small primary" href="#song/${items[0].id}" data-start-set>▶ Play from the top</a>` : ''}
      ${currentSongId() && !list.songIds.includes(currentSongId()) ? '<button class="small" data-add-current>+ Add the open song</button>' : ''}
    </div>
    <ol class="dr-list numbered">${items.map((s, i) => songRow(s, `<span class="dr-tools">
      <button class="small ghost" data-move="-1" data-i="${i}" title="Move up" ${i ? '' : 'disabled'}>↑</button>
      <button class="small ghost" data-move="1" data-i="${i}" title="Move down" ${i < items.length - 1 ? '' : 'disabled'}>↓</button>
      <button class="small ghost" data-remove="${i}" title="Remove from setlist">✕</button></span>`)).join('')}</ol>
    ${items.length ? '' : '<p class="muted small-text">Empty. Use a song’s ⋮ menu in the Songs tab (Add to setlist), or open a song and add it here.</p>'}`;
}

function setActive(id) {
  activeList = id;
  try { localStorage.setItem(ACTIVE_KEY, id ? String(id) : ''); } catch { /* ignore */ }
  window.dispatchEvent(new Event('setlistschange'));
}

/** For the player: where this song sits in the active setlist, or null. */
export function setlistContext(songId) {
  const list = setlists.find((l) => l.id === activeList);
  if (!list) return null;
  const i = list.songIds.indexOf(songId);
  if (i === -1) return null;
  return { name: list.name, index: i, count: list.songIds.length, prevId: list.songIds[i - 1] ?? null, nextId: list.songIds[i + 1] ?? null };
}

export function leaveSetlist() { setActive(null); }

/** The setlist the Add to setlist item adds to: the one open or played through ('' when it will start one). */
export function setlistTargetName() {
  const t = setlists.find((l) => l.id === (openList || activeList)) || (setlists.length === 1 ? setlists[0] : null);
  return t?.name || '';
}

const toast = (msg) => window.dispatchEvent(new CustomEvent('fbtoast', { detail: msg }));

/** The + buttons: adds to the setlist you have open or are playing through; with none yet, starts “My setlist”. */
export async function addToSetlist(songId) {
  if (!setlists.length) await loadSetlists();
  let target = setlists.find((l) => l.id === (openList || activeList));
  if (!target) target = setlists.length === 1 ? setlists[0] : null;
  if (!target) {
    target = { id: Date.now(), name: 'My setlist', songIds: [] };
    setlists.push(target);
  }
  const song = songs.find((s) => s.id === songId);
  if (target.songIds.includes(songId)) { toast(`Already in “${target.name}”.`); return; }
  target.songIds.push(songId);
  await saveSetlists();
  toast(`Added ${song ? `“${song.title}” ` : ''}to “${target.name}”.`);
}

/** A setlist received (a shared .fretboard file or setlist zip): saved beside yours. Returns its name. */
export async function addSetlist({ name, date = '', songIds }) {
  await loadSetlists();
  let n = name;
  for (let i = 2; setlists.some((l) => l.name === n); i++) n = `${name} (${i})`;
  setlists.push({ id: Date.now() + setlists.length, name: n, songIds: [...new Set(songIds)], ...(date ? { date } : {}) });
  await saveSetlists();
  return n;
}

/** focus: put the cursor in the song search (on a phone only when asked: the keyboard would cover the list). */
export function openDrawer(show = true, { focus = false, songs: toSongs = false } = {}) {
  document.body.classList.toggle('drawer-open', show);
  $('drawer').setAttribute('aria-hidden', String(!show));
  if (show) {
    if (toSongs || focus) { tab = 'songs'; openList = null; }
    Promise.all([loadSongs(), loadSetlists()]).then(renderDrawer);
    if (focus || matchMedia('(pointer: fine)').matches) setTimeout(() => { $('find-query').focus(); $('find-query').select(); }, 60);
  }
}

async function onDrawerClick(e) {
  const t = e.target.closest('button, a, [data-dr-tab]');
  if (!t) return;
  if (t.dataset.drTab) { tab = t.dataset.drTab; openList = null; renderDrawer(); return; }
  const list = setlists.find((l) => l.id === openList);
  if (t.dataset.openSet) { e.preventDefault(); openList = Number(t.dataset.openSet); renderDrawer(); return; }
  if (t.hasAttribute('data-back')) { openList = null; renderDrawer(); return; }
  if (t.dataset.add) {
    await addToSetlist(Number(t.dataset.add));
    return;
  }
  if (t.hasAttribute('data-start-set')) { setActive(list.id); openDrawer(false); return; }
  if (t.closest('.dr-song') && t.tagName === 'A') {
    // Opening a song from a setlist plays through that setlist.
    if (list) setActive(list.id);
    openDrawer(false);
    return;
  }
  if (!list) return;
  if (t.hasAttribute('data-add-current')) { list.songIds.push(currentSongId()); await saveSetlists(); return; }
  if (t.dataset.move) {
    const i = Number(t.dataset.i);
    const j = i + Number(t.dataset.move);
    [list.songIds[i], list.songIds[j]] = [list.songIds[j], list.songIds[i]];
    await saveSetlists();
    return;
  }
  if (t.dataset.remove) { list.songIds.splice(Number(t.dataset.remove), 1); await saveSetlists(); return; }
  if (t.hasAttribute('data-share-set')) {
    const items = (await Promise.all(list.songIds.map((id) => getSong(id)))).filter(Boolean);
    if (!items.length) { toast('This setlist has no songs to share yet.'); return; }
    const { shareSetlist } = await import('./share.js');
    await shareSetlist(list, items, { saveDate: async (date) => { list.date = date || undefined; await saveSetlists(); } });
    return;
  }
  if (t.hasAttribute('data-rename-set')) {
    const name = prompt('Setlist name', list.name);
    if (name?.trim()) { list.name = name.trim(); await saveSetlists(); }
    return;
  }
  if (t.hasAttribute('data-delete-set')) {
    if (!confirm(`Delete the setlist “${list.name}”? The songs stay in your library.`)) return;
    setlists = setlists.filter((l) => l !== list);
    if (activeList === list.id) setActive(null);
    openList = null;
    await saveSetlists();
  }
}

export function initDrawer() {
  $('menu-btn').addEventListener('click', () => openDrawer(!document.body.classList.contains('drawer-open')));
  $('drawer-scrim').addEventListener('click', () => openDrawer(false));
  $('dr-close').addEventListener('click', () => openDrawer(false));
  $('drawer').addEventListener('click', onDrawerClick);
  $('drawer').addEventListener('submit', async (e) => {
    if (e.target.id !== 'dr-new') return;
    e.preventDefault();
    const name = $('dr-new-name').value.trim();
    if (!name) return;
    const list = { id: Date.now(), name, songIds: currentSongId() ? [currentSongId()] : [] };
    setlists.push(list);
    openList = list.id;
    setActive(list.id);
    await saveSetlists();
  });
  // "/" or Ctrl+K: the library with the cursor in its search, from anywhere (like Songsterr and Ultimate Guitar).
  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches?.('input, textarea, select, [contenteditable]');
    if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      openDrawer(true, { focus: true });
    } else if (e.key === 'Escape' && document.body.classList.contains('drawer-open') && !document.querySelector('.card-menu')) {
      openDrawer(false);
    }
  });
  window.addEventListener('hashchange', () => { if (document.body.classList.contains('drawer-open')) renderDrawer(); });
  loadSetlists().then(() => window.dispatchEvent(new Event('setlistschange')));
  // Songs or setlists arrived from another device.
  window.addEventListener('librarysynced', () => Promise.all([loadSongs(), loadSetlists()]).then(() => {
    if (document.body.classList.contains('drawer-open')) renderDrawer();
    window.dispatchEvent(new Event('setlistschange'));
  }));
}
