// IndexedDB storage: songs (Guitar Pro / MusicXML bytes, alphaTex or plain text tabs)
// and practice sessions. Everything stays in this browser.

const DB_NAME = 'fretboard';
const DB_VERSION = 1;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('songs', { keyPath: 'id', autoIncrement: true });
      const sessions = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
      sessions.createIndex('songId', 'songId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const listSongs = () => run('songs', 'readonly', (s) => s.getAll());
export const getSong = (id) => run('songs', 'readonly', (s) => s.get(id));
export const putSong = (song) => run('songs', 'readwrite', (s) => s.put(song));
export const deleteSong = (id) => run('songs', 'readwrite', (s) => s.delete(id));

export async function updateSong(id, changes) {
  const song = await getSong(id);
  if (!song) return;
  Object.assign(song, changes);
  await putSong(song);
  return song;
}

export const listSessions = () => run('sessions', 'readonly', (s) => s.getAll());
export const addSession = (session) => run('sessions', 'readwrite', (s) => s.add(session));
