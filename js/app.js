// App shell: routing, the library (in the ☰ drawer), file import, text-tab editor and the Quick Song Importer.
import { listSongs, getSong, putSong, deleteSong, updateSong, getValue, setValue } from './db.js';
import { initPlayer, openPlayer, closePlayer } from './player.js';
import { askVersion } from './version.js';
import { initText, openText, closeText, cleanTabText, editorText, fromEditor } from './texttab.js';
import { openSheet, closeSheet } from './sheetview.js';
import { initMetronome, stopMetronome } from './metronome.js';
import { initLayers, resetLayers } from './layers.js';
import { initTuner, stopTuner } from './tuner.js';
import { renderLog } from './log.js';
import { renderPractice, trackDrill } from './practicehub.js';
import { initVocal, stopVocal } from './vocal.js';
import { chartType, CHART_LABEL, SORTS, filterSongs, folderNames, splitGroups } from './songmeta.js';
import { loadFolders, moveSong, rateSong, addFolder, renameFolder, deleteFolder } from './folders.js';
import { recoverPendingSessions } from './practice.js';
import { DEMOS } from './demos.js';
import { initScales, renderScales } from './scales.js';
import { initQuickImport, watchDownloads, showReady, ugHelper, openInCollector, watchRuns, helperPossible, startHelper, showStatus, setupUG, TAB_FILE } from './quickimport.js';
import { sourceUrl } from './tabsources.js';
import { initKeys, renderKeys } from './keys.js';
import { initDrawer, openDrawer, addToSetlist, addSetlist, setlistTargetName } from './drawer.js';
import { popMenu } from './menu.js';
import { initSync } from './syncui.js';
import { parseFilename } from './tabinfo.js';
import { initBulk, selecting, isPicked, toggle as togglePick, drawBar, keyNote } from './bulk.js';
import { soundFor } from './sounds.js';
import { readFretboardFile, readZip, readSetlistText, pdfAttachment } from './sharecore.js';

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const VIEWS = ['library', 'player', 'text', 'sheet', 'practice', 'scales', 'keys', 'tools', 'vocal', 'log'];
const PRACTICE_VIEWS = ['practice', 'scales', 'keys', 'tools', 'vocal']; // all highlight the Practice tab
const SONG_VIEWS = ['player', 'text', 'sheet']; // a song open: the Songs tab
let currentView = null;
let editingId = null;

function toast(message, ms = 3000) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------- routing ---------- */

// Songs (#library) opens the song you had open last; the library itself is in the ☰ drawer.
const LAST_SONG = 'fretboard-last-song';
const lastSongId = () => { try { return Number(localStorage.getItem(LAST_SONG)) || null; } catch { return null; } };

async function route() {
  const [name, arg] = (location.hash.slice(1) || 'library').split('/');
  let view = VIEWS.includes(name) ? name : 'library';
  let song = null;
  let editing = false;
  if (view === 'library' && name !== 'song' && name !== 'edit') {
    const last = lastSongId();
    const to = last && await getSong(last) ? last
      : (await listSongs()).filter((s) => chartType(s) !== 'exercise').sort(SORTS.recent)[0]?.id; // deleted: the latest one
    if (to) { location.replace(`#song/${to}`); return; }
  }
  if (name === 'song' || name === 'edit') {
    try { if (await getSong(Number(arg))) localStorage.setItem(LAST_SONG, String(Number(arg))); } catch { /* fine */ }
  }
  if (name === 'song') {
    song = await getSong(Number(arg));
    const sub = location.hash.split('/')[2];
    const asText = song?.kind === 'text' && sub !== 'play';
    view = !song ? 'library' : song.kind === 'sheet' || (sub === 'sheet' && song.sheets?.length) ? 'sheet' : asText ? 'text' : 'player';
  } else if (name === 'edit') { // edit mode: the tab editor instead of the practice tools
    song = await getSong(Number(arg));
    editing = !!song && chartType(song) !== 'chords' && song.kind !== 'tex' && song.kind !== 'sheet';
    view = editing ? 'player' : song ? (song.kind === 'sheet' ? 'sheet' : song.kind === 'text' ? 'text' : 'player') : 'library';
  }
  document.body.classList.toggle('edit-mode', editing);

  resetLayers(); // sheets, menus, pop-ups and full screen never carry over to another page or song
  if (currentView === 'player') closePlayer(); // also when switching songs
  if (currentView === 'text') closeText();
  if (currentView === 'sheet') closeSheet();
  if (currentView === 'tools' && view !== 'tools') { stopTuner(); stopMetronome(); }
  if (currentView === 'vocal' && view !== 'vocal') stopVocal();
  trackDrill(view);
  currentView = view;

  VIEWS.forEach((v) => { $('view-' + v).hidden = v !== view; });
  document.body.classList.toggle('in-player', view === 'player');
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === view || (a.dataset.nav === 'library' && SONG_VIEWS.includes(view)) || (a.dataset.nav === 'practice' && PRACTICE_VIEWS.includes(view))));

  if (view === 'log') renderLog();
  if (view === 'practice') renderPractice();
  if (view === 'scales') renderScales();
  if (view === 'keys') renderKeys();
  if (view === 'player') { await openPlayer(song); if (editing) window.dispatchEvent(new Event('fbeditmode')); }
  if (view === 'text') openText(song);
  if (view === 'sheet') openSheet(song, Number(location.hash.split('/')[3]) || 0);
  if (view !== 'text') window.scrollTo(0, 0);
}

/* ---------- library (the ☰ drawer's Songs tab) ---------- */

// One list, A–Z by title, filtered by the search, a song type and a folder ("All songs" holds every song).
let chartFilter = 'all';
let folderFilter = 'all'; // 'all' | '' (no folder) | a folder's name
let folderList = [];
let lastAll = [];
let libSongs = [];
let libNames = [];
const TYPES = [['all', 'All types'], ['pro', 'Pro tabs'], ['tab', 'Text tabs'], ['chords', 'Chord charts'], ['sheet', 'Sheet music']];
const folderLabel = (f) => (f === 'all' ? 'All songs' : f === '' ? 'No folder' : f);
const openSongId = () => { const [n, id] = location.hash.slice(1).split('/'); return n === 'song' || n === 'edit' ? Number(id) : null; };
const initial = (t) => { const c = String(t || '').trim().replace(/^(the|a)\s+/i, '').charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; };
const drawerOpen = () => document.body.classList.contains('drawer-open');

async function renderLibrary() {
  const all = await listSongs();
  lastAll = all;
  folderList = await loadFolders();
  const songsOnly = all.filter((s) => chartType(s) !== 'exercise');
  libNames = folderNames(songsOnly, folderList);
  if (folderFilter !== 'all' && folderFilter !== '' && !libNames.includes(folderFilter)) folderFilter = 'all';
  const q = $('find-query').value.trim();
  const shown = filterSongs(all, { chart: chartFilter, folder: folderFilter });
  libSongs = filterSongs(shown, { text: q }).sort(SORTS.title);
  $('lib-folder-btn').innerHTML = `📁 <b>${escape(folderLabel(folderFilter))}</b> <span class="muted">${shown.length}</span> ▾`;
  $('lib-folder-btn').title = 'Folders';
  $('lib-type-chip').hidden = chartFilter === 'all';
  $('lib-type-chip').textContent = `${TYPES.find(([k]) => k === chartFilter)?.[1] || ''} ✕`;
  $('lib-type-chip').title = 'Show every type';
  $('lib-type-btn').classList.toggle('dot', chartFilter !== 'all');
  renderTidy(all);
  showReady();

  const cur = openSongId();
  const letters = !q && libSongs.length > 12;
  let letter = '';
  $('library-list').innerHTML = libSongs.map((s) => {
    const type = chartType(s);
    const L = initial(s.title);
    const head = letters && L !== letter ? `<li class="lib-letter" aria-hidden="true">${L}</li>` : '';
    letter = L;
    const mine = keyNote(s);
    return `${head}<li class="lib-row${s.id === cur ? ' current' : ''}${isPicked(s.id) ? ' picked' : ''}" data-id="${escape(s.id)}" data-type="${type}"${s.parts?.length ? ' data-parts="1"' : ''}>
      ${selecting() ? `<input type="checkbox" class="lib-check" tabindex="-1" aria-label="Select ${escape(s.title)}"${isPicked(s.id) ? ' checked' : ''}>` : ''}
      <a href="#song/${escape(s.id)}"><b>${escape(s.title)}</b><span>${s.artist ? escape(s.artist) + ' · ' : ''}${escape(CHART_LABEL[type])}${s.chordSheet && type !== 'chords' ? ' + chords' : ''}</span>${mine ? `<span class="lib-mykey">♪ ${escape(mine)}</span>` : ''}</a>
      ${s.rating ? `<span class="lib-stars" title="Your ranking">★${s.rating}</span>` : ''}
      <button class="icon-btn small lib-more" data-act="menu" aria-label="More for ${escape(s.title)}" aria-haspopup="menu">⋮</button></li>`;
  }).join('') || `<li class="lib-empty">${q
    ? `<p>“${escape(q)}” isn’t in your library${shown.length < songsOnly.length ? ' (with this filter)' : ''}.</p><div class="row">${helperPossible() ? '<button class="primary small" data-qi="quick" title="The UG helper finds it on Ultimate Guitar, saves it and adds it here">Quick add</button>' : ''}<button class="${helperPossible() ? 'ghost' : 'primary'} small" data-qi="manual" title="Opens the Ultimate Guitar search: download the file yourself">${helperPossible() ? 'Manual' : 'Find on Ultimate Guitar'}</button></div>`
    : songsOnly.length ? '<p class="muted">No songs here.</p>' : '<p class="muted">No songs yet. Type a song above to get it from Ultimate Guitar, or drop a file here.</p>'}</li>`;
  drawBar();
}

