// The ☰ side drawer (library and setlists, reachable from every view) and the song
// search in the top bar.
import { listSongs, getValue, setValue } from './db.js';
import { chartType, CHART_LABEL, SORTS, filterSongs, folderNames, stars } from './songmeta.js';
import { loadFolders, addFolder, moveSong, renameFolder, deleteFolder, rateSong } from './folders.js';

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ACTIVE_KEY = 'fretboard-setlist';

let setlists = [];
let songs = [];
let tab = 'songs';
let folders = [];
let sortKey = 'recent';
let shut = new Set(); // folders collapsed in the Songs tab
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
  songs = (await listSongs()).map(({ id, title, artist, kind, lastOpened, added, rating, folder, practiceSeconds, data }) => ({
    id, title, artist, kind, lastOpened, added, rating, folder, practiceSeconds,
    data: kind === 'text' ? String(data).slice(0, 2000) : undefined, // just enough to tell a tab from a chord chart
  }));
  folders = await loadFolders();
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
    const list = filterSongs(songs, { text: q }).sort(SORTS[sortKey]);
    const add = openList || activeList;
    const target = setlists.find((l) => l.id === add);
    const names = folderNames(songs, folders);
    const row = (s) => songRow(s, `<span class="dr-tools">
      <button class="small ghost rate-btn" data-rate="${escape(s.id)}" title="Your ranking: press to raise it (clears after five)">${s.rating ? '★' + s.rating : '☆'}</button>
      <label class="folder-pick" title="Move to a folder">📁<select data-folder-for="${escape(s.id)}" aria-label="Folder">
        <option value="">No folder</option>${names.map((n) => `<option${n === s.folder ? ' selected' : ''}>${escape(n)}</option>`).join('')}<option value="__new__">New folder…</option></select></label>
      ${target ? `<button class="small ghost" data-add="${escape(s.id)}" title="Add to “${escape(target.name)}”">+</button>` : ''}</span>`);
    const section = (name, items) => {
      const isShut = shut.has(name);
      return `<div class="dr-folder" data-folder="${escape(name)}">
        <div class="dr-folder-head"><button class="ghost small" data-toggle-folder="${escape(name)}" aria-expanded="${!isShut}">${isShut ? '▸' : '▾'} 📁 <b>${escape(name)}</b> <span class="muted">${items.length}</span></button>
          <span class="dr-tools"><button class="small ghost" data-rename-folder="${escape(name)}" title="Rename folder">✎</button><button class="small ghost danger" data-delete-folder="${escape(name)}" title="Delete folder (songs stay)">✕</button></span></div>
        ${isShut ? '' : `<ul class="dr-list">${items.map(row).join('') || '<li class="muted small-text">Empty</li>'}</ul>`}</div>`;
    };
    const unfiled = list.filter((s) => !s.folder);
    body.innerHTML = `
      <div class="row dr-controls">
        <label class="small-text">Order <select data-dr-sort>
          ${[['recent', 'Recent'], ['rating', 'My ranking'], ['title', 'Title'], ['practiced', 'Most practiced']].map(([k, l]) => `<option value="${k}"${k === sortKey ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <form id="dr-newfolder" class="row"><input id="dr-newfolder-name" placeholder="New folder" maxlength="40" required aria-label="New folder name"><button class="small">+ Folder</button></form>
      </div>
      ${names.map((n) => section(n, list.filter((s) => s.folder === n))).filter((h, i) => !q || list.some((s) => s.folder === names[i])).join('')}
      ${unfiled.length ? `${names.length ? '<h3 class="dr-title">No folder</h3>' : ''}<ul class="dr-list">${unfiled.map(row).join('')}</ul>` : ''}
      ${list.length || names.length ? '' : `<p class="muted">${q ? 'No songs match.' : 'No songs yet. Use “Find tabs online” on the Songs page to add one.'}</p>`}`;
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
  if (t.dataset.rate) {
    const s = songs.find((x) => x.id === Number(t.dataset.rate));
    await rateSong(s.id, ((s.rating || 0) + 1) % 6);
    await loadSongs(); renderDrawer();
    return;
  }
  if (t.dataset.toggleFolder) { shut.has(t.dataset.toggleFolder) ? shut.delete(t.dataset.toggleFolder) : shut.add(t.dataset.toggleFolder); renderDrawer(); return; }
  if (t.dataset.renameFolder) {
    const to = prompt('Folder name', t.dataset.renameFolder);
    if (to?.trim()) { await renameFolder(t.dataset.renameFolder, to); await loadSongs(); renderDrawer(); }
    return;
  }
  if (t.dataset.deleteFolder) {
    if (confirm(`Delete the folder “${t.dataset.deleteFolder}”? The songs stay in your library.`)) { await deleteFolder(t.dataset.deleteFolder); await loadSongs(); renderDrawer(); }
    return;
  }
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
  results = filterSongs(songs, { text: q }).sort(byRecent).slice(0, 8);
  picked = 0;
  box.innerHTML = (results.length
    ? results.map((s, i) => `<div class="sr${i === picked ? ' on' : ''}"><a href="#song/${s.id}"><b>${escape(s.title)}</b><span>${escape(CHART_LABEL[chartType(s)])}${s.artist ? ' · ' + escape(s.artist) : ''}</span></a><button class="small ghost" data-sr-add="${s.id}" title="Add to a setlist" aria-label="Add ${escape(s.title)} to a setlist">+</button></div>`).join('')
    : '<div class="muted sr-none">No songs match.</div>')
    + `<a class="sr-find" href="#library" data-find="${escape($('song-search').value.trim())}">🔎 Find “${escape($('song-search').value.trim())}” online…</a>`;
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
  $('drawer').addEventListener('change', async (e) => {
    if (e.target.matches('[data-dr-sort]')) { sortKey = e.target.value; renderDrawer(); return; }
    const id = e.target.dataset.folderFor;
    if (!id) return;
    let name = e.target.value;
    if (name === '__new__') { name = (prompt('New folder name') || '').trim(); if (name) await addFolder(name); }
    await moveSong(Number(id), name);
    await loadSongs(); renderDrawer();
  });
  $('drawer').addEventListener('submit', async (e) => {
    if (e.target.id === 'dr-newfolder') {
      e.preventDefault();
      await addFolder($('dr-newfolder-name').value);
      await loadSongs(); renderDrawer();
      return;
    }
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
      box.querySelectorAll('.sr').forEach((a, i) => a.classList.toggle('on', i === picked));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      location.hash = `song/${results[picked].id}`;
      closeSearch();
    }
  });
  $('search-results').addEventListener('click', async (e) => {
    const add = e.target.closest('[data-sr-add]');
    if (add) { await addToSetlist(Number(add.dataset.srAdd)); add.textContent = '✓'; return; }
    const find = e.target.closest('[data-find]');
    if (find) { e.preventDefault(); const q = find.dataset.find; closeSearch(); window.dispatchEvent(new CustomEvent('findonline', { detail: q })); return; }
    if (e.target.closest('a')) closeSearch();
  });
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
