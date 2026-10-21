// App shell: routing, library, file import, text-tab editor and "find tabs online" links.
import { listSongs, getSong, putSong, deleteSong, updateSong, getValue, setValue } from './db.js';
import { initPlayer, openPlayer, closePlayer } from './player.js';
import { askVersion } from './version.js';
import { initText, openText, closeText, cleanTabText } from './texttab.js';
import { initMetronome, stopMetronome } from './metronome.js';
import { initLayers, resetLayers } from './layers.js';
import { initTuner, stopTuner } from './tuner.js';
import { renderLog } from './log.js';
import { renderPractice, trackDrill } from './practicehub.js';
import { initVocal, stopVocal } from './vocal.js';
import { versionLabel, syncState, chartType, CHART_LABEL, SORTS, filterSongs, folderNames, stars } from './songmeta.js';
import { loadFolders, moveSong, rateSong, addFolder } from './folders.js';
import { formatDuration, recoverPendingSessions } from './practice.js';
import { DEMOS } from './demos.js';
import { initScales, renderScales } from './scales.js';
import { initQuickImport, watchDownloads } from './quickimport.js';
import { TAB_SOURCES, sourceUrl } from './tabsources.js';
import { initKeys, renderKeys } from './keys.js';
import { initDrawer } from './drawer.js';
import { initSync } from './syncui.js';
import { parseFilename } from './tabinfo.js';

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const VIEWS = ['library', 'player', 'text', 'practice', 'scales', 'keys', 'tools', 'vocal', 'log'];
const PRACTICE_VIEWS = ['practice', 'scales', 'keys', 'tools', 'vocal']; // all highlight the Practice tab
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

async function route() {
  const [name, arg] = (location.hash.slice(1) || 'library').split('/');
  let view = VIEWS.includes(name) ? name : 'library';
  let song = null;
  let editing = false;
  if (name === 'song') {
    song = await getSong(Number(arg));
    const asText = song?.kind === 'text' && location.hash.split('/')[2] !== 'play';
    view = !song ? 'library' : asText ? 'text' : 'player';
  } else if (name === 'edit') { // edit mode: the tab editor instead of the practice tools
    song = await getSong(Number(arg));
    editing = !!song && chartType(song) !== 'chords' && song.kind !== 'tex';
    view = editing ? 'player' : song ? (song.kind === 'text' ? 'text' : 'player') : 'library';
  }
  document.body.classList.toggle('edit-mode', editing);

  resetLayers(); // sheets, menus, pop-ups and full screen never carry over to another page or song
  if (currentView === 'player') closePlayer(); // also when switching songs
  if (currentView === 'text') closeText();
  if (currentView === 'tools' && view !== 'tools') { stopTuner(); stopMetronome(); }
  if (currentView === 'vocal' && view !== 'vocal') stopVocal();
  trackDrill(view);
  currentView = view;

  VIEWS.forEach((v) => { $('view-' + v).hidden = v !== view; });
  document.body.classList.toggle('in-player', view === 'player');
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === view || (a.dataset.nav === 'practice' && PRACTICE_VIEWS.includes(view))));

  if (view === 'library') renderLibrary();
  if (view === 'log') renderLog();
  if (view === 'practice') renderPractice();
  if (view === 'scales') renderScales();
  if (view === 'keys') renderKeys();
  if (view === 'player') { await openPlayer(song); if (editing) window.dispatchEvent(new Event('fbeditmode')); }
  if (view === 'text') openText(song);
  if (view !== 'text') window.scrollTo(0, 0);
}

/* ---------- library ---------- */

let chartFilter = 'all';
let folderList = [];