// The folder menu: which folder you're in, and making, renaming and deleting folders.
function folderMenu() {
  const count = (f) => filterSongs(lastAll, { folder: f }).length;
  const real = folderFilter && folderFilter !== 'all';
  popMenu($('lib-folder-btn'), [
    { k: 'f:all', label: 'All songs', hint: `${count('all')} songs`, check: folderFilter === 'all' },
    { k: 'f:none', label: 'No folder', hint: `${count('')} songs`, check: folderFilter === '' },
    ...libNames.map((n, i) => ({ k: `f:${i}`, label: n, hint: `${count(n)} songs`, check: folderFilter === n })),
    '-',
    { k: 'new', label: 'New folder…' },
    real ? { k: 'rename', label: `Rename “${folderFilter}”…` } : null,
    real ? { k: 'delete', label: `Delete “${folderFilter}”…`, hint: 'Its songs stay in All songs', danger: true } : null,
  ], async (k) => {
    if (k.startsWith('f:')) { const v = k.slice(2); folderFilter = v === 'all' ? 'all' : v === 'none' ? '' : libNames[Number(v)]; renderLibrary(); return; }
    if (k === 'new') {
      const f = await ask({ title: 'New folder', ok: 'Create', fields: { title: '', artist: '' }, single: true });
      const name = f?.title.trim();
      if (name) { await addFolder(name); folderFilter = name; renderLibrary(); }
    } else if (k === 'rename') {
      const f = await ask({ title: 'Rename folder', ok: 'Save', fields: { title: folderFilter, artist: '' }, single: true });
      const name = f?.title.trim();
      if (name && name !== folderFilter) { await renameFolder(folderFilter, name); folderFilter = name; renderLibrary(); }
    } else if (k === 'delete') {
      if (!(await ask({ title: `Delete the folder “${folderFilter}”?`, text: 'Its songs stay in your library.', ok: 'Delete' }))) return;
      await deleteFolder(folderFilter);
      folderFilter = 'all';
      renderLibrary();
    }
  });
}

function typeMenu() {
  popMenu($('lib-type-btn'), TYPES.map(([k, label]) => ({ k, label, check: chartFilter === k })), (k) => { chartFilter = k; renderLibrary(); });
}

/* ---------- combining songs that older imports split up ---------- */

let undoCombine = null; // what the last Combine changed, until the library is left

function renderTidy(all) {
  const box = $('lib-tidy');
  const groups = splitGroups(all);
  if (undoCombine) {
    box.innerHTML = '<span></span><button class="small ghost" data-tidy="undo">Undo</button><button class="small ghost" data-tidy="ok">OK</button>';
    box.firstChild.textContent = undoCombine.text;
  } else if (groups.length) {
    const g = groups[0];
    box.innerHTML = '<span></span><button class="small primary" data-tidy="combine">Combine</button>';
    box.firstChild.textContent = `“${g.title}” is split into ${g.parts.length + (g.base ? 1 : 0)} entries (${g.parts.map((p) => p.name).join(', ')}). Combine them into one song?${groups.length > 1 ? ` ${groups.length - 1} more song${groups.length > 2 ? 's' : ''} after this.` : ''}`;
  }
  box.hidden = !undoCombine && !groups.length;
}

async function combineSplit() {
  const g = splitGroups(await listSongs())[0];
  if (!g) return;
  const sheets = g.parts.map(({ song, name }) => {
    return { name, program: partProgram(name), fileName: song.fileName || '', data: song.data };
  });
  const undo = { removed: g.parts.map((p) => p.song), text: `Combined “${g.title}” into one song.` };
  if (g.base) {
    undo.base = { id: g.base.id, sheets: g.base.sheets };
    await updateSong(g.base.id, { sheets: [...(g.base.sheets || []), ...sheets] });
  } else {
    const { song } = g.parts[0];
    undo.created = await putSong({ kind: 'sheet', title: g.title, artist: g.artist, data: sheets[0].data, fileName: sheets[0].fileName, sheets, ...(song.folder ? { folder: song.folder } : {}), added: Date.now() });
  }
  for (const s of undo.removed) await deleteSong(s.id);
  undoCombine = undo;
  renderLibrary();
}

async function undoCombineSplit() {
  const u = undoCombine;
  undoCombine = null;
  if (!u) return;
  for (const s of u.removed) await putSong(s); // back with their own ids
  if (u.base) await updateSong(u.base.id, { sheets: u.base.sheets });
  if (u.created) await deleteSong(u.created);
  toast('Undone: the separate entries are back.');
  renderLibrary();
}

async function onLibraryClick(e) {
  const qi = e.target.closest('[data-qi]');
  if (qi) { findSong(qi.dataset.qi); return; }
  const row = e.target.closest('.lib-row');
  if (!row) return;
  if (selecting()) { e.preventDefault(); togglePick(Number(row.dataset.id)); return; } // picking songs: a tap ticks it
  if (e.target.closest('[data-act=menu]')) { openCardMenu(row, null); return; }
  if (e.target.closest('a')) openDrawer(false); // the song opens (its link)
}

async function cardAct(act, id) {
  const song = await getSong(id);
  if (!song) return;
  if (act === 'edit') { location.hash = `edit/${id}`; return; }
  if (act === 'practice') { location.hash = `song/${id}`; return; }
  if (act === 'setlist') { await addToSetlist(id); return; }
  if (act === 'share') { (await import('./share.js')).shareSongs([song]); return; }
  if (act === 'folder') { folderPick(song); return; }
  if (act === 'open-tab') { location.hash = `song/${id}/tab`; return; }
  if (act === 'open-chords') { location.hash = `song/${id}/chords`; return; }
  if (act === 'version') { await askVersion(song); renderLibrary(); return; }
  if (act === 'combine-ask') { await setCombinePref('ask'); toast('You’ll be asked again when a tab of the same song comes in.'); return; }
  if (act === 'split') {
    for (const p of song.parts || []) {
      await putSong({ kind: 'text', title: `${song.title} (${p.name})`, artist: song.artist, data: p.data, fileName: p.fileName, added: Date.now() });
    }
    await updateSong(id, { parts: [], title: song.part ? `${song.title} (${song.part})` : song.title });
    toast('Split: each tab is its own song again.');
    renderLibrary();
    return;
  }
  if (act === 'delete') {
    const ok = await ask({ title: 'Delete from library?', text: `“${song.title}” will be removed. Your practice log keeps its history.`, ok: 'Delete' });
    if (!ok) return;
    await deleteSong(id);
    try { // it leaves its setlists too, so Next / Previous never point at a deleted song
      const lists = (await getValue('setlists')) || [];
      if (lists.some((l) => l.songIds.includes(id))) await setValue('setlists', lists.map((l) => ({ ...l, songIds: l.songIds.filter((x) => x !== id) })));
    } catch { /* ignore */ }
    toast(`Deleted “${song.title}”.`);
    renderLibrary();
    return true;
  } else if (act === 'rename') {
    if (song.kind === 'text') { openEditor(song); return; }
    const fields = await ask({ title: 'Rename', ok: 'Save', fields: { title: song.title, artist: song.artist || '' } });
    if (!fields) return;
    await updateSong(id, { title: fields.title.trim() || song.title, artist: fields.artist.trim() });
    renderLibrary();
  }
}

