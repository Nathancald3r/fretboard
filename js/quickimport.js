// One-click imports: the UG helper and its status under the library's search, the + menu (paste a
// text tab from the clipboard, pick up new tab files from the Downloads folder, Chrome / Edge on desktop).
import { getValue, setValue, getSong, updateSong } from './db.js';
import { bestMatch, matchScore } from './tabsources.js';
import { popMenu } from './menu.js';

const $ = (id) => document.getElementById(id);
export const TAB_FILE = /\.(gp|gp3|gp4|gp5|gpx|gp7|gp8|xml|musicxml|mxl|mid|midi|kar|rmi|ptb|txt|pdf|cho|chordpro|chopro|crd|fretboard)$/i;
const SCAN_DAYS = 14; // only look at recent downloads
const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;

// Opens the editor right away (the browser may show a permission prompt first) and
// fills it in once the clipboard is read; if reading fails, the user can still paste.
async function pasteFromClipboard(openEditor) {
  openEditor(null);
  $('tf-body').focus();
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { return; }
  if (!text.trim() || $('tf-body').value) return;
  $('tf-body').value = text;
  $('tf-title').focus();
}

async function folderHandle() {
  let dir = await getValue('downloadsDir');
  if (dir && (await dir.queryPermission({ mode: 'read' })) !== 'granted'
      && (await dir.requestPermission({ mode: 'read' })) !== 'granted') dir = null;
  if (!dir) {
    dir = await window.showDirectoryPicker({ id: 'tab-downloads', startIn: 'downloads', mode: 'read' });
    await setValue('downloadsDir', dir);
  }
  return dir;
}

// Imports tab files in the folder that haven't been imported before.
async function checkDownloads(importFiles, toast) {
  let dir;
  try { dir = await folderHandle(); } catch { return; } // picker cancelled
  const seen = new Set((await getValue('importedFiles')) || []);
  const since = Date.now() - SCAN_DAYS * 86400e3;
  const fresh = [];
  for await (const entry of dir.values()) {
    if (entry.kind !== 'file' || !TAB_FILE.test(entry.name)) continue;
    const file = await entry.getFile();
    if (file.lastModified < since || seen.has(fileKey(file))) continue;
    fresh.push(file);
  }
  if (!fresh.length) {
    toast(`No new tab files in “${dir.name}” from the last ${SCAN_DAYS} days.`);
    return;
  }
  await importFiles(fresh, { quietIfEmpty: true });
  // Remember failures too, so a broken file isn't retried every time.
  fresh.forEach((f) => seen.add(fileKey(f)));
  await setValue('importedFiles', [...seen].slice(-500));
}

// Where ug_collect.py saves: Downloads\UG Songs\<Song - Artist (Key X)>. Given the remembered folder
// (Downloads, or UG Songs itself), the UG Songs folder in it, or null.
async function ugSongs(dir) {
  if (/^UG Songs$/i.test(dir.name)) return dir;
  try { return await dir.getDirectoryHandle('UG Songs'); } catch { return null; }
}

// Every PDF in the folder and its song folders (two levels: UG Songs\<song>), with the folder names.
async function* pdfsIn(dir, path = '', depth = 0) {
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && /\.pdf$/i.test(entry.name)) yield { entry, path };
    else if (entry.kind === 'directory' && depth < 2) yield* pdfsIn(entry, `${path}${entry.name} `, depth + 1);
  }
}

// Every PDF for the song typed in the search box (all its words are in the file or folder name), from the
// folder and its UG Songs song folders: one click for each instrument's tab. Files already imported are skipped.
async function importSongPdfs(importFiles, toast) {
  const query = $('find-query').value.trim();
  if (!query) { toast('Type the song in the search first, then press this.', 5000); $('find-query').focus(); return; }
  let dir;
  try { dir = await folderHandle(); } catch { return; }
  const seen = new Set((await getValue('importedFiles')) || []);
  const found = [];
  for await (const { entry, path } of pdfsIn(dir)) {
    if (matchScore(path + entry.name, query) < 0.99) continue;
    const file = await entry.getFile();
    if (!seen.has(fileKey(file))) found.push(file);
  }
  if (!found.length) { toast(`No new PDFs for “${query}” in “${dir.name}” or its UG Songs folders.`, 5000); return; }
  found.sort((a, b) => a.name.localeCompare(b.name));
  await importFiles(found, { quietIfEmpty: true });
  found.forEach((f) => seen.add(fileKey(f)));
  await setValue('importedFiles', [...seen].slice(-500));
  toast(`Added ${found.length} PDF${found.length > 1 ? 's' : ''} for “${query}”.`, 6000);
}

// "Import files" opens in the song folder collected last (UG Songs\latest.txt names it), else UG Songs,
// else the folder used last time, so the PDFs are right there.
async function pickFiles(importFiles) {
  let startIn = 'downloads';
  const dir = await grantedFolder();
  const ug = dir && (await ugSongs(dir));
  if (ug) {
    startIn = ug;
    try {
      const name = (await (await (await ug.getFileHandle('latest.txt')).getFile()).text()).trim();
      if (name) startIn = await ug.getDirectoryHandle(name);
    } catch { /* no latest song: UG Songs itself */ }
  }
  let handles;
  try {
    handles = await window.showOpenFilePicker({ id: 'tab-import', startIn, multiple: true });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    $('file-input').click(); // picker not allowed here: the plain file chooser
    return;
  }
  importFiles(await Promise.all(handles.map((h) => h.getFile())), { openOne: true });
}

