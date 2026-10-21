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
      runs.push({ key, dir: entry, song: String(m.song || entry.name) + (what ? ` (${what})` : ''), tracks, finished: String(m.finished || '') });
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

async function importRun(r) {
  const files = [];
  for (const t of r.tracks) {
    try { files.push(await (await r.dir.getFileHandle(t.file)).getFile()); } catch { /* moved or deleted: left out */ }
  }
  if (!files.length) { ctx.toast(`The files for “${r.song}” aren’t in its folder any more.`, 5000); await markRun(r.key); showReady(); return; }
  const { ids } = await ctx.importFiles(files, { quietIfEmpty: true });
  if (ids?.length) await markRun(r.key); // cancelled: it stays offered
  showReady();
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
    on.textContent = watch ? '● Waiting for your download: save the Guitar Pro file on the site and it opens here, ready for play-along.' : `● Auto-import on: tab files you download into “${dir.name}” are added by themselves.`;
    el.append(on);
  } else {
    el.append(watch ? 'One click, once, so the file you download opens here by itself: ' : 'Auto-import is off. ');
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) autoImport(); });
  window.addEventListener('focus', autoImport);
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