// In-page replacement for confirm()/prompt(). Resolves false/null on cancel,
// true for a plain confirmation, or the edited { title, artist }.
function ask({ title, text = '', ok = 'OK', fields = null, single = false }) {
  const dialog = $('ask-dialog');
  $('ask-title').textContent = title;
  $('ask-text').textContent = text;
  $('ask-text').hidden = !text;
  $('ask-ok').textContent = ok;
  $('ask-ok').classList.toggle('danger', ok === 'Delete');
  $('ask-fields').hidden = !fields;
  $('ask-artist').hidden = single;
  $('ask-name').placeholder = single ? 'Name' : 'Title';
  if (fields) { $('ask-name').value = fields.title; $('ask-artist').value = fields.artist; }
  dialog.returnValue = '';
  dialog.showModal();
  (fields ? $('ask-name') : $('ask-ok')).focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      if (dialog.returnValue !== 'ok') resolve(fields ? null : false);
      else resolve(fields ? { title: $('ask-name').value, artist: $('ask-artist').value } : true);
    }, { once: true });
  });
}

// ⋮ button, right-click and long-press on a song: setlist, folder, ranking, edit mode, version, rename, delete.
function openCardMenu(row, at) {
  const id = Number(row.dataset.id);
  const song = libSongs.find((s) => s.id === id);
  if (!song) return;
  const type = row.dataset.type;
  const editable = type !== 'chords' && type !== 'exercise';
  const list = setlistTargetName();
  popMenu(at || row.querySelector('[data-act=menu]'), [
    { k: 'setlist', label: list ? `Add to “${list}”` : 'Add to a setlist', hint: list ? '' : 'Starts “My setlist”' },
    { k: 'folder', label: 'Move to folder…', hint: song.folder || 'No folder' },
    { k: 'share', label: '⤴ Share…', hint: 'MusicStand, email, Nearby Share…' },
    { stars: song.rating || 0 },
    '-',
    song.chordSheet && (type === 'pro' || type === 'tab') ? { k: 'open-chords', label: 'Open the chord sheet', hint: 'Chords over the words' } : null,
    editable ? { k: 'edit', label: '✎ Edit mode', hint: 'Arrange bars, fix notes, match a recording' } : null,
    { k: 'version', label: '🎧 Version…', hint: 'Studio, live or cover' },
    row.dataset.parts ? { k: 'split', label: 'Split tabs apart', hint: 'One song for each tab again' } : null,
    type === 'text' && combinePref !== 'ask' ? { k: 'combine-ask', label: 'Ask before combining tabs', hint: `Now: always ${combinePref === 'yes' ? 'combine' : 'keep apart'}` } : null,
    { k: 'rename', label: song.kind === 'text' ? 'Edit' : 'Rename' },
    { k: 'delete', label: 'Delete', danger: true },
  ], async (k, b) => {
    if (k === 'star') { const n = Number(b.dataset.n); await rateSong(id, (song.rating || 0) === n ? 0 : n); return; } // the same star again clears it
    if (k === 'open-chords') openDrawer(false);
    cardAct(k, id);
  });
}

// Move to folder: the folders as a second menu, with New folder…
function folderPick(song) {
  const row = $('library-list').querySelector(`.lib-row[data-id="${song.id}"]`);
  popMenu(row?.querySelector('[data-act=menu]') || $('lib-folder-btn'), [
    { k: 'none', label: 'No folder', check: !song.folder },
    ...libNames.map((n, i) => ({ k: String(i), label: n, check: song.folder === n })),
    '-',
    { k: 'new', label: 'New folder…' },
  ], async (k) => {
    let name = k === 'none' ? '' : libNames[Number(k)];
    if (k === 'new') {
      const f = await ask({ title: 'New folder', ok: 'Create', fields: { title: '', artist: '' }, single: true });
      name = f?.title.trim() || '';
      if (!name) return;
      await addFolder(name);
    }
    await moveSong(song.id, name);
  });
}

function initCardMenu() {
  const list = $('library-list');
  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.lib-row');
    if (!row) return;
    e.preventDefault();
    openCardMenu(row, { x: e.clientX, y: e.clientY });
  });
  let timer = 0;
  let from = null;
  list.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.lib-row');
    if (!row || e.pointerType === 'mouse' || e.target.closest('button')) return;
    from = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => { list.dataset.held = '1'; openCardMenu(row, { x: from.x, y: from.y }); }, 550);
  });
  const stop = () => clearTimeout(timer);
  list.addEventListener('pointermove', (e) => { if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 10) stop(); });
  list.addEventListener('pointerup', stop);
  list.addEventListener('pointercancel', stop);
  list.addEventListener('click', (e) => { if (list.dataset.held) { delete list.dataset.held; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
}

/* ---------- import ---------- */

function readScoreInfo(bytes) {
  try {
    const score = window.alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes);
    return { title: score.title, artist: score.artist, ok: true };
  } catch {
    return { ok: false };
  }
}

// "OFFICIAL CHAMPION CHORDS & TABS by Bethel Music @ Ultimate-Guitar.Com" -> Champion / Bethel Music
function namesFromPdf(base, plain = false) {
  const pretty = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s).trim();
  const m = base.replace(/\s*@.*$/, '').match(/^(?:official\s+)?(.*?)\s+(?:chords?|tabs?)(?:\s*&\s*(?:chords?|tabs?))?\s+by\s+(.+)$/i);
  // another instrument's part gets its name in the title, so the parts sit side by side in the library
  const part = (base.match(/\b(bass|drums?|ukulele|piano|keys|keyboard|vocals?|acoustic|banjo|mandolin)\b/i) || [])[1];
  const tag = (t) => (part && !plain && !new RegExp(part, 'i').test(t) ? `${t} (${pretty(part)})` : t);
  if (m) return { title: tag(pretty(m[1])), artist: pretty(m[2]) };
  // "Song - Artist - Instrument", as tools/ug_collect.py names each track's PDF
  const d = base.replace(/\s*\(\d+\)$/, '').split(' - ');
  if (d.length === 3) return { title: plain ? d[0].trim() : `${d[0].trim()} (${d[2].trim()})`, artist: d[1].trim() };
  const title = base.replace(/\b(tab|chords?)\b|@.*$|[(\[]\d+[)\]]/gi, '').replace(/\s+/g, ' ').trim() || base;
  return { title: tag(pretty(title)), artist: '' };
}

// The instruments an Ultimate Guitar song is split into; each PDF becomes one track of a single song.
const PARTS = [
  ['Vocal', 53, /vocal|voice|sing/i], ['Acoustic Guitar', 25, /acoustic|nylon/i], ['Rhythm Guitar', 27, /rhythm/i],
  ['Lead Guitar', 29, /lead(?!\s*vocal)|electric/i], ['Piano', 0, /piano|keys|keyboard/i], ['Synth Pad', 89, /pad/i],
  ['Synth Bass', 38, /synth\s*bass/i], ['Synth Lead', 80, /synth/i], ['Bass', 34, /bass/i], ['Ukulele', 24, /uke/i],
  ['Drums', 0, /drum|shaker|percussion|tambourine|cajon|conga|bongo/i],
];

// How a part's PDF is written when it's percussion: 'kit' for a drum staff, or the one instrument
// on a one-line staff. null for everything else.
const drumKind = (name) => (/shaker|maraca/i.test(name) ? 'shaker' : /tambourine/i.test(name) ? 'tambourine' : /drum|percussion|cajon|conga|bongo/i.test(name) ? 'kit' : null);

// The instrument a PDF's name says it is: "Song - Artist - Synth Lead 2.pdf" (as ug_collect.py names them) -> "Synth Lead 2".
function partFromName(fileName) {
  const d = fileName.replace(/\.[^.]+$/, '').replace(/\s*\(\d+\)$/, '').split(' - ');
  return d.length >= 3 ? d[d.length - 1].trim() : '';
}

// The PARTS entry a name sounds like ("Synth Lead 2" -> Synth Lead), or -1.
const partIndex = (name) => PARTS.findIndex(([, , re]) => re.test(name));
// Its sound: the PARTS one, else whatever instrument the name says (a Banjo part is a banjo, not a piano).
function partProgram(name) {
  const k = partIndex(name);
  if (k >= 0) return PARTS[k][1];
  const sound = soundFor(name);
  return sound && !sound.drum ? sound[1] : 0;
}