/* ---------- songs the UG collector finished ---------- */

// tools/ug_collect.py leaves fretboard-run.json in each song folder it finishes (UG Songs\<song>).
// Songs not imported (or put off with Not now) yet are offered in the library.
export async function readyRuns(dir) {
  const ug = await ugSongs(dir);
  if (!ug) return [];
  const done = new Set((await getValue('importedRuns')) || []);
  const runs = [];
  for await (const entry of ug.values()) {
    if (entry.kind !== 'directory') continue;
    // fretboard-run.json: the official song's PDFs; fretboard-run-chords.json etc.: one text or Guitar Pro file
    for await (const f of entry.values()) {
      if (f.kind !== 'file' || !/^fretboard-run.*\.json$/i.test(f.name)) continue;
      let m;
      try { m = JSON.parse(await (await f.getFile()).text()); } catch { continue; }
      const key = `${entry.name}${f.name === 'fretboard-run.json' ? '' : '/' + f.name}|${m?.finished}`;
      const tracks = Array.isArray(m?.tracks) ? m.tracks.filter((t) => typeof t?.file === 'string' && /\.(pdf|txt|gp\w*)$/i.test(t.file)) : [];
      if (done.has(key) || !tracks.length) continue;
      const what = m.kind === 'text' || m.kind === 'gp' ? String(tracks[0].name || '') : '';
      // held: a file wasn't saved, so the song waits until you Retry it or leave it out (the UG downloads panel)
      const missing = Array.isArray(m.missing) ? m.missing.filter((n) => !(m.dropped || []).includes(n)) : [];
      // id, not key: key is the song's key (G), and it overwrote this, so a song was never marked taken
      // and was added again every 4 s (Rest On Us, 8 times)
      runs.push({ id: key, dir: entry, song: String(m.song || entry.name) + (what ? ` (${what})` : ''), tracks, finished: String(m.finished || ''),
        title: String(m.song || ''), artist: String(m.artist || ''), key: String(m.key || ''), replace: m.replace === true, missing, held: missing.length > 0,
        chords: typeof m.chords === 'string' ? m.chords : '', strum: Array.isArray(m.strum) ? m.strum : [], video: /^[\w-]{11}$/.test(m.video || '') ? m.video : '' });
    }
  }
  return runs.sort((a, b) => b.finished.localeCompare(a.finished));
}

async function markRun(key) {
  const done = (await getValue('importedRuns')) || [];
  await setValue('importedRuns', [...done.filter((k) => k !== key), key].slice(-500));
}

let readyBusy = false;
export async function showReady() {
  const box = $('lib-ready');
  if (!box || !ctx || !canWatch || readyBusy) return;
  readyBusy = true;
  try {
    const stored = await getValue('downloadsDir').catch(() => null);
    const dir = await grantedFolder();
    box.innerHTML = '';
    if (!dir) { // after a browser restart reading the folder needs a click again
      box.hidden = !stored;
      if (stored) {
        box.append('Songs the UG helper saved: ');
        const b = button('Check', 'ghost small', async () => {
          try { await stored.requestPermission({ mode: 'read' }); } catch { return; }
          showReady();
        });
        box.append(b);
      }
      return;
    }
    const runs = await readyRuns(dir);
    box.hidden = !runs.length;
    if (!runs.length) return;
    const r = runs[0];
    const text = document.createElement('span');
    const n = r.tracks.length;
    const kind = /\.pdf$/i.test(r.tracks[0].file) ? `${n} PDF${n > 1 ? 's' : ''}` : /\.txt$/i.test(r.tracks[0].file) ? 'text' : 'Guitar Pro';
    const held = r.held ? `, ${r.missing.length} not saved` : '';
    text.textContent = `“${r.song}” is ready (${kind}${held})${runs.length > 1 ? ` · ${runs.length - 1} more` : ''}`;
    box.append(text, button('Add', 'primary small', () => importRun(r)));
    if (runs.length > 1) box.append(button(`All ${runs.length}…`, 'ghost small', () => pickRuns(runs)));
    box.append(button('Not now', 'ghost small', async () => { await markRun(r.id); showReady(); }));
  } catch { $('lib-ready').hidden = true; } finally { readyBusy = false; }
}

