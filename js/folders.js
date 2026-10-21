// Folders and ratings: a song's folder is just a name on the song ({ folder }), so it travels with
// the song; empty folders are remembered in the kv store on this device.
import { listSongs, updateSong, getValue, setValue } from './db.js';

export const loadFolders = async () => (await getValue('folders')) || [];
const saveFolders = (list) => setValue('folders', [...new Set(list)].sort((a, b) => a.localeCompare(b)));
const changed = () => window.dispatchEvent(new Event('songschange'));

export async function addFolder(name) {
  name = name.trim();
  if (name) await saveFolders([...(await loadFolders()), name]);
  changed();
}

export async function moveSong(id, folder) {
  await updateSong(id, { folder: folder || null });
  changed();
}

export async function renameFolder(from, to) {
  to = to.trim();
  if (!to || to === from) return;
  for (const s of await listSongs()) if (s.folder === from) await updateSong(s.id, { folder: to });
  await saveFolders((await loadFolders()).filter((f) => f !== from).concat(to));
  changed();
}

export async function deleteFolder(name) {
  for (const s of await listSongs()) if (s.folder === name) await updateSong(s.id, { folder: null });
  await saveFolders((await loadFolders()).filter((f) => f !== name));
  changed();
}

export async function rateSong(id, rating) {
  await updateSong(id, { rating: Math.max(0, Math.min(5, rating)) || null });
  changed();
}