function partDialog(html) {
  const dlg = document.createElement('dialog');
  dlg.className = 'parts-dialog';
  dlg.innerHTML = html;
  dlg.addEventListener('cancel', (e) => e.preventDefault()); // Esc doesn't drop the work; Cancel does
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

class Cancelled extends Error {}

// Step 1: read every PDF (a minute or two for a whole Ultimate Guitar song). Nothing is saved yet.
// Resolves to one item per PDF, or null when cancelled.
async function readParts(files, title) {
  const { pdfToTab } = await import('./pdftab.js');
  const { ugToAlphaTex } = await import('./ugtab.js');
  const dlg = partDialog(`<h2>Reading the PDFs</h2>
    <p class="muted small-text">You can keep using the computer. Nothing is added to your library until you check the result and press Create song.</p>
    <progress max="${files.length}" value="0"></progress><p class="parts-now small-text"></p>
    <div class="row"><button class="ghost" data-no>Cancel</button></div>`);
  // Cancel ends it at once: the PDF being read is closed under it, and nothing waits for it to notice
  let stop = false;
  const ctl = new AbortController();
  const cancelled = new Promise((_, bad) => ctl.signal.addEventListener('abort', () => bad(new Cancelled())));
  cancelled.catch(() => {});
  dlg.querySelector('[data-no]').addEventListener('click', () => { stop = true; ctl.abort(); });
  const items = files.map((file) => {
    const name = partFromName(file.name) || PARTS[Math.max(0, partIndex(file.name))][0];
    return { file, name, program: partProgram(name) };
  });
  // The lyrics come from the lead vocal: a backing vocal sings only some of the words (Trust In God's
  // "Backing Vocal" comes first by name, so the lead vocal's words were never read).
  const sung = (re) => items.findIndex((it) => re.test(it.name) && !/back|harmony|choir/i.test(it.name));
  const singer = [sung(/lead vocal|^vocals?$/i), sung(/vocal|voice|sing/i), items.findIndex((it) => /vocal|voice|sing/i.test(it.name))].find((k) => k >= 0) ?? 0;
  try {
    for (const [i, it] of items.entries()) {
      const say = (extra = '', done = 0) => {
        if (stop) throw new Cancelled();
        dlg.querySelector('progress').value = i + done; // done: the share of this part's pages read
        dlg.querySelector('.parts-now').textContent = `${i + 1} of ${items.length}: ${it.name}${extra}`;
      };
      say();
      try {
        const read = pdfToTab(await it.file.arrayBuffer(), (page, pages, line) => say(` · page ${page} of ${pages}${line ? ', ' + line : ''}`, (page - 1) / pages), { title, lyrics: i === singer, bass: /bass/i.test(it.name), drums: drumKind(it.name), signal: ctl.signal });
        read.catch(() => {});
        const r = await Promise.race([read, cancelled]);
        if (r.strips?.length) {
          it.strips = r.strips;
          it.bars = ugToAlphaTex(r.strips, { title, name: it.name, program: it.program })?.bars || 0;
        }
      } catch (err) {
        if (err instanceof Cancelled || stop) throw new Cancelled();
        console.error(err);
        it.error = true; // kept as sheet music, so the part isn't lost
      }
    }
    // A sung line with no words read (UG's Print cut them off, or they weren't made out): one more part is
    // read for its words, since UG prints the words under every part, and they fill those lines.
    const voc = items[singer];
    const wordless = voc?.strips?.some((st) => !st.lyr?.length && st.bars.some((b) => b.cols?.some((c) => c.notes?.length)));
    const spare = wordless && items.find((it, k) => k !== singer && it.strips && !it.strips.some((st) => st.score) && !drumKind(it.name) && !/vocal|voice|sing/i.test(it.name));
    if (spare) {
      dlg.querySelector('.parts-now').textContent = `Words: reading them from ${spare.name} too`;
      try {
        const read = pdfToTab(await spare.file.arrayBuffer(), () => { if (stop) throw new Cancelled(); }, { title, lyrics: true, bass: /bass/i.test(spare.name), signal: ctl.signal });
        read.catch(() => {});
        const r = await Promise.race([read, cancelled]);
        if (r.strips?.length) spare.strips = r.strips;
      } catch (err) {
        if (err instanceof Cancelled || stop) throw new Cancelled();
        console.error(err); // the song keeps the words it has
      }
    }
    return items;
  } catch (err) {
    if (err instanceof Cancelled) return null;
    throw err;
  } finally {
    dlg.close();
    dlg.remove();
  }
}

// Step 2: everything found, to check and fix before saving: names, instruments, which parts, order.
// Resolves to { title, artist, items } or null (cancelled).
function reviewParts(items, title, artist) {
  return new Promise((resolve) => {
    const opts = PARTS.map(([n], k) => `<option value="${k}">${n}</option>`).join('') + '<option value="-1">Other</option>';
    const dlg = partDialog(`<h2>Check before it’s added</h2>
      <p class="muted small-text">One song with a track per instrument. Rename anything that came out wrong, untick parts you don’t want, and use the arrows for the order (the first tab track opens first). Parts written as notes (piano, keys) are read note by note and play with the rest; one that can’t be read stays in the song as sheet music.</p>
      <div class="parts-meta"><label>Title <input data-f="title" maxlength="120"></label><label>Artist <input data-f="artist" maxlength="120"></label></div>
      <ol class="parts-list"></ol>
      <div class="row"><button class="primary" data-go>Create song</button><button class="ghost" data-no>Cancel</button></div>`);
    dlg.querySelector('[data-f=title]').value = title;
    dlg.querySelector('[data-f=artist]').value = artist;
    const list = dlg.querySelector('.parts-list');
    for (const it of items) {
      const li = document.createElement('li');
      li.className = 'parts-item';
      li.innerHTML = `<input type="checkbox" checked aria-label="Include this part">
        <input class="parts-label" maxlength="60" aria-label="Track name">
        <select aria-label="Instrument sound">${opts}</select>
        <span class="parts-badge"></span>
        <span class="parts-btns"><button class="ghost small" data-act="view" title="Open this PDF">View</button><button class="ghost small" data-act="up" title="Move up" aria-label="Move up">↑</button><button class="ghost small" data-act="down" title="Move down" aria-label="Move down">↓</button></span>`;
      li.item = it;
      li.querySelector('.parts-label').value = it.name;
      li.querySelector('select').value = String(partIndex(it.name));
      const badge = li.querySelector('.parts-badge');
      badge.textContent = it.strips ? `${it.strips.some((s) => s.score) ? 'Notes' : 'Tab'} · ${it.bars} bars` : it.error ? 'Couldn’t read: sheet music' : 'Sheet music';
      badge.classList.add(it.strips ? 'is-tab' : 'is-sheet');
      list.append(li);
    }
    const urls = [];
    const done = (v) => {
      urls.forEach((u) => setTimeout(() => URL.revokeObjectURL(u), 60000));
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const li = e.target.closest('.parts-item');
      if (act === 'view') { const u = URL.createObjectURL(li.item.file); urls.push(u); window.open(u, '_blank'); }
      else if (act === 'up' && li.previousElementSibling) li.previousElementSibling.before(li);
      else if (act === 'down' && li.nextElementSibling) li.nextElementSibling.after(li);
      else if (e.target.closest('[data-go]')) {
        const chosen = [...list.children].filter((el) => el.querySelector('[type=checkbox]').checked).map((el) => {
          const k = Number(el.querySelector('select').value);
          return { ...el.item, name: el.querySelector('.parts-label').value.trim() || el.item.name, program: k >= 0 ? PARTS[k][1] : el.item.program };
        });
        if (!chosen.length) { toast('Tick at least one part, or Cancel.'); return; }
        done({ title: dlg.querySelector('[data-f=title]').value.trim() || title, artist: dlg.querySelector('[data-f=artist]').value.trim(), items: chosen });
      } else if (e.target.closest('[data-no]')) done(null);
    });
  });
}

// A song the UG helper saved again with "Replace the old files": the library's song of that title and artist
// gets the new content and keeps its id, so its practice history, loops and settings stay. Otherwise a new song.
/* ---------- a bass tab and a guitar tab of one song become one song ---------- */

// 'ask' (default), 'yes' (always combine) or 'no' (always keep apart)
let combinePref = 'ask';
getValue('combineTabs').then((v) => { if (v) combinePref = v; }).catch(() => {});
async function setCombinePref(v) { combinePref = v; await setValue('combineTabs', v); }

// Which instrument a text tab is for, from its file name ("Song - Artist - Bass Tab").
const tabPart = (name) => (/bass/i.test(name) ? 'Bass' : /ukulele|uke\b/i.test(name) ? 'Ukulele' : 'Guitar');
const plainTitle = (t) => String(t || '').replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();

