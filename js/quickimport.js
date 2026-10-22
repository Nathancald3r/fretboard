// One-click imports: paste a text tab straight from the clipboard, and pick up new
// tab files from the Downloads folder (Chrome / Edge on desktop).
import { getValue, setValue } from './db.js';
import { bestMatch, matchScore } from './tabsources.js';

const $ = (id) => document.getElementById(id);
const TAB_FILE = /\.(gp|gp3|gp4|gp5|gpx|gp7|gp8|xml|musicxml|mxl|txt|pdf)$/i;
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
  if (!query) { toast('Type the song in the box at the top first, then press this.', 5000); $('find-query').focus(); return; }
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
  importFiles(await Promise.all(handles.map((h) => h.getFile())));
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
      runs.push({ key, dir: entry, song: String(m.song || entry.name) + (what ? ` (${what})` : ''), tracks, finished: String(m.finished || ''),
        title: String(m.song || ''), artist: String(m.artist || ''), replace: m.replace === true });
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
        box.append('Songs saved by the UG collector show up here. ');
        const b = button('Check for them', 'ghost small', async () => {
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
    const kind = /\.pdf$/i.test(r.tracks[0].file) ? `${n} PDF${n > 1 ? 's' : ''}` : /\.txt$/i.test(r.tracks[0].file) ? 'a text file' : 'a Guitar Pro file';
    text.textContent = `“${r.song}” is ready: ${kind} saved by the UG collector.${runs.length > 1 ? ` ${runs.length - 1} more after this.` : ''}`;
    box.append(text, button('Review & create', 'primary small', () => importRun(r)), button('Not now', 'ghost small', async () => { await markRun(r.key); showReady(); }));
  } catch { $('lib-ready').hidden = true; } finally { readyBusy = false; }
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// auto: made into one song straight away (no review), as the UG helper's songs are.
async function importRun(r, auto = false) {
  const files = [];
  for (const t of r.tracks) {
    try { files.push(await (await r.dir.getFileHandle(t.file)).getFile()); } catch { /* moved or deleted: left out */ }
  }
  if (!files.length) { ctx.toast(`The files for “${r.song}” aren’t in its folder any more.`, 5000); await markRun(r.key); showReady(); return null; }
  if (auto) await markRun(r.key); // taken now, so it's never added twice
  // replace: "Replace the old files" in the UG helper, so the song already in the library is updated, not added again
  const { ids } = await ctx.importFiles(files, { quietIfEmpty: true, replace: r.replace, ...(auto ? { auto: { title: r.title, artist: r.artist } } : {}) });
  if (ids?.length && !auto) await markRun(r.key); // cancelled: it stays offered
  showReady();
  return ids?.[0] ?? null;
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

/** Starts the helper through its link and waits for it; its status, or null when it didn't come up. */
export async function startHelper(waitMs = 30000) {
  if (!helperPossible()) return null;
  helperState = 'starting';
  showHelper();
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
  await showHelper(s);
  return s;
}

/** The UG helper line in Find tabs online: running, or a button that starts it. */
export async function showHelper(status) {
  const el = $('find-helper');
  if (!el || !helperPossible()) return;
  const s = status === undefined ? await ugHelper() : status;
  el.hidden = false;
  el.innerHTML = '';
  const setup = document.createElement('a');
  setup.href = SETUP_URL;
  setup.download = 'Set up UG helper.cmd';
  setup.textContent = 'Set up UG helper';
  setup.title = 'Once per computer: download and run it (it installs the helper for your Windows user only)';
  if (s) {
    const on = document.createElement('span');
    on.className = 'find-auto-on';
    on.textContent = '● UG helper running: a search opens the best match in its Chrome, out of sight, and Official and Pro songs are saved and added here by themselves. ';
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'ghost small';
    show.textContent = 'Show UG window';
    show.title = 'Brings the UG helper\'s Chrome up, full screen (clicking it in the taskbar does too)';
    show.addEventListener('click', showCollector);
    el.append(on, show);
    return;
  }
  if (helperState === 'starting') {
    el.append('Starting the UG helper… (if Chrome asks to open it, tick Always allow and press Open)');
    return;
  }
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost small';
  b.textContent = 'Start UG helper';
  b.title = 'Opens the UG helper: Official / Pro songs and Guitar Pro tabs are then added here by themselves';
  b.addEventListener('click', () => startHelper());
  if (helperState === 'failed') {
    el.append('The UG helper didn’t start. First time on this computer? Download and run ', setup, ' once, then ', b);
  } else if (helperKnown()) {
    el.append(b, ' Official and Pro songs and Guitar Pro tabs you open in it are added here by themselves.');
  } else {
    el.append(b, ' First time on this computer? ', setup, ' once (Windows).');
  }
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

// While you look for a song in the helper's Chrome, each song it finishes saving is made into one
// song here and opened.
const RUNS_MINUTES = 45;
let runs = null; // { since, until, timer }
let runsBusy = false;

async function checkRuns() {
  if (!runs || runsBusy) return;
  if (Date.now() > runs.until) { clearInterval(runs.timer); runs = null; showAuto(); return; }
  const dir = await grantedFolder();
  if (!dir) return;
  runsBusy = true;
  try {
    const fresh = (await readyRuns(dir)).filter((r) => new Date(r.finished).getTime() >= runs.since).reverse(); // oldest first
    for (const r of fresh) {
      ctx.toast(`Adding “${r.song}” from the UG helper…`, 6000);
      const id = await importRun(r, true);
      if (id && fresh.at(-1) === r) ctx.openSong(id, { playAlong: false });
    }
  } catch (err) { console.error(err); } finally { runsBusy = false; }
}

export async function watchRuns() {
  if (!ctx || !canWatch) return;
  const since = runs?.since ?? Date.now() - 60e3;
  clearInterval(runs?.timer);
  runs = { since, until: Date.now() + RUNS_MINUTES * 60e3, timer: setInterval(checkRuns, 4000) };
  await showAuto();
}

async function changeFolder(toast) {
  try {
    const dir = await window.showDirectoryPicker({ id: 'tab-downloads', startIn: 'downloads', mode: 'read' });
    await setValue('downloadsDir', dir);
    toast(`Will check “${dir.name}” for new tabs.`);
    showAuto();
  } catch { /* cancelled */ }
}

/* ---------- auto-import while looking for tabs ---------- */

// After a tab site is opened, the folder is checked every few seconds (and whenever you
// come back to this tab) for a while, and each new tab file is added as it lands. Reading
// the folder needs permission, which the browser only asks for after a click, so it's
// given once with "Turn on auto-import" (Chrome can remember it).
const WATCH_MINUTES = 20;
const WATCH_EVERY = 3000;
let ctx = null; // { importFiles, toast, openSong }
let watch = null; // { since, until, timer, query, url }
let busy = false;

async function grantedFolder() {
  const dir = await getValue('downloadsDir').catch(() => null);
  if (!dir) return null;
  try { return (await dir.queryPermission({ mode: 'read' })) === 'granted' ? dir : null; } catch { return null; }
}

// Watching the Downloads folder is a desktop Chrome / Edge feature; the Android app picks files instead.
const canWatch = 'showDirectoryPicker' in window && !window.fretboardAndroid;

async function showAuto() {
  const el = $('find-auto');
  if (!canWatch) {
    el.hidden = false;
    el.textContent = window.fretboardAndroid
      ? 'GProTab and 911tabs add the file to your library by themselves. For Ultimate Guitar: in your browser tick Desktop site (⋮ menu), log in, tap Download Guitar Pro tab, then press Import files here and pick it from Downloads.'
      : 'Auto-import needs Chrome or Edge on a computer. Elsewhere, drop the downloaded file onto the library.';
    return;
  }
  const dir = await grantedFolder();
  el.hidden = false;
  el.innerHTML = '';
  if (dir) {
    const on = document.createElement('span');
    on.className = 'find-auto-on';
    on.textContent = runs ? '● Auto-import on: what the UG helper saves is added here as one song.'
      : watch ? '● Waiting for your download: save the Guitar Pro file on the site and it opens here, ready for play-along.' : `● Auto-import on: tab files you download into “${dir.name}” are added by themselves.`;
    el.append(on);
  } else {
    el.append(runs ? 'One click, once, so the songs the UG helper saves are added here by themselves: ' : watch ? 'One click, once, so the file you download opens here by itself: ' : 'Auto-import is off. ');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost small';
    b.textContent = 'Turn on auto-import';
    b.title = 'Pick your Downloads folder once; new tab files there are then added by themselves';
    b.addEventListener('click', async () => {
      try { await folderHandle(); } catch { return; }
      await showAuto();
    });
    el.append(b);
  }
}

async function autoImport() {
  if (!watch || busy) return;
  if (Date.now() > watch.until) { stopWatch(); return; }
  const dir = await grantedFolder();
  if (!dir) return;
  busy = true;
  try {
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
  showAuto();
}

export async function watchDownloads({ query = '', url = '' } = {}) {
  if (!ctx || !canWatch) return;
  const since = watch?.since ?? Date.now() - 60e3; // a download that just finished counts
  clearInterval(watch?.timer);
  watch = { since, until: Date.now() + WATCH_MINUTES * 60e3, timer: setInterval(autoImport, WATCH_EVERY), query, url };
  await showAuto();
}

export function initQuickImport({ importFiles, openEditor, toast, openSong }) {
  ctx = { importFiles, toast, openSong };
  showAuto();
  showHelper();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { autoImport(); checkRuns(); if (!helperState) showHelper(); } });
  window.addEventListener('focus', () => { autoImport(); checkRuns(); });
  window.addEventListener('focus', () => { if (!$('view-library').hidden) showReady(); }); // back from the collector
  $('btn-clip').hidden = !navigator.clipboard?.readText;
  $('btn-clip').addEventListener('click', () => pasteFromClipboard(openEditor));
  const folderSupported = canWatch;
  $('btn-downloads').hidden = !folderSupported;
  $('btn-folder').hidden = !folderSupported;
  $('btn-song-pdfs').hidden = !folderSupported;
  $('btn-song-pdfs').addEventListener('click', () => importSongPdfs(importFiles, toast));
  $('btn-downloads').addEventListener('click', () => checkDownloads(importFiles, toast).then(showAuto));
  $('btn-folder').addEventListener('click', () => changeFolder(toast));
  if (canWatch && 'showOpenFilePicker' in window) {
    $('file-input').closest('label').addEventListener('click', (e) => {
      if (e.target === $('file-input')) return; // the fallback's own click
      e.preventDefault();
      pickFiles(importFiles);
    });
  }
}
