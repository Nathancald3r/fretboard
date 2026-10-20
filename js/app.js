// App shell: routing, library, file import, text-tab editor and "find tabs online" links.
import { listSongs, getSong, putSong, deleteSong, updateSong } from './db.js';
import { initPlayer, openPlayer, closePlayer } from './player.js';
import { initText, openText, closeText, cleanTabText } from './texttab.js';
import { initMetronome } from './metronome.js';
import { initTuner, stopTuner } from './tuner.js';
import { renderLog } from './log.js';
import { formatDuration, recoverPendingSessions } from './practice.js';
import { DEMOS } from './demos.js';
import { initScales, renderScales } from './scales.js';
import { initQuickImport } from './quickimport.js';

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const VIEWS = ['library', 'player', 'text', 'scales', 'tools', 'log'];
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
  if (name === 'song') {
    song = await getSong(Number(arg));
    const asText = song?.kind === 'text' && location.hash.split('/')[2] !== 'play';
    view = !song ? 'library' : asText ? 'text' : 'player';
  }

  if (currentView === 'player') closePlayer(); // also when switching songs
  if (currentView === 'text') closeText();
  if (currentView === 'tools' && view !== 'tools') stopTuner();
  currentView = view;

  VIEWS.forEach((v) => { $('view-' + v).hidden = v !== view; });
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === view));

  if (view === 'library') renderLibrary();
  if (view === 'log') renderLog();
  if (view === 'scales') renderScales();
  if (view === 'player') openPlayer(song);
  if (view === 'text') openText(song);
  if (view !== 'text') window.scrollTo(0, 0);
}

/* ---------- library ---------- */

const KIND_LABEL = { gp: 'Guitar Pro', xml: 'MusicXML', tex: 'Exercise', text: 'Text tab' };

async function renderLibrary() {
  const filter = $('lib-filter').value.trim().toLowerCase();
  const songs = (await listSongs())
    .filter((s) => !filter || `${s.title} ${s.artist}`.toLowerCase().includes(filter))
    .sort((a, b) => (b.lastOpened || b.added) - (a.lastOpened || a.added));

  $('library-list').innerHTML = songs.map((s) => `
    <article class="card" data-id="${s.id}">
      <div class="title">${escape(s.title)}</div>
      <div class="meta">${escape(s.artist || '')}</div>
      <div class="meta">
        <span class="badge">${KIND_LABEL[s.kind] || s.kind}</span>
        ${s.practiceSeconds ? `<span>${formatDuration(s.practiceSeconds)} practiced</span>` : ''}
        ${s.bestSpeed ? `<span>top ${s.bestSpeed}%</span>` : ''}
      </div>
      <div class="actions">
        <button class="small ghost" data-act="rename">${s.kind === 'text' ? 'Edit' : 'Rename'}</button>
        <button class="small ghost danger" data-act="delete">Delete</button>
      </div>
    </article>`).join('')
    || `<div class="empty">${filter ? 'No matches.' : 'Nothing here yet — import a Guitar Pro file or paste a text tab.'}</div>`;
}

async function onLibraryClick(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = Number(card.dataset.id);
  const act = e.target.closest('button')?.dataset.act;
  if (!act) { location.hash = `song/${id}`; return; }

  const song = await getSong(id);
  if (act === 'delete') {
    const ok = await ask({ title: 'Delete from library?', text: `“${song.title}” will be removed. Your practice log keeps its history.`, ok: 'Delete' });
    if (!ok) return;
    await deleteSong(id);
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
function ask({ title, text = '', ok = 'OK', fields = null }) {
  const dialog = $('ask-dialog');
  $('ask-title').textContent = title;
  $('ask-text').textContent = text;
  $('ask-text').hidden = !text;
  $('ask-ok').textContent = ok;
  $('ask-ok').classList.toggle('danger', ok === 'Delete');
  $('ask-fields').hidden = !fields;
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

/* ---------- import ---------- */

function readScoreInfo(bytes) {
  try {
    const score = window.alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes);
    return { title: score.title, artist: score.artist, ok: true };
  } catch {
    return { ok: false };
  }
}

async function importFiles(files, { quietIfEmpty = false } = {}) {
  let added = 0;
  const failed = [];
  for (const file of files) {
    const base = file.name.replace(/\.[^.]+$/, '');
    if (/\.txt$/i.test(file.name)) {
      await putSong({ kind: 'text', title: base, artist: '', data: cleanTabText(await file.text()), added: Date.now() });
      added++;
      continue;
    }
    const buf = await file.arrayBuffer();
    const info = readScoreInfo(new Uint8Array(buf));
    if (!info.ok) { failed.push(file.name); continue; }
    await putSong({
      kind: /\.(xml|musicxml|mxl)$/i.test(file.name) ? 'xml' : 'gp',
      title: info.title?.trim() || base,
      artist: info.artist?.trim() || '',
      data: buf,
      fileName: file.name,
      added: Date.now(),
    });
    added++;
  }
  const parts = [];
  if (added) parts.push(`Added ${added} song${added > 1 ? 's' : ''}.`);
  if (failed.length) parts.push(`Couldn't read ${failed.join(', ')} (not a Guitar Pro / MusicXML file?).`);
  if (parts.length) toast(parts.join(' '), failed.length ? 6000 : 3000);
  else if (!quietIfEmpty) toast('Nothing to import.');
  renderLibrary();
  return { added, failed };
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

function initFind() {
  $('find-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = encodeURIComponent($('find-query').value.trim());
    if (!q) return;
    const urls = {
      'ug-gp': `https://www.ultimate-guitar.com/search.php?search_type=title&value=${q}&type=500`,
      ug: `https://www.ultimate-guitar.com/search.php?search_type=title&value=${q}`,
      songsterr: `https://www.songsterr.com/?pattern=${q}`,
    };
    window.open(urls[e.submitter?.dataset.site || 'ug-gp'], '_blank', 'noopener');
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
  initQuickImport({ importFiles, openEditor, toast });
  $('library-list').addEventListener('click', onLibraryClick);
  $('lib-filter').addEventListener('input', renderLibrary);
  window.addEventListener('hashchange', route);
  await recoverPendingSessions();
  await seedDemos();
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

main();
