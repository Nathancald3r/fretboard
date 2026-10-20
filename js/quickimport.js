// One-click imports: paste a text tab straight from the clipboard, and pick up new
// tab files from the Downloads folder (Chrome / Edge on desktop).
import { getValue, setValue } from './db.js';

const $ = (id) => document.getElementById(id);
const TAB_FILE = /\.(gp|gp3|gp4|gp5|gpx|gp7|gp8|xml|musicxml|mxl|txt)$/i;
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
let watch = null; // { since, until, timer }
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
      ? 'Download the file in your browser, then press Import files and pick it from Downloads.'
      : 'Auto-import needs Chrome or Edge on a computer. Elsewhere, drop the downloaded file onto the library.';
    return;
  }
  const dir = await grantedFolder();
  el.hidden = false;
  el.innerHTML = '';
  if (dir) {
    const on = document.createElement('span');
    on.className = 'find-auto-on';
    on.textContent = watch ? `● Watching “${dir.name}” for new tab files…` : `● Auto-import on: tab files you download into “${dir.name}” are added by themselves.`;
    el.append(on);
  } else {
    el.append('Auto-import is off. ');
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
    const { ids } = await ctx.importFiles(fresh, { quietIfEmpty: true });
    // One new tab: open it right away.
    if (ids?.length === 1 && !document.hidden) ctx.openSong(ids[0]);
  } catch { /* folder gone or unreadable: try again next time */ } finally { busy = false; }
}

function stopWatch() {
  clearInterval(watch?.timer);
  watch = null;
  showAuto();
}

export async function watchDownloads() {
  if (!ctx || !canWatch) return;
  const since = watch?.since ?? Date.now() - 60e3; // a download that just finished counts
  clearInterval(watch?.timer);
  watch = { since, until: Date.now() + WATCH_MINUTES * 60e3, timer: setInterval(autoImport, WATCH_EVERY) };
  await showAuto();
}

export function initQuickImport({ importFiles, openEditor, toast, openSong }) {
  ctx = { importFiles, toast, openSong };
  showAuto();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) autoImport(); });
  window.addEventListener('focus', autoImport);
  $('btn-clip').hidden = !navigator.clipboard?.readText;
  $('btn-clip').addEventListener('click', () => pasteFromClipboard(openEditor));
  const folderSupported = canWatch;
  $('btn-downloads').hidden = !folderSupported;
  $('btn-folder').hidden = !folderSupported;
  $('btn-downloads').addEventListener('click', () => checkDownloads(importFiles, toast).then(showAuto));
  $('btn-folder').addEventListener('click', () => changeFolder(toast));
}
