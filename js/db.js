// IndexedDB storage: songs (Guitar Pro / MusicXML bytes, alphaTex or plain text tabs)
// and practice sessions. Everything stays in this browser unless sync is on (sync.js):
// every change fires a "librarychange" event so it can sync soon after.

const DB_NAME = 'fretboard';
const DB_VERSION = 2;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const has = (name) => db.objectStoreNames.contains(name);
      if (!has('songs')) db.createObjectStore('songs', { keyPath: 'id', autoIncrement: true });
      if (!has('sessions')) {
        const sessions = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
        sessions.createIndex('songId', 'songId');
      }
      // v2: small settings that localStorage can't hold (e.g. the Downloads folder handle).
      if (!has('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = undefined; reject(req.error); };
    req.onblocked = () => { dbPromise = undefined; };
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error || req?.error);
    tx.onabort = () => reject(tx.error || req?.error || new Error('Storage write failed'));
  });
}

const changed = (what) => globalThis.dispatchEvent?.(new CustomEvent('librarychange', { detail: what }));
const SYNCED_KEYS = ['setlists'];

export const listSongs = () => run('songs', 'readonly', (s) => s.getAll());
export const getSong = (id) => run('songs', 'readonly', (s) => s.get(id));
export const putSong = (song) => run('songs', 'readwrite', (s) => s.put(song)).then((id) => { changed('songs'); return id; });
export const deleteSong = (id) => run('songs', 'readwrite', (s) => s.delete(id)).then(() => changed('songs'));

// Read and write happen in one transaction, and calls are queued, so two updates made in the same
// moment (a start bar and a start time, say) both land instead of the second overwriting the first.
let updating = Promise.resolve();
export function updateSong(id, changes) {
  const job = updating.catch(() => {}).then(async () => {
    const db = await open();
    const song = await new Promise((resolve, reject) => {
      const tx = db.transaction('songs', 'readwrite');
      const store = tx.objectStore('songs');
      let merged;
      const get = store.get(id);
      get.onsuccess = () => {
        merged = get.result;
        if (!merged) return;
        Object.assign(merged, changes);
        // Opening a song isn't an edit (sync compares edit times).
        if (Object.keys(changes).some((k) => k !== 'lastOpened')) merged.updated = Date.now();
        store.put(merged);
      };
      tx.oncomplete = () => resolve(merged);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage write failed'));
    });
    if (song) changed('songs');
    return song;
  });
  updating = job;
  return job;
}

export const listSessions = () => run('sessions', 'readonly', (s) => s.getAll());
export const addSession = (session) => run('sessions', 'readwrite', (s) => s.add(session)).then((id) => { changed('sessions'); return id; });

export const getValue = (key) => run('kv', 'readonly', (s) => s.get(key));
export const setValue = (key, value) => run('kv', 'readwrite', (s) => s.put(value, key)).then(() => { if (SYNCED_KEYS.includes(key)) changed(key); });
