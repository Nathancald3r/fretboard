// The ☰ side drawer (library and setlists, reachable from every view) and the song
// search in the top bar.
import { listSongs, getValue, setValue } from './db.js';

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
  songs = (await listSongs()).map(({ id, title, artist, kind, lastOpened, added }) => ({ id, title, artist, kind, lastOpened, added }));
}

const matches = (s, q) => !q || `${s.title} ${s.artist}`.toLowerCase().includes(q);
const byRecent = (a, b) => (b.lastOpened || b.added) - (a.lastOpened || a.added);

function songRow(s, extra = '') {
  const cur = s.id === currentSongId() ? ' current' : '';
  return `<li class="dr-song${cur}" data-id="${escape(s.id)}">
    <a href="#song/${escape(s.id)}"><b>${escape(s.title)}</b><span>${escape(s.artist || '')}</span></a>${extra}</li>`;
}

function renderDrawer() {
  const q = $('dr-search').value.trim().toLowerCase();
  document.querySelectorAll('[data-dr-tab]').forEach((b) => b.classList.toggle('on', b.dataset.drTab === tab));
  const body = $('dr-body');
  if (tab === 'songs') {
    const list = songs.filter((s) => matches(s, q)).sort(byRecent);
    const add = openList || activeList;
    const target = setlists.find((l) => l.id === add);
    body.innerHTML = list.length
      ? `<ul class="dr-list">${list.map((s) => songRow(s, target ? `<button class="small ghost" data-add="${escape(s.id)}" title="Add to “${escape(target.name)}”">+</button>` : '')).join('')}</ul>`
      : `<p class="muted">${q ? 'No songs match.' : 'Your library is empty.'}</p>`;
    return;
  }
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
      <span class="row"><button class="small ghost" data-rename-set>Rename</button><button class="small ghost danger" data-delete-set>Delete</button></span></div>
    <h3 class="dr-title">${escape(list.name)}</h3>
    <div class="row">
      ${items.length ? `<a class="button small primary" href="#song/${items[0].id}" data-start-set>▶ Play from the top</a>` : ''}
      ${currentSongId() && !list.songIds.includes(currentSongId()) ? '<button class="small" data-add-current>+ Add the open song</button>' : ''}
    </div>
    <ol class="dr-list numbered">${items.map((s, i) => songRow(s, `<span class="dr-tools">
      <button class="small ghost" data-move="-1" data-i="${i}" title="Move up" ${i ? '' : 'disabled'}>↑</button>
      <button class="small ghost" data-move="1" data-i="${i}" title="Move down" ${i < items.length - 1 ? '' : 'disabled'}>↓</button>
      <button class="small ghost" data-remove="${i}" title="Remove from setlist">✕</button></span>`)).join('')}</ol>
    ${items.length ? '' : '<p class="muted small-text">Empty. Use + next to songs in the Songs tab, or open a song and add it here.</p>'}`;
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

export function openDrawer(show = true) {
  document.body.classList.toggle('drawer-open', show);
  $('drawer').setAttribute('aria-hidden', String(!show));
  if (show) {
    Promise.all([loadSongs(), loadSetlists()]).then(renderDrawer);
    setTimeout(() => $('dr-search').focus(), 50);
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
    const target = setlists.find((l) => l.id === (openList || activeList));
    if (target && !target.songIds.includes(Number(t.dataset.add))) { target.songIds.push(Number(t.dataset.add)); t.textContent = '✓'; await saveSetlists(); }
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

/* ---------- top bar search ---------- */

let results = [];
let picked = 0;

async function search() {
  const q = $('song-search').value.trim().toLowerCase();
  const box = $('search-results');
  if (!q) { box.hidden = true; return; }
  if (!songs.length) await loadSongs();
  results = songs.filter((s) => matches(s, q)).sort(byRecent).slice(0, 8);
  picked = 0;
  box.innerHTML = results.length
    ? results.map((s, i) => `<a href="#song/${s.id}" class="${i === picked ? 'on' : ''}"><b>${escape(s.title)}</b><span>${escape(s.artist || '')}</span></a>`).join('')
    : '<div class="muted">No songs match. Find more under Library → Find tabs online.</div>';
  box.hidden = false;
}

function closeSearch() {
  $('search-results').hidden = true;
  $('song-search').value = '';
  $('song-search').blur();
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
  $('dr-search').addEventListener('input', () => { if (tab !== 'songs') { tab = 'songs'; openList = null; } renderDrawer(); });

  const input = $('song-search');
  input.addEventListener('focus', () => { loadSongs(); });
  input.addEventListener('input', search);
  input.addEventListener('keydown', (e) => {
    const box = $('search-results');
    if (e.key === 'Escape') { closeSearch(); return; }
    if (!results.length || box.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      picked = (picked + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      [...box.children].forEach((a, i) => a.classList.toggle('on', i === picked));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      location.hash = `song/${results[picked].id}`;
      closeSearch();
    }
  });
  $('search-results').addEventListener('click', (e) => { if (e.target.closest('a')) closeSearch(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('search-results').hidden = true; });
  // "/" or Ctrl+K jumps to the search box, like Songsterr and Ultimate Guitar.
  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches?.('input, textarea, select, [contenteditable]');
    if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) {
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