async function renderLibrary() {
  const all = await listSongs();
  folderList = await loadFolders();
  const names = folderNames(all.filter((s) => chartType(s) !== 'exercise'), folderList);
  const folderSel = $('lib-folder');
  const wanted = folderSel.value || 'all';
  folderSel.innerHTML = `<option value="all">All songs</option><option value="">No folder</option>${names.map((n) => `<option>${escape(n)}</option>`).join('')}`;
  folderSel.value = [...folderSel.options].some((o) => o.value === wanted) ? wanted : 'all';

  const songs = filterSongs(all, { text: $('lib-filter').value, chart: chartFilter, folder: folderSel.value })
    .sort(SORTS[$('lib-sort').value] || SORTS.recent);
  const total = all.filter((s) => chartType(s) !== 'exercise').length;
  document.querySelectorAll('#lib-chart [data-chart]').forEach((b) => b.classList.toggle('on', b.dataset.chart === chartFilter));
  $('lib-controls').hidden = !total;

  $('library-list').innerHTML = songs.map((s) => {
    const type = chartType(s);
    return `<article class="card" data-id="${escape(s.id)}" data-type="${type}">
      <div class="title">${escape(s.title)}</div>
      <div class="meta">${escape(s.artist || '')}</div>
      <div class="meta">
        <span class="badge type-${type}">${escape(CHART_LABEL[type])}</span>
        ${versionLabel(s) ? `<span class="badge ver-${s.version.type}" title="The recording this tab follows">${escape(versionLabel(s))}</span>` : ''}
        ${type === 'pro' || type === 'tab' ? (() => { const y = syncState(s); return `<span class="badge sync-${y.state}" title="Play-along video">${y.state === 'synced' ? '✓ Synced' : y.state === 'none' ? '○ No video' : '◐ ' + escape(y.label)}</span>`; })() : ''}
        ${s.folder ? `<span class="badge folder">📁 ${escape(s.folder)}</span>` : ''}
        ${s.practiceSeconds ? `<span>${formatDuration(s.practiceSeconds)} practiced</span>` : ''}
        ${s.bestSpeed ? `<span>top ${escape(s.bestSpeed)}%</span>` : ''}
      </div>
      <div class="rate" role="group" aria-label="Your ranking">${[1, 2, 3, 4, 5].map((n) => `<button class="star${n <= (s.rating || 0) ? ' on' : ''}" data-act="rate" data-n="${n}" title="${n} star${n > 1 ? 's' : ''}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>
      <div class="actions">
        <label class="folder-pick" title="Move to a folder">📁<select data-act="folder" aria-label="Folder">
          <option value="">No folder</option>${names.map((n) => `<option${n === s.folder ? ' selected' : ''}>${escape(n)}</option>`).join('')}<option value="__new__">New folder…</option></select></label>
        <button class="small ghost" data-act="menu" aria-label="More options for ${escape(s.title)}" aria-haspopup="menu">⋮</button>
        <button class="small ghost" data-act="rename">${s.kind === 'text' ? 'Edit' : 'Rename'}</button>
        <button class="small ghost danger" data-act="delete">Delete</button>
      </div>
    </article>`;
  }).join('') || (total ? '<div class="empty">No songs match these filters.</div>' : `<div class="empty-start">
      <p>No songs yet.</p>
      <div class="row">
        <button class="primary big" data-start="add">+ Song</button>
        <a class="button big ghost" href="#practice">Go to Practice</a>
      </div>
      <p class="muted small-text">Add a song by searching for it above, importing a Guitar Pro file, or pasting a tab. Scales, chord changes, rhythm and vocal training are on the Practice page.</p></div>`);
}

async function onLibraryClick(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = Number(card.dataset.id);
  const act = e.target.closest('button')?.dataset.act;
  if (e.target.closest('select, .folder-pick')) return; // handled on change
  if (!act) { location.hash = `song/${id}`; return; }
  if (act === 'rate') {
    const n = Number(e.target.closest('button').dataset.n);
    await rateSong(id, (await getSong(id)).rating === n ? 0 : n); // pressing the same star again clears it
    return;
  }

  if (act === 'menu') { openCardMenu(card, null); return; }
  return cardAct(act, id);
}

async function cardAct(act, id) {
  const song = await getSong(id);
  if (!song) return;
  if (act === 'edit') { location.hash = `edit/${id}`; return; }
  if (act === 'practice') { location.hash = `song/${id}`; return; }
  if (act === 'version') { await askVersion(song); renderLibrary(); return; }
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

// ⋮ button, right-click and long-press on a song: edit mode, version, rename, delete.
let menuEl = null;
function closeCardMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
function openCardMenu(card, at) {
  closeCardMenu();
  const id = Number(card.dataset.id);
  const editable = card.dataset.type !== 'chords' && card.dataset.type !== 'exercise';
  menuEl = document.createElement('div');
  menuEl.className = 'card-menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.innerHTML = [
    editable ? ['edit', '✎ Edit mode', 'Arrange bars, fix notes, match a recording'] : null,
    ['practice', '▶ Open in Practice'],
    ['version', '🎧 Version…', 'Studio, live or cover'],
    ['rename', 'Rename'],
    ['delete', 'Delete'],
  ].filter(Boolean).map(([k, label, hint]) => `<button role="menuitem" data-m="${k}" class="${k === 'delete' ? 'danger' : ''}">${label}${hint ? `<small>${hint}</small>` : ''}</button>`).join('');
  document.body.append(menuEl);
  const r = card.getBoundingClientRect();
  const x = at ? at.x : r.right - 220;
  const y = at ? at.y : r.bottom;
  Object.assign(menuEl.style, { left: Math.max(8, Math.min(x, innerWidth - 240)) + 'px', top: Math.max(8, Math.min(y, innerHeight - menuEl.offsetHeight - 8)) + 'px' });
  menuEl.addEventListener('click', (e) => {
    const k = e.target.closest('[data-m]')?.dataset.m;
    if (!k) return;
    closeCardMenu();
    cardAct(k, id);
  });
  menuEl.querySelector('button')?.focus();
}
function initCardMenu() {
  const list = $('library-list');
  list.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    openCardMenu(card, { x: e.clientX, y: e.clientY });
  });
  let timer = 0;
  let from = null;
  list.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.card');
    if (!card || e.pointerType === 'mouse' || e.target.closest('button, select, label')) return;
    from = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => { list.dataset.held = '1'; openCardMenu(card, { x: from.x, y: from.y }); }, 550);
  });
  const stop = () => clearTimeout(timer);
  list.addEventListener('pointermove', (e) => { if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 10) stop(); });
  list.addEventListener('pointerup', stop);
  list.addEventListener('pointercancel', stop);
  list.addEventListener('click', (e) => { if (list.dataset.held) { delete list.dataset.held; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  document.addEventListener('pointerdown', (e) => { if (menuEl && !e.target.closest('.card-menu, [data-act=menu]')) closeCardMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCardMenu(); });
  window.addEventListener('hashchange', closeCardMenu);
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
function namesFromPdf(base) {
  const pretty = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s).trim();
  const m = base.replace(/\s*@.*$/, '').match(/^(?:official\s+)?(.*?)\s+(?:chords?|tabs?)(?:\s*&\s*(?:chords?|tabs?))?\s+by\s+(.+)$/i);
  if (m) return { title: pretty(m[1]), artist: pretty(m[2]) };
  const title = base.replace(/\b(tab|chords?)\b|@.*$|[(\[]\d+[)\]]/gi, '').replace(/\s+/g, ' ').trim() || base;
  return { title: pretty(title), artist: '' };
}

async function importFiles(files, { quietIfEmpty = false } = {}) {
  let added = 0;
  const ids = [];
  const failed = [];
  for (const file of files) {
    const base = file.name.replace(/\.[^.]+$/, '');
    if (/\.txt$/i.test(file.name)) {
      ids.push(await putSong({ kind: 'text', title: base, artist: '', data: cleanTabText(await file.text()), added: Date.now() }));
      added++;
      continue;
    }
    if (/\.pdf$/i.test(file.name)) {
      try {
        const { pdfToTab } = await import('./pdftab.js');
        toast('Reading the PDF…', 8000);
        const { title, artist } = namesFromPdf(base);
        const r = await pdfToTab(await file.arrayBuffer(), undefined, { title, artist });
        if (!r.tex && !r.text.trim()) { failed.push(file.name); continue; }
        ids.push(await putSong(r.tex
          ? { kind: 'tex', title, artist, data: r.tex, fileName: file.name, added: Date.now() }
          : { kind: 'text', title, artist, data: cleanTabText(r.text), fileName: file.name, added: Date.now() }));
        added++;
        if (r.tex) toast(`Read ${r.bars} bars from the PDF. Set the tempo and check the rhythm in Edit.`, 7000);
        else if (r.unknown) toast(`PDF read, but ${r.unknown} mark${r.unknown > 1 ? 's' : ''} couldn’t be read. Check the tab.`, 6000);
      } catch (err) { console.error(err); failed.push(file.name); }
      continue;
    }
    const buf = await file.arrayBuffer();
    const fromName = parseFilename(file.name); // Ultimate Guitar's "Artist-Song-date" names
    const info = readScoreInfo(new Uint8Array(buf));
    if (!info.ok) { failed.push(file.name); continue; }
    ids.push(await putSong({
      kind: /\.(xml|musicxml|mxl)$/i.test(file.name) ? 'xml' : 'gp',
      title: info.title?.trim() || fromName?.song || base,
      artist: info.artist?.trim() || fromName?.artist || '',
      data: buf,
      fileName: file.name,
      ...(file.source ? { sourceUrl: file.source.url, versionNote: file.source.title || '' } : {}),
      added: Date.now(),
    }));
    added++;
  }
  const parts = [];
  if (added) parts.push(`Added ${added} song${added > 1 ? 's' : ''}.`);
  if (failed.length) parts.push(`Couldn't read ${failed.join(', ')} (not a Guitar Pro / MusicXML file?).`);
  if (parts.length) toast(parts.join(' '), failed.length ? 6000 : 3000);
  else if (!quietIfEmpty) toast('Nothing to import.');
  renderLibrary();
  return { added, failed, ids };
}

function initImport() {
  $('file-input').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });
  const zone = $('drop-zone');
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => {
    if (currentView !== 'library') return;
    e.preventDefault();
    zone.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((t) => document.addEventListener(t, () => zone.classList.remove('over')));
  document.addEventListener('drop', (e) => {
    if (currentView !== 'library') return;
    e.preventDefault();
    importFiles([...e.dataTransfer.files]);
  });
}

/* ---------- text tab editor ---------- */

// song: an existing text song to edit, or null for a new one; prefill: initial text for a new one.
function openEditor(song, prefill = {}) {
  editingId = song?.id ?? null;
  $('tab-dialog-title').textContent = song ? 'Edit text tab' : 'Paste text tab';
  $('tf-title').value = song?.title || prefill.title || '';
  $('tf-artist').value = song?.artist || prefill.artist || '';
  $('tf-body').value = song?.data || prefill.data || '';
  $('tab-dialog').showModal();
}

function initEditor() {
  $('btn-paste').addEventListener('click', () => openEditor(null));
  $('tab-dialog').addEventListener('close', async () => {
    if ($('tab-dialog').returnValue !== 'save') return;
    const fields = {
      title: $('tf-title').value.trim(),
      artist: $('tf-artist').value.trim(),
      data: cleanTabText($('tf-body').value),
    };
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

function initFind() {
  const box = $('find-sources');
  for (const s of TAB_SOURCES) {
    const b = document.createElement('button');
    b.type = 'submit';
    b.dataset.site = s.id;
    b.textContent = s.label;
    b.title = s.note;
    if (!s.primary) b.className = 'ghost';
    box.append(b);
  }
  $('find-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const query = $('find-query').value;
    if (!query.trim()) { $('find-query').focus(); return; }
    const url = sourceUrl(e.submitter?.dataset.site || 'ug-gp', query);
    window.open(url, '_blank', 'noopener');
    watchDownloads({ query, url });
  });
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
  initQuickImport({ importFiles, openEditor, toast, openSong: (id, { playAlong = false } = {}) => {
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
  initCardMenu();
  $('library-list').addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'folder') return;
    let name = e.target.value;
    if (name === '__new__') {
      const f = await ask({ title: 'New folder', ok: 'Create', fields: { title: '', artist: '' }, single: true });
      name = f?.title.trim() || '';
      if (name) await addFolder(name);
    }
    await moveSong(Number(e.target.closest('.card').dataset.id), name);
  });
  $('lib-filter').addEventListener('input', renderLibrary);
  $('lib-sort').addEventListener('change', renderLibrary);
  $('lib-folder').addEventListener('change', renderLibrary);
  $('lib-chart').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chart]');
    if (b) { chartFilter = b.dataset.chart; renderLibrary(); }
  });
  window.addEventListener('songschange', () => { if (!$('view-library').hidden) renderLibrary(); });
  window.addEventListener('fbtoast', (e) => toast(e.detail));
  window.addEventListener('findonline', (e) => { // "Find … online" from the top-bar search
    location.hash = 'library';
    $('find-query').value = e.detail || '';
    setTimeout(() => { $('find-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('find-query').focus(); }, 50);
  });
  // "+ Song": jump to the prominent Find panel (the quickest way to add one)
  const addSong = () => $('find-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }) || $('find-query').focus();
  $('btn-add-song').addEventListener('click', addSong);
  $('library-list').addEventListener('click', (e) => { if (e.target.closest('[data-start="add"]')) addSong(); });
  window.addEventListener('hashchange', route);
  await recoverPendingSessions();
  await seedDemos();
  route();
  initSync({ toast });
  window.addEventListener('librarysynced', () => { if (!$('view-library').hidden) renderLibrary(); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.fretboardAndroid) { // the Android app bundles its files
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

main();