// A new text tab for a song already in the library as another instrument's tab: offer to make
// them one song with a track each. Returns the combined song's id, or 0 to save it on its own.
async function combineTab({ base, data, fileName }) {
  if (combinePref === 'no') return 0;
  const { asciiTabToAlphaTex } = await import('./asciitab.js');
  if (!asciiTabToAlphaTex(data)) return 0; // a chord sheet
  const { title, artist } = namesFromPdf(base, true);
  const part = tabPart(base);
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const other = (await listSongs()).filter((s) => s.kind === 'text' && same(s.artist, artist) && plainTitle(s.title) === title.toLowerCase()
    && (s.part || tabPart(s.fileName || s.title)) !== part && !(s.parts || []).some((p) => p.name === part)
    && asciiTabToAlphaTex(s.data)).sort((a, b) => (b.added || 0) - (a.added || 0))[0];
  if (!other) return 0;
  if (combinePref === 'ask') {
    const answer = await askCombine(other.title, part);
    if (!answer) return 0;
    if (!answer.again) await setCombinePref(answer.combine ? 'yes' : 'no');
    if (!answer.combine) return 0;
  }
  const otherPart = other.part || tabPart(other.fileName || other.title);
  const mine = { name: part, data, fileName };
  // the guitar comes first: it is the track the song opens on and it sets the length
  const next = part === 'Bass' || otherPart === 'Guitar'
    ? { part: otherPart, parts: [...(other.parts || []), mine] }
    : { data, fileName, part, parts: [{ name: otherPart, data: other.data, fileName: other.fileName }, ...(other.parts || [])] };
  await updateSong(other.id, { ...next, title });
  toast(`Combined: “${title}” now has a ${[next.part, ...next.parts.map((p) => p.name)].join(' and a ')} track.`, 5000);
  return other.id;
}

// Resolves { combine, again } or null when closed.
function askCombine(existing, part) {
  const dlg = document.createElement('dialog');
  dlg.className = 'parts-dialog';
  dlg.innerHTML = `<form method="dialog">
    <h2>Combine with “${escape(existing)}”?</h2>
    <p class="muted">This ${escape(part.toLowerCase())} tab is for a song you already have. Combined, it’s one song with a track for each tab, playing together.</p>
    <label style="display: flex; align-items: center; gap: .5rem; margin: .8rem 0"><input type="checkbox" data-again checked> Ask every time</label>
    <div class="row spread"><button value="no" class="ghost">Keep separate</button><button value="yes" class="primary">Combine</button></div>
  </form>`;
  document.body.append(dlg);
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => {
    const again = dlg.querySelector('[data-again]').checked;
    dlg.remove();
    resolve(dlg.returnValue === 'yes' || dlg.returnValue === 'no' ? { combine: dlg.returnValue === 'yes', again } : null);
  }, { once: true }));
}

const CHORDPRO = /\.(cho|chordpro|chopro|crd|pro)$/i;

// A chord chart with notes on it: keep them (each with who wrote it) or import it clean. null: cancelled.
function askNotes(notes) {
  const by = [...new Set(notes.map((n) => n.by).filter(Boolean))];
  const dlg = document.createElement('dialog');
  dlg.className = 'parts-dialog';
  dlg.innerHTML = `<form method="dialog">
    <h2>Keep the notes?</h2>
    <p class="muted">This chart has ${notes.length} note${notes.length > 1 ? 's' : ''}${by.length ? ` from ${escape(by.join(', '))}` : ''} on it:</p>
    <ul class="small-text">${notes.slice(0, 5).map((n) => `<li>${n.by ? `<b>${escape(n.by)}:</b> ` : ''}${escape(n.text)}</li>`).join('')}${notes.length > 5 ? '<li>…</li>' : ''}</ul>
    <div class="row spread"><button value="clean" class="ghost">Import clean</button><button value="keep" class="primary">Keep notes</button></div>
  </form>`;
  document.body.append(dlg);
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => {
    dlg.remove();
    resolve(dlg.returnValue === 'keep' ? true : dlg.returnValue === 'clean' ? false : null);
  }, { once: true }));
}