// Every song the UG helper saved that isn't in the library yet, ticked: add the ticked ones in one go
// (each made straight away, as the helper's songs are), or put them off with Not now.
async function pickRuns(runs) {
  const dlg = document.createElement('dialog');
  dlg.className = 'parts-dialog ready-dialog';
  const kindOf = (r) => (/\.pdf$/i.test(r.tracks[0].file) ? `${r.tracks.length} PDF${r.tracks.length > 1 ? 's' : ''}` : /\.txt$/i.test(r.tracks[0].file) ? 'Text' : 'Guitar Pro');
  const when = (r) => { const d = new Date(r.finished); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
  dlg.innerHTML = `<form method="dialog">
    <h2>Songs the UG helper saved</h2>
    <label class="ready-all"><input type="checkbox" data-all checked> Select all</label>
    <div class="ready-list">${runs.map((r, i) => `<label class="ready-row"><input type="checkbox" data-i="${i}" checked>
      <span class="ready-name">${esc(r.song)}${r.artist ? `<small>${esc(r.artist)}</small>` : ''}</span>
      <span class="muted small-text">${esc([kindOf(r), r.held ? `${r.missing.length} not saved` : '', when(r)].filter(Boolean).join(' · '))}</span></label>`).join('')}</div>
    <div class="row spread"><button value="later" class="ghost" data-later>Not now for the ticked</button><button value="add" class="primary" data-add>Add ${runs.length} songs</button></div>
  </form>`;
  document.body.append(dlg);
  const boxes = [...dlg.querySelectorAll('[data-i]')];
  const all = dlg.querySelector('[data-all]');
  const sync = () => {
    const n = boxes.filter((b) => b.checked).length;
    all.checked = n === boxes.length;
    all.indeterminate = n > 0 && n < boxes.length;
    dlg.querySelector('[data-add]').textContent = n ? `Add ${n} song${n > 1 ? 's' : ''}` : 'Add';
    dlg.querySelector('[data-add]').disabled = dlg.querySelector('[data-later]').disabled = !n;
  };
  all.addEventListener('change', () => { boxes.forEach((b) => { b.checked = all.checked; }); sync(); });
  boxes.forEach((b) => b.addEventListener('change', sync));
  dlg.showModal();
  await new Promise((resolve) => dlg.addEventListener('close', resolve, { once: true }));
  const picked = boxes.filter((b) => b.checked).map((b) => runs[Number(b.dataset.i)]);
  const act = dlg.returnValue;
  dlg.remove();
  if (act === 'later') { for (const r of picked) await markRun(r.id); showReady(); return; }
  if (act !== 'add') return;
  // one at a time, oldest first; "you already have this song" answered once can go for the rest
  const list = [...picked].reverse();
  let done = 0;
  for (let i = 0; i < list.length; i++) if (await importRun(list[i], true, { first: i === 0, left: list.length - 1 - i })) done++;
  ctx.toast(done === list.length ? `Added all ${done} songs you picked.` : `Added ${done} of the ${list.length} songs you picked.`, 5000);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// auto: made into one song straight away (no review), as the UG helper's songs are.
// batch: { first, left } when it's one of several picked at once
async function importRun(r, auto = false, batch = null) {
  const files = [];
  for (const t of r.tracks) {
    try { files.push(await (await r.dir.getFileHandle(t.file)).getFile()); } catch { /* moved or deleted: left out */ }
  }
  if (!files.length) { ctx.toast(`The files for “${r.song}” aren’t in its folder any more.`, 5000); await markRun(r.id); showReady(); return null; }
  if (auto) await markRun(r.id); // taken now, so it's never added twice
  // replace: "Replace the old files" in the UG helper, so the song already in the library is updated, not added again
  const { ids } = await ctx.importFiles(files, { quietIfEmpty: true, replace: r.replace, batch, ...(auto ? { auto: { title: r.title, artist: r.artist, key: r.key } } : {}) });
  if (ids?.length && !auto) await markRun(r.id); // cancelled: it stays offered
  if (ids?.length) await addExtras(r, ids[0]);
  showReady();
  return ids?.[0] ?? null;
}

// The song's chord sheet (lined up with the words in the player), UG's linked video and a chords
// page's strumming pattern (shown above the sheet, its bpm the song's tempo).
async function addExtras(r, id) {
  try {
    const changes = {};
    if (r.chords) {
      try { changes.chordSheet = await (await (await r.dir.getFileHandle(r.chords)).getFile()).text(); } catch { /* not there: chords are guessed */ }
    }
    const song = r.video || r.strum.length ? await getSong(id) : null;
    if (song && r.video && !song.recording) changes.recording = { kind: 'youtube', id: r.video, title: '', author: '' };
    if (song && r.strum.length) changes.strum = r.strum;
    if (Object.keys(changes).length) await updateSong(id, changes);
  } catch (err) {
    console.warn('Chords or video not added', err);
  }
}

/* ---------- the UG helper (tools/ug_watch.py) ---------- */

// The helper runs on this computer and answers on this port: it opens Ultimate Guitar in its own
// Chrome (where you're logged in) and saves every PDF of an Official or Pro song you open there.
const HELPER = 'http://127.0.0.1:9231';

/** The helper's status, or null when it isn't running. */
export async function ugHelper() {
  if (!canWatch) return null;
  try {
    const r = await fetch(HELPER + '/status', { signal: AbortSignal.timeout(1500) });
    const s = r.ok ? await r.json() : null;
    if (s?.app !== 'fretboard-ug-helper') return null;
    try { localStorage.setItem(HELPER_SET, '1'); } catch { /* fine */ }
    return s;
  } catch { return null; }
}

// The helper is a Windows program; "Set up UG helper.cmd" installs it once per computer and
// registers the fretboard-helper: link, which starts it (Chrome asks once: Always allow).
export const helperPossible = () => canWatch && /Windows/.test(navigator.userAgent);
const HELPER_SET = 'fretboard-ug-helper-set'; // it has answered in this browser before
const SETUP_URL = 'tools/ug_helper_setup.cmd';
const helperKnown = () => { try { return localStorage.getItem(HELPER_SET) === '1'; } catch { return false; } };
let helperState = ''; // '' | 'starting' | 'failed'
let helperPoll = 0;

/** Starts the helper through its link and waits for it; its status, or null when it didn't come up. */
export async function startHelper(waitMs = 30000) {
  if (!helperPossible()) return null;
  helperState = 'starting';
  showStatus();
  location.href = 'fretboard-helper://start';
  const until = Date.now() + waitMs;
  let s = null;
  while (!s && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    s = await ugHelper();
  }
  helperState = s ? '' : 'failed';
  // didn't come up: Find tabs online stops waiting for it (and opens the site as before) until it answers again
  if (!s) try { localStorage.removeItem(HELPER_SET); } catch { /* fine */ }
  await showStatus(s);
  return s;
}

/* ---------- the status under the search: ✓ UG helper  ✓ Auto-import  ⋯ ---------- */

let lastStatus = null;

function chip(label, state, title, onClick) {
  const b = button(label, `chip small qi-chip qi-${state}`, onClick);
  b.title = title;
  return b;
}

/** The marks under the library's search: is the UG helper running, is auto-import on; ⋯ has the rest. */
export async function showStatus(status) {
  const el = $('qi-status');
  if (!el || !ctx) return;
  if (!canWatch) { // the Android app and other browsers: no helper, no folder to watch
    el.textContent = window.fretboardAndroid ? 'Download the Guitar Pro file on UG, then + › Import files.' : 'Quick add and auto-import need Chrome or Edge on a computer.';
    el.classList.add('muted');
    return;
  }
  const s = !helperPossible() ? null : status === undefined ? await ugHelper() : status;
  lastStatus = s;
  const dir = await grantedFolder();
  el.replaceChildren();
  if (helperPossible()) {
    if (s) { // on: pressing it turns it off (an old helper can't quit, so there it brings up its window)
      const canStop = s.version >= 4;
      el.append(chip(s.busy ? '◌ UG helper saving' : '✓ UG helper', 'on', canStop ? 'The UG helper is running: Quick finds songs in its Chrome window and adds them here. Press to turn it off (⋯ has Show UG window)' : 'The UG helper is running: Quick finds songs in its Chrome window and adds them here. Press to show its window', canStop ? stopHelper : showCollector));
    }
    else if (helperState === 'starting') el.append(chip('◌ Starting…', 'busy', 'If Chrome asks to open it, tick Always allow and press Open', () => {}));
    else if (helperState === 'failed') el.append(chip('⚠ UG helper didn’t start', 'bad', 'First time on this computer? Set it up once', () => setupUG(true)));
    else el.append(chip('○ UG helper', 'off', helperKnown() ? 'Start the UG helper' : 'Set up the UG helper (once per computer)', () => (helperKnown() ? startHelper() : setupUG(true))));
  }
  if (dir) {
    el.append(chip(watch ? '◌ Waiting for your download' : '✓ Auto-import', 'on', watch ? 'Save the file on the site and it opens here by itself' : `New tab files in “${dir.name}” are added by themselves`, () => {}));
  } else {
    el.append(chip('○ Auto-import', 'off', 'Pick your Downloads folder once: new tab files there are added by themselves', async () => {
      try { await folderHandle(); } catch { return; }
      showStatus();
    }));
  }
  const more = button('⋯', 'icon-btn small qi-gear', () => helperMenu(more));
  more.setAttribute('aria-label', 'UG helper settings');
  more.setAttribute('aria-haspopup', 'menu');
  more.title = 'UG helper settings';
  el.append(more);
  if (s?.wait) { // UG's player isn't loading the song (often UG checking a public wifi network)
    const w = document.createElement('strong');
    w.className = 'find-wait';
    w.textContent = '⚠ ' + s.wait;
    el.append(w);
  }
  // while a song saves, look again in a few seconds (a wait shows or clears)
  clearTimeout(helperPoll);
  if (s?.busy) helperPoll = setTimeout(() => { if (el.offsetParent) showStatus(); }, 3000);
}

// ⋯: Show UG window, Stop helper, the Standard + Tab setting, the folder, setup.
function helperMenu(anchor) {
  const s = lastStatus;
  popMenu(anchor, [
    s ? { k: 'show', label: 'Show UG window', hint: 'Brings the helper’s Chrome up' } : null,
    s && s.version >= 4 ? { k: 'stop', label: 'Stop helper', hint: 'Closes the UG helper and its Chrome window' } : null,
    s && typeof s.notation === 'boolean' ? { k: 'notation', label: 'Also save Standard + Tab pages', hint: 'On: dynamics and lyrics for fretted tracks, about 15 s slower per song', check: s.notation } : null,
    !s && helperPossible() ? { k: 'start', label: 'Start UG helper' } : null,
    helperPossible() && !helperKnown() ? { k: 'setup-file', label: 'Set up UG helper', hint: 'Once per computer: download and run it' } : null,
    '-',
    { k: 'folder', label: 'Downloads folder…', hint: 'Where auto-import looks' },
    { k: 'how', label: 'How it works' },
  ], async (k) => {
    if (k === 'show') showCollector();
    else if (k === 'start') startHelper();
    else if (k === 'how') setupUG(true);
    else if (k === 'folder') changeFolder(ctx.toast);
    else if (k === 'setup-file') {
      const a = document.createElement('a');
      a.href = SETUP_URL;
      a.download = 'Set up UG helper.cmd';
      a.click();
    } else if (k === 'notation') {
      try {
        const r = await fetch(HELPER + '/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notation: !s.notation }), signal: AbortSignal.timeout(5000) });
        const on = (await r.json()).notation === true;
        ctx.toast(on ? 'Standard + Tab pages on: dynamics and lyrics, about 15 s slower per song.' : 'Standard + Tab pages off: quicker saves.', 5000);
      } catch { ctx.toast('The UG helper didn’t answer.'); }
      showStatus();
    } else if (k === 'stop') stopHelper();
  });
}

/** Turns the helper off: closes it and its Chrome window (it won't while a song is saving). */
async function stopHelper() {
  try {
    const r = await (await fetch(HELPER + '/quit', { method: 'POST', signal: AbortSignal.timeout(3000) })).json();
    if (r.busy) { ctx.toast('It’s saving a song: wait, or Cancel it in UG downloads.', 6000); return; }
  } catch { /* gone already */ }
  await new Promise((r) => setTimeout(r, 800));
  showStatus();
}

/** The + menu next to the search: every other way to add a song, and sync. */
export function moreMenu(anchor) {
  const q = $('find-query').value.trim();
  popMenu(anchor, [
    { k: 'files', label: 'Import files…', hint: 'Guitar Pro, Power Tab, MusicXML, MIDI, ChordPro, PDF, text' },
    navigator.clipboard?.readText ? { k: 'clip', label: 'Paste from clipboard', hint: 'A text tab or chords you copied' } : null,
    { k: 'type', label: 'Type / paste text tab' },
    !helperPossible() ? { k: 'want', label: 'Ask my computer for a song…', hint: 'Official tab + video, lined up' } : null,
    canWatch ? { k: 'downloads', label: 'Import new downloads', hint: 'Tab files from the last 14 days' } : null,
    canWatch ? { k: 'pdfs', label: q ? `PDFs for “${q}”` : 'PDFs for a song', hint: q ? 'Every part in Downloads and UG Songs' : 'Type the song first', disabled: !q } : null,
    '-',
    { k: 'sync', label: 'Sync and backup…' },
    canWatch ? { k: 'how', label: 'How it works', hint: 'Auto-import and the UG helper' } : null,
  ], (k) => {
    if (k === 'files') {
      if (canWatch && 'showOpenFilePicker' in window) pickFiles(ctx.importFiles);
      else $('file-input').click();
    } else if (k === 'clip') pasteFromClipboard(ctx.openEditor);
    else if (k === 'type') ctx.openEditor(null);
    else if (k === 'want') ctx.askComputer(q);
    else if (k === 'downloads') checkDownloads(ctx.importFiles, ctx.toast).then(() => showStatus());
    else if (k === 'pdfs') importSongPdfs(ctx.importFiles, ctx.toast);
    else if (k === 'sync') $('sync-dialog').showModal();
    else if (k === 'how') setupUG(true);
  });
}

/** Brings the helper's Chrome window up (it works out of sight). */
export async function showCollector() {
  try {
    await fetch(HELPER + '/show', { method: 'POST', signal: AbortSignal.timeout(5000) });
  } catch { /* not running */ }
}

/** Opens a page in the helper's Chrome; false when that didn't work. */
export async function openInCollector(url) {
  try {
    const r = await fetch(HELPER + '/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(15000) });
    return r.ok && (await r.json()).ok === true;
  } catch { return false; }
}

/* ---------- UG downloads: each song the helper saves, file by file, with Retry and Cancel ---------- */

const SONG_TEXT = { waiting: 'Waiting', saving: 'Saving', done: 'Saved', held: 'Needs you', failed: 'Didn’t save', cancelled: 'Cancelled' };
const FILE_TEXT = { waiting: 'waiting', saving: 'saving…', saved: 'saved', failed: 'not saved', dropped: 'left out' };
const said = new Map(); // url -> the state last shown, so "needs you" is said once
const closed = new Set(); // url|state of the songs you closed with ×
let queueTimer = 0;
let queueSmall = false; // folded to its title line

async function helperPost(path, body) {
  try {
    const r = await fetch(HELPER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return await r.json();
  } catch { return { ok: false, why: 'The UG helper isn’t running.' }; }
}

// A button that asks once more on its first click (no dialog in the way).
function sureButton(label, sure, onClick) {
  let armed = 0;
  const b = button(label, 'ghost small', () => {
    if (Date.now() - armed > 4000) { armed = Date.now(); b.textContent = sure; setTimeout(() => { b.textContent = label; }, 4000); return; }
    onClick();
  });
  return b;
}

function songCard(s) {
  const card = document.createElement('div');
  card.className = `ugq-song ugq-${s.state}`;
  const head = document.createElement('div');
  head.className = 'ugq-head';
  const name = document.createElement('strong');
  name.textContent = s.song + (s.artist ? ` – ${s.artist}` : '');
  const st = document.createElement('span');
  st.className = 'ugq-state';
  const n = s.tracks.length, got = s.tracks.filter((t) => t.state === 'saved').length;
  st.textContent = SONG_TEXT[s.state] + (s.state === 'saving' && n ? ` ${got} of ${n}` : '') + (s.why && s.state !== 'held' ? `: ${s.why}` : '');
  head.append(name, ' ', st);
  const act = async (path, body) => { card.classList.add('ugq-busy'); const r = await helperPost(path, body); if (!r.ok && r.why) ctx.toast(r.why, 5000); showQueue(); };
  if (['waiting', 'saving', 'held'].includes(s.state)) {
    head.append(sureButton(s.state === 'waiting' && !n ? 'Cancel' : 'Cancel song', 'Delete its files?', () => act('/drop', { url: s.url })));
  } else {
    const x = button('×', 'ghost small ugq-x', () => { closed.add(s.url + '|' + s.state); showQueue(); });
    x.title = 'Close';
    head.append(x);
  }
  card.append(head);
  if (n && (s.state === 'saving' || s.state === 'held' || s.state === 'failed')) {
    const list = document.createElement('ul');
    list.className = 'ugq-files';
    for (const t of s.tracks) {
      const li = document.createElement('li');
      li.className = `ugq-${t.state}`;
      li.append(`${t.name}: ${FILE_TEXT[t.state] || t.state}${t.why ? ` (${t.why})` : ''} `);
      if (s.state === 'held' && t.state === 'failed') {
        const again = button('Retry', 'ghost small', () => act('/retry', { url: s.url, track: t.name }));
        const other = button('Try another way', 'ghost small', () => act('/retry', { url: s.url, track: t.name, shots: true }));
        other.title = 'Saves it from pictures of the score instead of UG’s Print';
        const out = button('Leave out', 'ghost small', () => act('/drop', { url: s.url, track: t.name }));
        out.title = 'The song is added without this track';
        li.append(again, other, out);
      }
      list.append(li);
    }
    card.append(list);
  }
  return card;
}

/** The UG downloads panel: shown while the helper has songs; looks again every 2 s while one saves. */
export async function showQueue() {
  clearTimeout(queueTimer);
  if (!ctx || !helperPossible()) return;
  const s = await ugHelper();
  const songs = (s?.songs || []).filter((x) => !closed.has(x.url + '|' + x.state));
  let el = $('ug-queue');
  if (!el) {
    el = document.createElement('aside');
    el.id = 'ug-queue';
    el.className = 'ug-queue';
    el.setAttribute('aria-label', 'UG downloads');
    document.body.append(el);
  }
  el.hidden = !songs.length;
  el.replaceChildren();
  if (songs.length) {
    const h = button('', 'ugq-title', () => { queueSmall = !queueSmall; showQueue(); });
    const need = songs.filter((x) => x.state === 'held' || x.state === 'failed').length;
    const left = songs.filter((x) => x.state === 'waiting' || x.state === 'saving').length;
    h.textContent = `UG downloads${left ? ` · ${left} to save` : ''}${need ? ` · ${need} need${need > 1 ? '' : 's'} you` : ''} ${queueSmall ? '▴' : '▾'}`;
    h.title = queueSmall ? 'Show the songs' : 'Fold away';
    el.append(h, ...(queueSmall ? [] : songs.map(songCard)));
  }
  for (const x of s?.songs || []) { // a song that needs you, or didn't save: said once
    if (said.get(x.url) !== x.state && (x.state === 'held' || x.state === 'failed') && said.has(x.url)) {
      ctx.toast(x.state === 'held' ? `“${x.song}”: a file wasn’t saved. Retry it or leave it out in UG downloads.` : `“${x.song}” didn’t save${x.why ? `: ${x.why}` : ''}.`, 8000);
    }
    said.set(x.url, x.state);
  }
  const going = songs.some((x) => x.state === 'waiting' || x.state === 'saving');
  const badge = $('menu-badge');
  if (badge) { // on ☰: songs still saving, or one that needs you
    const n = songs.filter((x) => ['waiting', 'saving', 'held', 'failed'].includes(x.state)).length;
    badge.hidden = !n;
    badge.textContent = n ? `⇣${n}` : '';
  }
  if (going || songs.some((x) => x.state === 'held')) { // songs still to come in: keep picking them up
    if (runs) runs.until = Math.max(runs.until, Date.now() + 10 * 60e3); else watchRuns();
  }
  queueTimer = setTimeout(showQueue, going ? 2000 : s ? 8000 : 30000);
}

// After the helper's songs are added: which, with Open song (or why one couldn't be added).
export function showAdded(added) {
  let dlg = $('ug-added');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'ug-added';
    document.body.append(dlg);
  }
  const ok = added.filter((a) => a.id), bad = added.filter((a) => !a.id);
  const last = ok.at(-1);
  dlg.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = last ? `Added “${last.r.title || last.r.song}”` : `Couldn’t add “${bad[0].r.song}”`;
  const p = document.createElement('p');
  p.className = 'muted';
  if (last) {
    const n = last.r.tracks.length;
    p.textContent = [last.r.artist, `${n} track${n > 1 ? 's' : ''}`, last.r.key && `key ${last.r.key}`].filter(Boolean).join(' · ');
  } else {
    p.textContent = 'Its files couldn’t be read. They may have been moved or deleted.';
  }
  dlg.append(h, p);
  const more = [...ok.slice(0, -1).map((a) => `Also added: ${a.r.song}`), ...(last ? bad.map((a) => `Couldn’t add: ${a.r.song}`) : bad.slice(1).map((a) => `Couldn’t add: ${a.r.song}`))];
  for (const m of more) { const q = document.createElement('p'); q.className = 'muted'; q.textContent = m; dlg.append(q); }
  const row = document.createElement('div');
  row.className = 'row spread';
  row.append(button('Close', 'ghost', () => dlg.close()));
  if (last) row.append(button('Open song', 'primary', () => { dlg.close(); ctx.openSong(last.id, { playAlong: false }); }));
  dlg.append(row);
  if (!dlg.open) dlg.showModal();
  row.lastChild.focus();
}

/* ---------- one-time setup: the auto-import folder and the UG helper ---------- */

const SETUP_SEEN = 'fretboard-ug-setup-seen';
const setupSeen = () => { try { return localStorage.getItem(SETUP_SEEN) === '1'; } catch { return true; } };

/** Shown once, before the first Ultimate Guitar search (and from "How it works"): turns on auto-import
 * and explains the UG helper. Steps already done are shown done. Resolves when it's closed. */
export async function setupUG(always = false) {
  if (!ctx || !canWatch || (!always && setupSeen())) return;
  try { localStorage.setItem(SETUP_SEEN, '1'); } catch { /* asked again next time: fine */ }
  let dlg = $('ug-setup');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'ug-setup';
    dlg.className = 'ug-setup';
    document.body.append(dlg);
  }
  const step = (n, done, title, ...body) => {
    const s = document.createElement('section');
    s.className = 'ugs-step' + (done ? ' ugs-done' : '');
    const h = document.createElement('h3');
    h.textContent = done ? `✓ ${title}` : `${n}. ${title}`;
    s.append(h, ...body);
    return s;
  };
  const para = (text) => { const p = document.createElement('p'); p.className = 'muted'; p.textContent = text; return p; };
  const draw = async () => {
    const dir = await grantedFolder();
    const stored = dir || await getValue('downloadsDir').catch(() => null);
    const helper = helperPossible() ? await ugHelper() : null;
    dlg.replaceChildren();
    const h = document.createElement('h2');
    h.textContent = 'Add songs by themselves';
    dlg.append(h);
    // 1. the folder: the browser can only read a folder you pick once
    const folderRow = document.createElement('div');
    folderRow.className = 'row';
    if (!dir) {
      folderRow.append(button(stored ? `Allow “${stored.name}” again` : 'Pick my Downloads folder', 'primary small', async () => {
        try {
          if (stored && (await stored.requestPermission({ mode: 'read' })) === 'granted') { /* allowed */ } else {
            const d = await window.showDirectoryPicker({ id: 'tab-downloads', startIn: 'downloads', mode: 'read' });
            await setValue('downloadsDir', d);
          }
        } catch { return; } // cancelled
        showStatus();
        draw();
      }));
    }
    dlg.append(step(1, !!dir, dir ? `Auto-import is on (“${dir.name}”)` : 'Turn on auto-import',
      para(dir ? 'Tab files you download there, and the songs the UG helper saves in its UG Songs folder, are added here by themselves.'
        : 'Pick your Downloads folder once. Tab files you download there are added here by themselves, and so are the songs the UG helper saves (it puts them in Downloads\\UG Songs, one folder per song).'),
      folderRow));
    // 2. the helper (a Windows program): what each kind of UG song gives
    if (helperPossible()) {
      const kinds = document.createElement('ul');
      kinds.className = 'ugs-kinds';
      for (const [b, t] of [['Official', ' (needs UG Pro): one PDF per track (guitars, bass, drums, keys…) from the version you pick, plus its chords. Fretboard makes them into one song.'],
        ['Pro and Guitar Pro tabs', ': the Guitar Pro file from their Download button.'],
        ['Chords, tabs, bass, ukulele and drum tabs', ': one text file.']]) {
        const li = document.createElement('li');
        const s = document.createElement('strong');
        s.textContent = b;
        li.append(s, t);
        kinds.append(li);
      }
      const helperRow = document.createElement('div');
      helperRow.className = 'row';
      if (!helper) {
        if (!helperKnown()) {
          const a = document.createElement('a');
          a.href = SETUP_URL;
          a.download = 'Set up UG helper.cmd';
          a.className = 'button ghost small';
          a.textContent = 'Set up UG helper';
          a.title = 'First time on this computer: download it and run it once (it installs for your Windows user only)';
          helperRow.append(a);
        }
        helperRow.append(button('Start UG helper', helperKnown() ? 'primary small' : 'ghost small', async (e) => {
          e.currentTarget.disabled = true;
          e.currentTarget.textContent = 'Starting…';
          await startHelper();
          draw();
        }));
      }
      dlg.append(step(2, !!helper, helper ? 'The UG helper is running' : 'The UG helper (Ultimate Guitar)',
        para('It opens Ultimate Guitar in its own Chrome window, where you log in once. Search here, pick the version you want there, and you’re back here while it saves the song:'),
        kinds,
        para(helper ? 'It works out of sight. Stop it from the ⋯ menu under the search.'
          : 'It works out of sight: no command window. Stop it from the ⋯ menu under the search. First time on this computer? Press Set up UG helper and run the file it downloads (once), then Start UG helper.'),
        helperRow));
    }
    const row = document.createElement('div');
    row.className = 'row spread';
    const all = dir && (helper || !helperPossible());
    row.append(button(all ? 'Done' : 'Not now', all ? 'primary' : 'ghost', () => dlg.close()));
    dlg.append(row);
  };
  await draw();
  if (!dlg.open) dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(), { once: true }));
}

// While you look for a song in the helper's Chrome, each song it finishes saving is made into one
// song here and opened.
const RUNS_MINUTES = 45;
let runs = null; // { since, until, timer }
let runsBusy = false;

async function checkRuns() {
  if (!runs || runsBusy) return;
  if (Date.now() > runs.until) { clearInterval(runs.timer); runs = null; showStatus(); return; }
  // taken before the first await: the timer, the window's focus and the tab showing again all call
  // this at once, and each found the same song and added it again (How Great Is Our God, 3 times)
  runsBusy = true;
  try {
    const dir = await grantedFolder();
    if (!dir) return;
    // a held song (a file not saved) waits: it comes in once you Retry or leave out that file
    const fresh = (await readyRuns(dir)).filter((r) => !r.held && new Date(r.finished).getTime() >= runs.since).reverse(); // oldest first
    const added = [];
    for (const r of fresh) {
      ctx.toast(`Adding “${r.song}” from the UG helper…`, 6000);
      added.push({ r, id: await importRun(r, true) });
    }
    if (added.length) showAdded(added);
  } catch (err) { console.error(err); } finally { runsBusy = false; }
}

export async function watchRuns() {
  if (!ctx || !canWatch) return;
  const since = runs?.since ?? Date.now() - 60e3;
  clearInterval(runs?.timer);
  runs = { since, until: Date.now() + RUNS_MINUTES * 60e3, timer: setInterval(checkRuns, 4000) };
  await showStatus();
}

async function changeFolder(toast) {
  try {
    const dir = await window.showDirectoryPicker({ id: 'tab-downloads', startIn: 'downloads', mode: 'read' });
    await setValue('downloadsDir', dir);
    toast(`Will check “${dir.name}” for new tabs.`);
    showStatus();
  } catch { /* cancelled */ }
}

/* ---------- auto-import while looking for tabs ---------- */

// After a tab site is opened, the folder is checked every few seconds (and whenever you
// come back to this tab) for a while, and each new tab file is added as it lands. Reading
// the folder needs permission, which the browser only asks for after a click, so it's
// given once with "Turn on auto-import" (Chrome can remember it).
const WATCH_MINUTES = 20;
const WATCH_EVERY = 3000;
let ctx = null; // { importFiles, openEditor, toast, openSong }
let watch = null; // { since, until, timer, query, url }
let busy = false;

async function grantedFolder() {
  const dir = await getValue('downloadsDir').catch(() => null);
  if (!dir) return null;
  try { return (await dir.queryPermission({ mode: 'read' })) === 'granted' ? dir : null; } catch { return null; }
}

// Watching the Downloads folder is a desktop Chrome / Edge feature; the Android app picks files instead.
const canWatch = 'showDirectoryPicker' in window && !window.fretboardAndroid;

async function autoImport() {
  if (!watch || busy) return;
  if (Date.now() > watch.until) { stopWatch(); return; }
  busy = true; // before the first await, as in checkRuns
  try {
    const dir = await grantedFolder();
    if (!dir) return;
    const seen = new Set((await getValue('importedFiles')) || []);
    const fresh = [];
    for await (const entry of dir.values()) {
      if (entry.kind !== 'file' || !TAB_FILE.test(entry.name)) continue;
      const file = await entry.getFile();
      if (file.lastModified >= watch.since && !seen.has(fileKey(file))) fresh.push(file);
    }
    if (!fresh.length) return;
    fresh.forEach((f) => seen.add(fileKey(f)));
    await setValue('importedFiles', [...seen].slice(-500));
    // Best fit for the searched song first; the page it came from is remembered as its source.
    const pick = watch.query ? bestMatch(fresh.map((f) => f.name), watch.query) : -1;
    if (pick > 0) fresh.unshift(...fresh.splice(pick, 1));
    if (watch.url) fresh.forEach((f) => { f.source = { url: watch.url, title: '' }; });
    const { ids } = await ctx.importFiles(fresh, { quietIfEmpty: true });
    // One new tab, or the one that matches the search: open it in play-along right away.
    if (ids?.length && (ids.length === 1 || pick >= 0) && !document.hidden) ctx.openSong(ids[0], { playAlong: true });
  } catch { /* folder gone or unreadable: try again next time */ } finally { busy = false; }
}

function stopWatch() {
  clearInterval(watch?.timer);
  watch = null;
  showStatus();
}

export async function watchDownloads({ query = '', url = '' } = {}) {
  if (!ctx || !canWatch) return;
  const since = watch?.since ?? Date.now() - 60e3; // a download that just finished counts
  clearInterval(watch?.timer);
  watch = { since, until: Date.now() + WATCH_MINUTES * 60e3, timer: setInterval(autoImport, WATCH_EVERY), query, url };
  await showStatus();
}

export function initQuickImport({ importFiles, openEditor, toast, openSong, askComputer }) {
  ctx = { importFiles, openEditor, toast, openSong, askComputer };
  showStatus();
  showQueue();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { autoImport(); checkRuns(); if (!helperState) showStatus(); } });
  window.addEventListener('focus', () => { autoImport(); checkRuns(); });
  window.addEventListener('focus', () => { if (document.body.classList.contains('drawer-open')) showReady(); }); // back from the collector
  $('lib-more-btn').addEventListener('click', (e) => moreMenu(e.currentTarget));
}
