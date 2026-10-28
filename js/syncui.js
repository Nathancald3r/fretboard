// The Sync and backup panel: connects to the user's GitHub repository, syncs on start,
// soon after each change, and every few minutes while the app is open.
import { listSongs, putSong, deleteSong, listSessions, addSession, getValue, setValue } from './db.js';
import { syncLibrary, githubRemote, exportBackup, importBackup, SyncError } from './sync.js';

const $ = (id) => document.getElementById(id);
const CONFIG_KEY = 'fretboard-sync';
const AFTER_CHANGE = 15000;
const EVERY = 5 * 60 * 1000;

const store = {
  listSongs, putSong, deleteSong, listSessions, addSession,
  getSetlists: () => getValue('setlists'),
  setSetlists: (lists) => setValue('setlists', lists),
};

let config = null; // { repo, token }
let busy = false;
let again = false;
let applying = false; // our own writes while syncing don't schedule another sync
let soon = 0;
let lastSync = 0;
let toast = () => {};

function loadConfig() {
  try { config = JSON.parse(localStorage.getItem(CONFIG_KEY)) || null; } catch { config = null; }
  try { lastSync = Number(localStorage.getItem(CONFIG_KEY + '-at')) || 0; } catch { /* ignore */ }
}

function saveConfig() {
  try {
    if (config) localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    else localStorage.removeItem(CONFIG_KEY);
  } catch { /* ignore */ }
}

const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'a device';
  return os;
};

function ago(t) {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

function render(status, kind = '') {
  $('sync-off').hidden = !!config;
  $('sync-on').hidden = !config;
  if (!config) return;
  document.querySelector('.sync-dot').className = 'sync-dot ' + kind;
  $('sync-status').textContent = status ?? `Synced with ${config.repo} · ${ago(lastSync)}`;
  $('sync-now').disabled = busy;
}

function showError(message) {
  $('sync-error').textContent = message || '';
  $('sync-error').hidden = !message;
}

async function getState() { return (await getValue('syncState')) || {}; }

export const syncIsOn = () => !!config;

export async function syncNow() {
  if (!config) return;
  if (busy) { again = true; return; }
  busy = true;
  clearTimeout(soon);
  render('Syncing…', 'busy');
  showError('');
  try {
    const remote = githubRemote(config);
    let out;
    applying = true;
    try {
      out = await syncLibrary({ store, remote, state: await getState(), device: deviceName(), progress: (n, total) => total > 3 && render(`Syncing… ${n}/${total}`, 'busy') });
    } catch (e) {
      // Another device wrote the manifest meanwhile: once more on top of it.
      if (e instanceof SyncError && (e.status === 409 || e.status === 422)) out = await syncLibrary({ store, remote, state: await getState(), device: deviceName() });
      else throw e;
    } finally {
      applying = false;
    }
    await setValue('syncState', out.state);
    lastSync = Date.now();
    try { localStorage.setItem(CONFIG_KEY + '-at', String(lastSync)); } catch { /* ignore */ }
    const r = out.result;
    if (r.downloaded || r.deletedHere || r.sessionsIn) {
      window.dispatchEvent(new Event('librarysynced'));
      const parts = [r.downloaded && `${r.downloaded} song${r.downloaded > 1 ? 's' : ''} updated`, r.deletedHere && `${r.deletedHere} removed`, r.sessionsIn && `${r.sessionsIn} practice session${r.sessionsIn > 1 ? 's' : ''}`].filter(Boolean);
      toast('From your other devices: ' + parts.join(', ') + '.');
    }
    render();
  } catch (e) {
    render(navigator.onLine === false ? 'Offline: will sync when you’re back online' : 'Sync failed', 'bad');
    if (navigator.onLine !== false) showError(e instanceof SyncError ? e.message : 'Could not reach GitHub: ' + (e?.message || e));
  } finally {
    busy = false;
    $('sync-now').disabled = false;
    if (again) { again = false; syncNow(); }
  }
}

function scheduleSync() {
  if (!config) return;
  if (applying) { again = true; return; } // a change made while syncing: one more round after
  clearTimeout(soon);
  soon = setTimeout(() => { soon = 0; syncNow(); }, AFTER_CHANGE);
}

async function connect(e) {
  e.preventDefault();
  const repo = $('sync-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
  const token = $('sync-token').value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { showError('Enter the repository as owner/name, e.g. your-name/fretboard-library.'); return; }
  showError('');
  const btn = e.submitter || $('sync-form').querySelector('button');
  btn.disabled = true;
  try {
    await githubRemote({ repo, token }).check();
    config = { repo, token };
    saveConfig();
    $('sync-token').value = '';
    await syncNow();
  } catch (err) {
    showError(err instanceof SyncError ? err.message : 'Could not reach GitHub: ' + (err?.message || err));
  } finally {
    btn.disabled = false;
  }
}

function disconnect() {
  if (!confirm('Stop syncing on this device? Your songs stay here and in the repository.')) return;
  config = null;
  saveConfig();
  setValue('syncState', {});
  showError('');
  render();
}

async function downloadBackup() {
  const btn = $('backup-export');
  btn.disabled = true;
  try {
    applying = true;
    const text = await exportBackup(store);
    const name = `fretboard-backup-${new Date().toISOString().slice(0, 10)}.json`;
    if (window.fretboardAndroid) {
      // The Android app's WebView can't save blob downloads; its bridge writes to Downloads.
      const bytes = new TextEncoder().encode(text);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      window.fretboardAndroid.postMessage(JSON.stringify({ name, mime: 'application/json', data: btoa(bin) }));
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    showError('Could not make the backup: ' + (e?.message || e));
  } finally {
    applying = false;
    btn.disabled = false;
  }
}

async function restoreBackup(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const r = await importBackup(store, await file.text());
    window.dispatchEvent(new Event('librarysynced'));
    toast(`Backup restored: ${r.downloaded} song${r.downloaded === 1 ? '' : 's'} added or updated, ${r.sessionsIn} practice session${r.sessionsIn === 1 ? '' : 's'}.`, 5000);
    showError('');
  } catch (err) {
    showError(err instanceof SyncError ? err.message : 'Could not restore it: ' + (err?.message || err));
  }
}

export function initSync(hooks = {}) {
  toast = hooks.toast || toast;
  loadConfig();
  render();
  $('sync-form').addEventListener('submit', connect);
  $('sync-now').addEventListener('click', syncNow);
  $('sync-disconnect').addEventListener('click', disconnect);
  $('backup-export').addEventListener('click', downloadBackup);
  $('backup-import').addEventListener('change', restoreBackup);
  window.addEventListener('librarychange', scheduleSync);
  window.addEventListener('online', () => config && syncNow());
  document.addEventListener('visibilitychange', () => {
    if (!config) return;
    if (document.visibilityState === 'visible' && Date.now() - lastSync > 60000) syncNow();
    // Leaving the app (switching to another app on a phone): send pending changes now.
    if (document.visibilityState === 'hidden' && soon) { clearTimeout(soon); soon = 0; syncNow(); }
  });
  setInterval(() => { if (config && document.visibilityState === 'visible') syncNow(); }, EVERY);
  setInterval(() => { if (config && !busy) render(); }, 30000);
  if (config) setTimeout(syncNow, 1500);
}