// The written key of a song, when it says one: a chord chart's "Key: Bb" line, a read tab's \ks.
function songKeyName(song) {
  if (song.kind === 'text') return /\bKey:\s*([A-G][#b]?m?)(?![\w#])/.exec(String(song.data || '').slice(0, 400))?.[1] || '';
  if (song.kind === 'tex') return /\\ks\s+([A-G][#b]?m?)\b/.exec(String(song.data || ''))?.[1] || '';
  return '';
}
const capoOf = (song) => (song.kind === 'text' ? Number(/\bCapo:\s*(\d+)/.exec(String(song.data || '').slice(0, 400))?.[1]) || 0 : 0);

// One import's answer to "you already have this song", for the rest of its files ("Do the same for the rest").
let dupRule = null;
let dupMore = 0; // files after this one in the same import
let dupSkipped = 0;
let dupReplaced = 0; // songs given this import's content (counted apart from the added ones)
let skippedAs = 0; // the song you already had, for the last one skipped (a received setlist still lists it)

// The library's songs that are this one: the same title (a "(with notes)" or "(live)" on the end aside),
// and the same artist when both name one.
async function sameSongs(song) {
  const low = (s) => String(s || '').trim().toLowerCase();
  return (await listSongs()).filter((s) => plainTitle(s.title) === plainTitle(song.title)
    && (!low(s.artist) || !low(song.artist) || low(s.artist) === low(song.artist)))
    .sort((a, b) => (b.lastOpened || b.added || 0) - (a.lastOpened || a.added || 0));
}

// "Chord chart · Key G · Capo 3"
function songFacts(song) {
  const key = songKeyName(song);
  const capo = capoOf(song);
  return [CHART_LABEL[chartType(song)] || 'Song', key && `Key ${key}`, capo && `Capo ${capo}`].filter(Boolean);
}

// A song being imported that the library already has. Resolves 'replace', 'attach' (as the tab's chord sheet),
// 'both', or 'skip' (also when closed).
function askDuplicate(song, old, count, more) {
  const was = songKeyName(old), now = songKeyName(song);
  const attach = song.kind === 'text' && chartType(song) === 'chords' && old.kind !== 'text' && old.kind !== 'sheet';
  const mins = Math.round((old.practiceSeconds || 0) / 60);
  const when = old.added ? new Date(old.added).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const card = (head, s, extra) => `<div class="dup-card"><div class="dup-head">${head}</div>
    <div class="dup-title">${escape(s.title)}</div>${s.artist ? `<div class="muted small-text">${escape(s.artist)}</div>` : ''}
    <div class="dup-facts">${songFacts(s).map((f) => `<span class="pill">${escape(f)}</span>`).join('')}</div>
    ${extra ? `<div class="muted small-text">${extra}</div>` : ''}</div>`;
  const choice = (v, title, hint, primary) => `<button value="${v}" class="dup-choice${primary ? ' primary' : ''}"><b>${title}</b><span>${hint}</span></button>`;
  const dlg = document.createElement('dialog');
  dlg.className = 'parts-dialog dup-dialog';
  dlg.innerHTML = `<form method="dialog">
    <h2>You already have “${escape(old.title)}”</h2>
    ${was && now && was !== now ? `<p class="dup-key">Same song, different key: <b>${escape(was)}</b> in your library, <b>${escape(now)}</b> in this file.</p>` : ''}
    <div class="dup-cards">
      ${card('In your library', old, [when && `Added ${escape(when)}`, mins && `${mins} min practiced`, count > 1 && `and ${count - 1} more with this name`].filter(Boolean).join(' · '))}
      ${card('This file', song, escape(song.fileName || ''))}
    </div>
    <div class="dup-choices">
      ${attach ? choice('attach', 'Add as its chord sheet', 'The tab stays as it is; these chords open from its ⋮ menu.', true) : ''}
      ${choice('replace', 'Replace it', 'Use this file instead. Practice time, loops and setlists stay with the song.', !attach)}
      ${choice('both', 'Keep both', 'Add this as a second song with the same name.')}
      ${choice('skip', 'Skip', 'Don’t import this file.')}
    </div>
    ${more ? `<label class="dup-again"><input type="checkbox" data-all> Do the same for ${more > 1 ? `the other ${more} songs` : 'the other song'} in this import</label>` : ''}
  </form>`;
  document.body.append(dlg);
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => {
    const v = ['replace', 'attach', 'both', 'skip'].includes(dlg.returnValue) ? dlg.returnValue : 'skip';
    if (dlg.querySelector('[data-all]')?.checked) dupRule = v;
    dlg.remove();
    resolve(v);
  }, { once: true }));
}

// The song with old's id and history, and song's content.
async function replaceSong(old, song) {
  const next = { ...old, ...song, id: old.id, added: old.added };
  for (const k of ['sheets', 'parts', 'part', 'chordPro']) if (!(k in song)) delete next[k];
  await putSong(next);
  return old.id;
}

// Saves an imported song. replace: the song of that title and artist gets the new content without asking.
// Otherwise a song the library already has asks what to do. Returns its id, or 0 when skipped.
async function saveImported(song, replace) {
  const same = await sameSongs(song);
  if (replace) {
    const low = (s) => String(s || '').trim().toLowerCase();
    const old = same.find((s) => low(s.title) === low(song.title) && low(s.artist) === low(song.artist));
    return old ? replaceSong(old, song) : putSong(song);
  }
  const more = dupMore;
  dupMore = Math.max(0, dupMore - 1);
  if (!same.length) return putSong(song);
  const old = same[0];
  let act = dupRule || await askDuplicate(song, old, same.length, more);
  if (act === 'attach' && !(song.kind === 'text' && old.kind !== 'text' && old.kind !== 'sheet')) act = 'replace'; // "the same for the rest" on a file that isn't a chord chart
  if (act === 'skip') { dupSkipped++; skippedAs = old.id; return 0; }
  if (act === 'attach' || act === 'replace') dupReplaced++;
  if (act === 'attach') { await updateSong(old.id, { chordSheet: song.data }); return old.id; }
  if (act === 'replace') return replaceSong(old, song);
  return putSong(song);
}

// Several PDFs of one song (one per instrument, as tools/ug_collect.py saves them): read, check, then one song.
// Returns the new song's id, or null when cancelled or nothing could be made.
// UG's key from the helper's folder name, "Song - Artist (Key C)", when the files came with their folder.
const folderKey = (files) => files.map((f) => /\(Key ([A-G][#b]?m?)\)[\\/]/.exec(f.webkitRelativePath || '')?.[1]).find(Boolean) || '';

// auto: { title, artist, key } of a song the UG helper saved: made as it is, without the review.
async function importPdfParts(files, auto = null, replace = false) {
  const first = namesFromPdf(files[0].name.replace(/\.[^.]+$/, ''), true);
  const items = await readParts(files, first.title);
  if (!items) { toast('Cancelled: nothing was added.'); return null; }
  // guitar parts with tab first, so the song opens on a guitar (the order can be changed in the review)
  const guitar = (it) => (it.strips && /guitar|acoustic|electric|lead(?!\s*vocal)|rhythm/i.test(it.name) ? 0 : drumKind(it.name) ? 2 : 1);
  items.sort((x, y) => guitar(x) - guitar(y));
  const pick = auto ? { title: auto.title || first.title, artist: auto.artist ?? first.artist, items } : await reviewParts(items, first.title, first.artist);
  if (!pick) { toast('Cancelled: nothing was added.'); return null; }
  const { title, artist } = pick;
  const tabs = pick.items.filter((it) => it.strips);
  // parts written as standard notation (piano, drums) have no tab to combine: they stay in the same
  // song as their PDF pages, listed with its tracks
  const sheets = [];
  for (const it of pick.items.filter((x) => !x.strips)) sheets.push({ name: it.name, program: it.program, fileName: it.file.name, data: await it.file.arrayBuffer() });
  if (!tabs.length) {
    const id = await saveImported({ kind: 'sheet', title, artist, data: sheets[0].data, fileName: sheets[0].fileName, sheets, added: Date.now() }, replace);
    if (!id) return null;
    toast(`Added “${title}” as sheet music, ${sheets.length} part${sheets.length > 1 ? 's' : ''}.`, 6000);
    return id;
  }
  const { ugToAlphaTex } = await import('./ugtab.js');
  const parts = tabs.map(({ name, program, strips }) => ({ name, program, strips }));
  const made = ugToAlphaTex(parts[0].strips, { title, artist, name: parts[0].name, program: parts[0].program, extra: parts.slice(1), key: auto?.key || folderKey(files) });
  if (!made) { toast('Couldn’t combine these PDFs into a song.', 6000); return null; }
  const id = await saveImported({ kind: 'tex', title, artist, data: made.tex, fileName: tabs[0].file.name, ...(sheets.length ? { sheets } : {}), added: Date.now() }, replace);
  if (!id) return null;
  toast(`${replace ? 'Updated' : 'Added'} “${title}”: ${parts.length} tab track${parts.length > 1 ? 's' : ''}, ${made.bars} bars${sheets.length ? `, plus ${sheets.length} as sheet music` : ''}.${made.lyrics ? ' Lyrics included.' : ''}`, 8000);
  return id;
}

// One import at a time: a second one (the watched folder's, while the user imports by hand) waits
// its turn. Two at once each opened a "Reading the PDFs" dialog, and the one in front froze.
let importing = Promise.resolve();
let waiting = 0;
const queued = new Set(); // the same files twice in the queue are imported once
function importFiles(files, opts) {
  const key = files.map((f) => `${f.name}|${f.size}`).sort().join('/');
  if (files.length && queued.has(key)) return Promise.resolve({ ids: [] });
  if (waiting && files.length) toast('Another import is running: this one starts when it’s done.', 5000);
  waiting++;
  queued.add(key);
  const run = importing.then(() => importFilesNow(files, opts)).finally(() => { waiting--; queued.delete(key); });
  importing = run.catch(() => {});
  return run;
}

async function importFilesNow(files, { quietIfEmpty = false, auto = null, replace = false, openOne = false, batch = null } = {}) {
  // the UG helper's own notes (its run note, latest.txt, collected.txt), not songs
  files = files.filter((f) => !/^fretboard-run.*\.json$/i.test(f.name) && !/^(latest|collected)\.txt$/i.test(f.name));
  let added = 0;
  let combined = 0; // tabs that joined a song already in the library (it said so itself)
  const ids = [];
  const failed = [];
  const got = (id) => { if (id) { ids.push(id); added++; } };
  if (!batch || batch.first) dupRule = null; // one of several songs picked at once: an answer "for the rest" carries on
  dupSkipped = dupReplaced = 0;
  // a .zip (a setlist shared from Fretboard, or songs from another app): each file in it imported on its own
  for (const z of files.filter((x) => /\.zip$/i.test(x.name))) {
    files = files.filter((x) => x !== z);
    try {
      const r = await importZip(z, replace);
      ids.push(...r.ids); added += r.added; failed.push(...r.failed);
    } catch (err) { console.error(err); failed.push(z.name); }
  }
  // a PDF Fretboard made carries its whole song (an attached .fretboard file): read that instead
  for (const [i, f] of files.entries()) {
    if (!/\.pdf$/i.test(f.name)) continue;
    try {
      const inside = pdfAttachment(await f.arrayBuffer());
      if (inside) files[i] = new File([inside], f.name.replace(/\.pdf$/i, '.fretboard'));
    } catch { /* an ordinary PDF */ }
  }
  // songs shared from Fretboard (a .fretboard file): each saved as it came, asking about ones you have
  for (const f of files.filter((x) => /\.fretboard$/i.test(x.name))) {
    files = files.filter((x) => x !== f);
    const shared = readFretboardFile(await f.text());
    if (!shared) { failed.push(f.name); continue; }
    dupMore = shared.songs.length - 1 + files.length; // for "Do the same for the other …"
    const saved = [];
    for (const song of shared.songs) {
      skippedAs = 0;
      const id = await saveImported(song, replace);
      got(id);
      saved.push(id || skippedAs);
    }
    for (const l of shared.setlists) {
      const songIds = l.songs.map((i) => saved[i]).filter(Boolean);
      if (songIds.length) toast(`Added the setlist “${await addSetlist({ name: l.name, date: l.date, songIds })}” (${songIds.length} songs). It’s in ☰ Setlists.`, 6000);
    }
  }
  // ChordPro files, and PDFs that are chord charts (SongSelect and the like: real text, chords over words)
  const charts = [];
  for (const f of files) {
    try {
      if (CHORDPRO.test(f.name)) charts.push({ file: f, cho: await f.text() });
      else if (/\.pdf$/i.test(f.name)) {
        const [{ loadPdfjs }, { pdfToChordPro }] = await Promise.all([import('./pdftab.js'), import('./chordpro.js')]);
        const cho = await pdfToChordPro(await loadPdfjs(), await f.arrayBuffer(), { fileName: f.name });
        if (cho) charts.push({ file: f, cho });
      }
    } catch (err) { console.error(err); }
  }
  { // how many songs this import makes, for "Do the same for the other …"
    const rest = files.filter((f) => !charts.some((c) => c.file === f));
    const pdfCount = rest.filter((f) => /\.pdf$/i.test(f.name)).length;
    dupMore = charts.length + (pdfCount > 1 ? 1 + rest.filter((f) => !/\.pdf$|\bchords\.txt$/i.test(f.name)).length : rest.length) - 1 + (batch?.left || 0);
  }
  if (charts.length) {
    files = files.filter((f) => !charts.some((c) => c.file === f));
    const { readChordPro, withoutNotes } = await import('./chordpro.js');
    const notes = charts.flatMap((c) => readChordPro(c.cho).notes);
    const keep = notes.length ? await askNotes(notes) : false;
    if (keep !== null) {
      for (const { file, cho } of charts) {
        const kept = keep ? cho : withoutNotes(cho);
        const r = readChordPro(kept);
        const base = file.name.replace(/\.[^.]+$/, '');
        const { title, artist } = r.title ? r : namesFromPdf(base);
        got(await saveImported({ kind: 'text', title, artist, data: r.text, chordPro: kept, fileName: file.name, added: Date.now() }, replace));
      }
    }
  }
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
  let open = 0;
  if (pdfs.length > 1 && !batch?.single) { // several PDFs together: one song, an instrument each
    files = files.filter((f) => !pdfs.includes(f)); // cancelling adds none of them
    // the chord sheet saved with the parts ("Song - Artist - Chords.txt") belongs to the same song
    const sheet = files.find((f) => /\bchords\.txt$/i.test(f.name));
    if (sheet) files = files.filter((f) => f !== sheet);
    try {
      const id = await importPdfParts(pdfs, auto, replace);
      if (id && sheet) await updateSong(id, { chordSheet: await sheet.text() });
      if (id) { ids.push(id); added++; if (!files.length) open = id; }
    } catch (err) { console.error(err); failed.push(...pdfs.map((f) => f.name)); }
  }
  for (const file of files) {
    const base = file.name.replace(/\.[^.]+$/, '');
    if (/\.txt$/i.test(file.name)) {
      // "Song - Artist - Chords.txt", as tools/ug_collect.py saves a chord sheet or plain tab
      const { title, artist } = namesFromPdf(base);
      const data = cleanTabText(await file.text());
      const from = data.slice(0, 600).match(/^From: (https:\/\/\S+)$/m)?.[1];
      const joined = !replace && await combineTab({ base, data, fileName: file.name });
      if (joined) { ids.push(joined); combined++; continue; }
      got(await saveImported({ kind: 'text', title, artist, data, fileName: file.name, ...(from ? { sourceUrl: from } : {}), added: Date.now() }, replace));
      continue;
    }
    if (/\.pdf$/i.test(file.name)) {
      try {
        const { pdfToTab } = await import('./pdftab.js');
        toast('Reading the PDF…', 8000);
        const { title, artist } = namesFromPdf(base);
        const r = await pdfToTab(await file.arrayBuffer(), (page, pages, line) => toast(`Reading the PDF… page ${page} of ${pages}${line ? ', ' + line : ''}`, 8000), { title, artist, bass: /bass/i.test(base), drums: drumKind(partFromName(file.name) || base) });
        if (!r.tex && !r.text.trim()) { // no tab in it (piano or vocal staff): keep the PDF to read as pages
          const id = await saveImported({ kind: 'sheet', title, artist, data: await file.arrayBuffer(), fileName: file.name, added: Date.now() }, replace);
          got(id);
          if (id) toast('No tab in this PDF, so it’s saved as sheet music you can read page by page.', 6000);
          continue;
        }
        const id = await saveImported(r.tex
          ? { kind: 'tex', title, artist, data: r.tex, fileName: file.name, added: Date.now() }
          : { kind: 'text', title, artist, data: cleanTabText(r.text), fileName: file.name, added: Date.now() }, replace);
        got(id);
        if (!id) continue;
        if (r.tex) toast(`Read ${r.bars} bars from the PDF, with its tempo and section names${r.lyrics ? ' and lyrics (the Lyrics switch in the player turns them on or off)' : ''}. Check the rhythm in Edit.`, 7000);
        else if (r.unknown) toast(`PDF read, but ${r.unknown} mark${r.unknown > 1 ? 's' : ''} couldn’t be read. Check the tab.`, 6000);
      } catch (err) { console.error(err); failed.push(file.name); }
      continue;
    }
    if (/\.ptb$/i.test(file.name)) { // Power Tab: read here into alphaTex, a track per guitar
      try {
        const { ptbToAlphaTex } = await import('./ptb.js');
        const r = ptbToAlphaTex(await file.arrayBuffer());
        const fromName = parseFilename(file.name);
        const id = await saveImported({ kind: 'tex', title: r.title.trim() || fromName?.song || base, artist: r.artist.trim() || fromName?.artist || '', data: r.tex, fileName: file.name, added: Date.now() }, replace);
        got(id);
        if (id) toast(`Read ${r.bars} bars and ${r.tracks.length} tracks from the Power Tab file: ${r.tracks.join(', ')}.`, 7000);
      } catch (err) { console.error(err); failed.push(file.name); }
      continue;
    }
    if (/\.(mid|midi|kar|rmi)$/i.test(file.name)) { // MIDI: written out as MusicXML, which alphaTab loads
      try {
        const { midiToMusicXml } = await import('./midi.js');
        const r = midiToMusicXml(await file.arrayBuffer());
        const fromName = parseFilename(file.name);
        const id = await saveImported({ kind: 'xml', title: r.title || fromName?.song || base, artist: r.artist || fromName?.artist || '', data: new TextEncoder().encode(r.xml).buffer, fileName: base + '.musicxml', added: Date.now() }, replace);
        got(id);
        if (id) toast(`Read ${r.bars} bars and ${r.tracks.length} track${r.tracks.length > 1 ? 's' : ''} from the MIDI file: ${r.tracks.join(', ')}. MIDI has no note lengths of its own, so check the rhythm.`, 7000);
      } catch (err) { console.error(err); failed.push(file.name); }
      continue;
    }
    const buf = await file.arrayBuffer();
    const fromName = parseFilename(file.name); // Ultimate Guitar's "Artist-Song-date" names
    const info = readScoreInfo(new Uint8Array(buf));
    if (!info.ok) { failed.push(file.name); continue; }
    got(await saveImported({
      kind: /\.(xml|musicxml|mxl)$/i.test(file.name) ? 'xml' : 'gp',
      title: info.title?.trim() || fromName?.song || base,
      artist: info.artist?.trim() || fromName?.artist || '',
      data: buf,
      fileName: file.name,
      ...(file.source ? { sourceUrl: file.source.url, versionNote: file.source.title || '' } : {}),
      added: Date.now(),
    }, replace));
  }
  const parts = [];
  added -= dupReplaced;
  if (added > 0) parts.push(`Added ${added} song${added > 1 ? 's' : ''}.`);
  if (dupReplaced) parts.push(`Updated ${dupReplaced} you already had.`);
  if (dupSkipped) parts.push(`Skipped ${dupSkipped} you already have.`);
  if (failed.length) parts.push(`Couldn't read ${failed.join(', ')} (not a Guitar Pro / MusicXML / MIDI file?).`);
  if (parts.length) toast(parts.join(' '), failed.length ? 6000 : 3000);
  else if (!quietIfEmpty && pdfs.length < 2 && !combined && !dupSkipped) toast('Nothing to import.'); // a cancelled PDF import already said so
  if (openOne && ids.length === 1) open = ids[0]; // a file you picked or dropped: open it
  if (open && location.hash === `#song/${open}`) { route(); return { added, failed, ids }; } // the open song was replaced: show its new content
  if (open) { location.hash = `#song/${open}`; return { added, failed, ids }; } // straight to the new song
  renderLibrary();
  return { added, failed, ids };
}

// A .zip: each song file in it imported on its own (several PDFs in a zip are separate songs, not parts),
// in name order. With a Setlist.txt (Fretboard's setlist zip) the setlist is made again from them.
async function importZip(zip, replace) {
  const entries = (await readZip(await zip.arrayBuffer())).map((e) => ({ ...e, name: e.name.split('/').pop() }));
  const listFile = entries.find((e) => /^setlist.*\.txt$/i.test(e.name));
  const list = listFile && readSetlistText(new TextDecoder().decode(listFile.data));
  // "01 Song (chords).cho" beside "01 Song.pdf": the PDF already carries the song with its chord sheet
  const songs = entries.filter((e) => e !== listFile && !(/ \(chords\)\.cho$/i.test(e.name) && entries.some((x) => x.name === e.name.replace(/ \(chords\)\.cho$/i, '.pdf')))).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const out = { ids: [], added: 0, failed: [] };
  const byFile = new Map();
  for (const [i, e] of songs.entries()) {
    skippedAs = 0;
    const r = await importFilesNow([new File([e.data], e.name)], { replace, quietIfEmpty: true, batch: { first: i === 0, left: songs.length - 1 - i, single: true } });
    out.ids.push(...r.ids); out.added += r.added; out.failed.push(...r.failed);
    byFile.set(e.name, r.ids[0] || skippedAs);
  }
  if (list) {
    const order = list.files.length ? list.files : songs.map((e) => e.name);
    const songIds = order.map((n) => byFile.get(n)).filter(Boolean);
    if (songIds.length) toast(`Added the setlist “${await addSetlist({ name: list.name, date: list.date, songIds })}” (${songIds.length} songs). It’s in ☰ Setlists.`, 6000);
  }
  return out;
}

// Song files can be dropped anywhere, on any page.
function initImport() {
  $('file-input').addEventListener('change', (e) => { importFiles([...e.target.files], { openOne: true }); e.target.value = ''; });
  const zone = $('drop-zone');
  const files = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let depth = 0;
  document.addEventListener('dragenter', (e) => { if (!files(e)) return; depth++; zone.hidden = false; });
  document.addEventListener('dragover', (e) => { if (files(e)) e.preventDefault(); });
  document.addEventListener('dragleave', (e) => { if (files(e) && --depth <= 0) { depth = 0; zone.hidden = true; } });
  document.addEventListener('drop', (e) => {
    if (!files(e)) return;
    e.preventDefault();
    depth = 0;
    zone.hidden = true;
    const all = [...e.dataTransfer.files];
    const songs = all.filter((f) => TAB_FILE.test(f.name) || /\.capx?$/i.test(f.name));
    if (!songs.length) { toast('Not a song file. Fretboard reads Guitar Pro, Power Tab, MusicXML, MIDI, ChordPro, PDF and text tabs.', 5000); return; }
    importFiles(songs, { openOne: true });
  });
}

/* ---------- text tab editor ---------- */

// song: an existing text song to edit, or null for a new one; prefill: initial text for a new one.
// A chord sheet is edited as ChordPro ([G]Amazing [C]grace) and saved back as chords over the words.
let editingSong = null;
let editorStart = '';
function openEditor(song, prefill = {}) {
  editingId = song?.id ?? null;
  editingSong = song || null;
  editorStart = song ? editorText(song) : '';
  const pro = song ? editorStart !== String(song.data || '') : false;
  $('tab-dialog-title').textContent = !song ? 'Paste text tab' : pro ? 'Edit chord chart (ChordPro)' : 'Edit text tab';
  $('tf-help').hidden = !pro;
  $('tf-title').value = song?.title || prefill.title || '';
  $('tf-artist').value = song?.artist || prefill.artist || '';
  $('tf-body').value = song ? editorStart : prefill.data || '';
  $('tab-dialog').showModal();
}

function initEditor() {
  $('tab-dialog').addEventListener('close', async () => {
    if ($('tab-dialog').returnValue !== 'save') return;
    const text = $('tf-body').value;
    const title = $('tf-title').value.trim();
    const artist = $('tf-artist').value.trim();
    // the sheet unchanged: kept exactly as it was
    const fields = editingSong && text === editorStart
      ? { title, artist }
      : fromEditor(text, { title, artist, old: editingSong });
    if (editingId) {
      const song = await updateSong(editingId, fields);
      if (currentView === 'text') openText(song); else renderLibrary();
    } else {
      const id = await putSong({ kind: 'text', ...fields, added: Date.now() });
      location.hash = `song/${id}`;
    }
  });
}

/* ---------- find online ---------- */

// After an auto-import the song opens with the play-along panel showing (Linked video).
function openPlayAlongSheet(tries = 20) {
  const sheet = document.querySelector('.sheet[data-sheet="playalong"]');
  if (!sheet || !sheet.hidden || !location.hash.startsWith('#song/')) return;
  const btn = document.querySelector('[data-sheet-btn="playalong"]');
  if (btn && btn.offsetParent) btn.click();
  else if (tries > 0) setTimeout(() => openPlayAlongSheet(tries - 1), 150);
}

// The Quick Song Importer: the library's search box. Typing filters the library; Quick (or Enter, when
// no song in the library matches) has the UG helper find, save and add the song; Manual opens the
// Ultimate Guitar search to download it yourself (auto-import picks the file up).
async function findSong(mode) {
  const query = $('find-query').value;
  if (!query.trim()) { $('find-query').focus(); return; }
  // searched: the box empties, so the whole library shows again
  $('find-query').value = '';
  $('qi-modes').hidden = true;
  renderLibrary();
  const url = sourceUrl('ug-gp', query);
  // The UG helper (tools/ug_watch.py): the search opens in its Chrome, every type listed. Open an Official
  // or Pro song there and its files are saved and added here as one song by themselves.
  // Not running yet: it's started (its link) when it has run in this browser before.
  if (mode === 'quick' && helperPossible()) {
    await setupUG(); // the first time only: auto-import and the UG helper explained
    let up = await ugHelper();
    const tried = !up && localStorage.getItem('fretboard-ug-helper-set') === '1';
    if (tried) up = await startHelper();
    const all = url.replace(/&type=\d+/, '');
    if (up && (await openInCollector(all))) {
      watchRuns();
      watchDownloads({ query, url: all });
      showStatus(up);
      toast('Pick your song in the Ultimate Guitar window that just opened. It’s added here by itself.', 9000);
      return;
    }
    if (tried) { toast('The UG helper didn’t start. Press “UG helper” under the search, or use Manual.', 7000); return; } // too late for a new tab (the browser would block it)
  }
  window.open(url, '_blank', 'noopener');
  watchDownloads({ query, url });
}

function initFind() {
  const input = $('find-query');
  const modes = () => { $('qi-modes').hidden = !input.value.trim(); };
  if (!helperPossible()) { // Quick needs the UG helper (Windows); Manual is the way here
    $('qi-modes').querySelector('[data-mode=quick]').remove();
    const m = $('qi-modes').querySelector('[data-mode=manual]');
    m.className = 'primary small';
    m.textContent = 'Find on UG';
  }
  input.addEventListener('input', () => { modes(); renderLibrary(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; modes(); renderLibrary(); } });
  $('find-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const mode = e.submitter?.dataset.mode;
    if (!mode && libSongs.length) { // Enter with the song in the library: open it
      location.hash = `song/${libSongs[0].id}`;
      openDrawer(false);
      return;
    }
    findSong(mode || (helperPossible() ? 'quick' : 'manual'));
  });
  $('lib-type-btn').addEventListener('click', typeMenu);
  $('lib-type-chip').addEventListener('click', () => { chartFilter = 'all'; renderLibrary(); });
  $('pl-delete').addEventListener('click', async () => { // the ⚙ menu: delete the song you're on
    const id = Number(location.hash.match(/^#(?:song|edit)\/(\d+)/)?.[1]);
    document.body.classList.remove('menu-open');
    if (!id || !await cardAct('delete', id)) return;
    location.hash = 'library'; // opens the latest song left
  });
  $('lib-folder-btn').addEventListener('click', folderMenu);
  $('welcome-find').addEventListener('click', () => openDrawer(true, { focus: true }));
  modes();
}

/* ---------- start ---------- */

async function seedDemos() {
  let seeded = false;
  try { seeded = localStorage.getItem('fretboard-seeded') === '1'; } catch { /* ignore */ }
  if (seeded || (await listSongs()).length) return;
  for (const d of DEMOS) await putSong({ kind: 'tex', ...d, added: Date.now() });
  try { localStorage.setItem('fretboard-seeded', '1'); } catch { /* ignore */ }
}

async function main() {
  initPlayer();
  initText({ onEdit: openEditor });
  initMetronome();
  initTuner();
  initImport();
  initEditor();
  initFind();
  initScales();
  initKeys();
  initLayers();
  initVocal();
  initDrawer();
  initQuickImport({ importFiles, openEditor, toast, renderLibrary, openSong: (id, { playAlong = false } = {}) => {
    location.hash = `song/${id}`;
    if (playAlong) openPlayAlongSheet();
  } });
  // The Android app's tab browser hands over each tab file it downloads (base64) to add here.
  window.fretboardImport = async (name, base64, url, pageTitle) => {
    const bin = atob(base64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const file = new File([bytes], name);
    if (typeof url === 'string' && /^https?:\/\//.test(url)) file.source = { url, title: String(pageTitle || '').slice(0, 200) };
    const { ids } = await importFiles([file]);
    if (ids?.length === 1) location.hash = `song/${ids[0]}`;
  };
  $('library-list').addEventListener('click', onLibraryClick);
  initBulk({ shown: () => libSongs, ask, redraw: renderLibrary });
  $('lib-tidy').addEventListener('click', (e) => {
    const act = e.target.closest('[data-tidy]')?.dataset.tidy;
    if (act === 'combine') combineSplit().catch((err) => { console.error(err); toast('Couldn’t combine them.'); });
    else if (act === 'undo') undoCombineSplit();
    else if (act === 'ok') { undoCombine = null; renderLibrary(); }
  });
  window.addEventListener('hashchange', () => { undoCombine = null; });
  initCardMenu();
  window.addEventListener('fblibrary', renderLibrary); // the drawer's Songs tab is showing
  window.addEventListener('songschange', () => { if (drawerOpen()) renderLibrary(); });
  window.addEventListener('fbtoast', (e) => toast(e.detail));
  window.addEventListener('hashchange', route);
  await recoverPendingSessions();
  await seedDemos();
  route();
  initSync({ toast });
  window.addEventListener('librarysynced', () => { if (drawerOpen()) renderLibrary(); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.fretboardAndroid) { // the Android app bundles its files
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

main();
