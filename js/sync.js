// Library sync across devices: songs, setlists and the practice log, kept in a private
// GitHub repository of the user's own (contents API, fine-grained token). The same merge
// writes and restores backup files through an in-memory "remote". No DOM here: tested in
// tests/sync.test.mjs with a fake store and a mocked fetch.
//
// Each song has a uid shared by all devices. The repository holds fretboard/library.json
// (a manifest: song hashes, setlists, sessions, deleted songs) and one file per song.
// A three-way compare (this device / the last sync / the repository) decides, per song,
// whether to upload, download, delete or leave it. Audio files added for play-along stay
// on their device (YouTube links sync).

export const DIR = 'fretboard';
const MANIFEST = `${DIR}/library.json`;
const songPath = (uid) => `${DIR}/songs/${String(uid).replace(/[^\w-]/g, '')}.json`;

/* ---------- encoding ---------- */

export function toBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

const utf8 = (text) => toBase64(new TextEncoder().encode(text));
const fromUtf8 = (b64) => new TextDecoder().decode(fromBase64(b64.replace(/\s/g, '')));

// JSON with sorted keys, so the same data always hashes the same.
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}

export async function hashOf(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon(value)));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const newUid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 20);

const isBytes = (d) => d instanceof ArrayBuffer || ArrayBuffer.isView(d);
const localRecording = (song) => song.recording && song.recording.kind !== 'youtube';
// Fields that are this device's own: the local id, when it was last opened, and a play-along
// audio file with its sync points.
const LOCAL_ONLY = ['id', 'lastOpened', 'original']; // the untouched file from before editing stays on this device
const RECORDING_FIELDS = ['recording', 'syncPoints', 'syncOffset'];

/** The synced form of a song: plain JSON, bytes as base64. */
export function songRecord(song) {
  const rec = {};
  for (const [k, v] of Object.entries(song)) {
    if (LOCAL_ONLY.includes(k)) continue;
    if (RECORDING_FIELDS.includes(k) && localRecording(song)) continue;
    rec[k] = k === 'data' && isBytes(v) ? { $b64: toBase64(v) }
      : k === 'sheets' && Array.isArray(v) ? v.map((s) => ({ ...s, data: isBytes(s.data) ? { $b64: toBase64(s.data) } : s.data }))
      : v;
  }
  return rec;
}

/** A song from its synced form; `local` (the copy on this device) keeps its local-only fields. */
const SONG_KINDS = ['gp', 'xml', 'tex', 'text', 'sheet'];
const NUMBER_FIELDS = ['speed', 'bestSpeed', 'practiceSeconds', 'added', 'updated', 'lastOpened', 'trackIndex', 'syncOffset', 'videoMaster'];

export function songFromRecord(rec, local = null) {
  const song = {};
  // Records come from the sync repository or a backup file: keep only well-formed values, so
  // nothing in them can be taken for markup or reach the object prototype.
  for (const [k, v] of Object.entries(rec)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype' || k === 'id') continue;
    song[k] = k === 'data' && v && v.$b64 !== undefined ? fromBase64(v.$b64).buffer : v;
  }
  if (!SONG_KINDS.includes(song.kind)) song.kind = 'text';
  if (song.sheets !== undefined) { // notation parts: { name, program, fileName, data (PDF bytes) }
    song.sheets = Array.isArray(song.sheets) ? song.sheets.filter((s) => s && s.data?.$b64 !== undefined).map((s) => ({
      name: String(s.name || 'Part').slice(0, 80), program: Number.isFinite(s.program) ? s.program : 0,
      fileName: String(s.fileName || '').slice(0, 200), data: fromBase64(s.data.$b64).buffer })) : [];
    if (!song.sheets.length) delete song.sheets;
  }
  for (const k of NUMBER_FIELDS) if (song[k] !== undefined && !Number.isFinite(song[k])) delete song[k];
  if (song.sourceUrl !== undefined && !(typeof song.sourceUrl === 'string' && /^https?:\/\//.test(song.sourceUrl))) delete song.sourceUrl;
  if (song.version !== undefined) {
    const v = song.version;
    song.version = v && ['official', 'live', 'cover'].includes(v.type)
      ? { type: v.type, artist: String(v.artist || '').slice(0, 80), live: !!v.live, note: String(v.note || '').slice(0, 120) }
      : undefined;
    if (!song.version) delete song.version;
  }
  if (song.versionNote !== undefined && typeof song.versionNote !== 'string') delete song.versionNote;
  if (song.skips !== undefined) song.skips = Array.isArray(song.skips) ? song.skips.filter((k) => Array.isArray(k) && k.length === 2 && k.every(Number.isFinite) && k[1] > k[0]) : [];
  if (song.recording?.kind === 'youtube' && !/^[\w-]{11}$/.test(song.recording.id)) delete song.recording;
  if (local) {
    for (const k of LOCAL_ONLY) if (local[k] !== undefined) song[k] = local[k];
    if (localRecording(local) && !song.recording) for (const k of RECORDING_FIELDS) if (local[k] !== undefined) song[k] = local[k];
  }
  return song;
}

/* ---------- remotes ---------- */

export class SyncError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

/** GitHub contents API on repo "owner/name". */
export function githubRemote({ repo, token, fetch: fetchFn = globalThis.fetch.bind(globalThis) }) {
  const base = `https://api.github.com/repos/${repo}`;
  const path = (p) => p.split('/').map(encodeURIComponent).join('/');
  async function call(method, url, body, accept = 'application/vnd.github+json') {
    const res = await fetchFn(url, {
      method,
      cache: 'no-store',
      headers: { Accept: accept, Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch { /* ignore */ }
      const hint = { 401: 'The token was refused (expired or mistyped?).', 403: 'The token can’t write to this repository (it needs Contents: read and write).', 404: 'Repository not found (check the name, and that the token can see it).' }[res.status];
      throw new SyncError(hint || `GitHub: ${res.status} ${msg}`.trim(), res.status);
    }
    return res;
  }
  return {
    name: repo,
    async check() {
      const res = await call('GET', base);
      if (!res) throw new SyncError('Repository not found (check the name, and that the token can see it).', 404);
      const info = await res.json();
      if (!info.private) throw new SyncError('That repository is public. Use a private one: your library would be visible to everyone.');
      return info;
    },
    async get(p) {
      const res = await call('GET', `${base}/contents/${path(p)}`);
      if (!res) return null;
      const info = await res.json();
      if (info.content || !info.size) return { sha: info.sha, text: fromUtf8(info.content || '') };
      // Over 1 MB the API leaves the content out; fetch it raw.
      const raw = await call('GET', `${base}/contents/${path(p)}`, null, 'application/vnd.github.raw+json');
      return { sha: info.sha, text: await raw.text() };
    },
    async put(p, text, sha, message) {
      const res = await call('PUT', `${base}/contents/${path(p)}`, { message, content: utf8(text), ...(sha ? { sha } : {}) });
      return (await res.json()).content.sha;
    },
    async remove(p, sha, message) {
      await call('DELETE', `${base}/contents/${path(p)}`, { message, sha });
    },
  };
}

/** Files in memory (for backup files and tests): { path: text }. */
export function memoryRemote(files = {}) {
  let n = 0;
  const shas = {};
  const sha = (p) => (shas[p] ??= 'm' + ++n);
  return {
    name: 'backup',
    files,
    async get(p) { return p in files ? { sha: sha(p), text: files[p] } : null; },
    async put(p, text, oldSha) {
      if (p in files && oldSha !== sha(p)) throw new SyncError('Changed meanwhile', 409);
      files[p] = text;
      shas[p] = 'm' + ++n;
      return shas[p];
    },
    async remove(p) { delete files[p]; delete shas[p]; },
  };
}

/* ---------- the merge ---------- */

const emptyManifest = () => ({ format: 'fretboard-library', version: 1, songs: {}, deleted: {}, setlists: null, setlistsHash: null, sessions: [] });
const sessionKey = (s) => `${s.start}|${s.seconds}`;

/**
 * One sync. store: { listSongs, putSong(song) → id, deleteSong(id), getSetlists, setSetlists,
 * listSessions, addSession }. state: what the last sync left ({ songs: { uid: hash },
 * setlists: hash }); the new state is returned with counts of what moved.
 */
export async function syncLibrary({ store, remote, state = {}, device = 'a device', progress = () => {} }) {
  const prev = { songs: { ...(state.songs || {}) }, setlists: state.setlists ?? null };
  const next = { songs: {}, setlists: null };
  const result = { uploaded: 0, downloaded: 0, deletedHere: 0, deletedThere: 0, sessionsIn: 0, sessionsOut: 0 };

  const mf = await remote.get(MANIFEST);
  const manifest = mf ? { ...emptyManifest(), ...JSON.parse(mf.text) } : emptyManifest();
  if (manifest.format !== 'fretboard-library') throw new SyncError('This repository has other files in fretboard/library.json.');
  let changed = !mf;
  const msg = (what) => `${what} (from ${device})`;

  // Songs on this device, each with a uid. A song never synced before that the repository
  // already has under another uid (the same file added on two devices, the demo songs) takes
  // that uid instead of becoming a duplicate.
  const local = new Map();
  const songs = await store.listSongs();
  const taken = new Set(songs.map((s) => s.uid).filter(Boolean));
  for (const song of songs) {
    const fresh = !song.uid || (!prev.songs[song.uid] && !manifest.songs[song.uid]);
    if (fresh) {
      const dataHash = await hashOf(songRecord(song).data ?? null);
      const twin = Object.entries(manifest.songs).find(([uid, r]) => !taken.has(uid) && r.dataHash === dataHash && r.title === song.title);
      const uid = twin ? twin[0] : song.uid || newUid();
      if (uid !== song.uid) { taken.add(uid); song.uid = uid; await store.putSong(song); }
    }
    local.set(song.uid, { song, hash: await hashOf(songRecord(song)) });
  }

  const uids = new Set([...local.keys(), ...Object.keys(manifest.songs), ...Object.keys(prev.songs)]);
  let done = 0;
  for (const uid of uids) {
    progress(++done, uids.size);
    const L = local.get(uid);
    const R = manifest.songs[uid];
    const B = prev.songs[uid];
    const upload = async () => {
      const rec = songRecord(L.song);
      const sha = await remote.put(songPath(uid), JSON.stringify({ format: 'fretboard-song', version: 1, song: rec }), R?.sha, msg(`${R ? 'Update' : 'Add'} “${L.song.title}”`));
      manifest.songs[uid] = { hash: L.hash, dataHash: await hashOf(rec.data ?? null), sha, title: L.song.title, artist: L.song.artist || '', updated: L.song.updated || L.song.added || 0 };
      delete manifest.deleted[uid];
      next.songs[uid] = L.hash;
      changed = true;
      result.uploaded++;
    };
    const download = async () => {
      const file = await remote.get(songPath(uid));
      if (!file) { if (L) next.songs[uid] = B; return; }
      const song = songFromRecord(JSON.parse(file.text).song, L?.song);
      song.uid = uid;
      const id = await store.putSong(song);
      if (song.id === undefined) song.id = id;
      local.set(uid, { song, hash: await hashOf(songRecord(song)) });
      next.songs[uid] = R.hash;
      result.downloaded++;
    };
    if (L && !R) {
      if (manifest.deleted[uid] && L.hash === B) {
        await store.deleteSong(L.song.id);
        local.delete(uid);
        result.deletedHere++;
      } else await upload();
    } else if (!L && R) {
      if (B && R.hash === B) {
        // Deleted on this device since the last sync.
        await remote.remove(songPath(uid), R.sha, msg(`Delete “${R.title}”`));
        delete manifest.songs[uid];
        manifest.deleted[uid] = Date.now();
        changed = true;
        result.deletedThere++;
      } else await download(); // new elsewhere, or changed there after this device deleted it
    } else if (L && R) {
      if (L.hash === R.hash) next.songs[uid] = L.hash;
      else if (R.hash === B) await upload();
      else if (L.hash === B) await download();
      else if ((L.song.updated || L.song.added || 0) >= (R.updated || 0)) await upload();
      else await download();
    }
  }

  // Setlists, with songs as uids so every device can map them to its own ids.
  const idToUid = new Map([...local.values()].map(({ song }) => [song.id, song.uid]));
  const uidToId = new Map([...local.values()].map(({ song }) => [song.uid, song.id]));
  const localSets = ((await store.getSetlists()) || []).map((l) => ({ ...l, songIds: undefined, songs: l.songIds.map((id) => idToUid.get(id)).filter(Boolean) }));
  const LS = await hashOf(localSets);
  const RS = manifest.setlistsHash;
  const BS = prev.setlists;
  const writeLocalSets = async (sets) => {
    await store.setSetlists(sets.map(({ songs, ...l }) => ({ ...l, songIds: songs.map((u) => uidToId.get(u)).filter((id) => id !== undefined) })));
  };
  if (!manifest.setlists || RS === BS && LS !== RS) {
    if (localSets.length || manifest.setlists) { manifest.setlists = localSets; manifest.setlistsHash = LS; changed = true; }
    next.setlists = LS;
  } else if (LS === RS) next.setlists = LS;
  else if (LS === BS) { await writeLocalSets(manifest.setlists); next.setlists = RS; } else {
    // Both changed: keep every list; a list on both sides keeps this device's version.
    const merged = [...localSets, ...manifest.setlists.filter((r) => !localSets.some((l) => l.id === r.id))];
    await writeLocalSets(merged);
    manifest.setlists = merged;
    manifest.setlistsHash = await hashOf(merged);
    next.setlists = manifest.setlistsHash;
    changed = true;
  }

  // Practice sessions: only ever added, so the union of both sides.
  const localSessions = await store.listSessions();
  const have = new Set(localSessions.map(sessionKey));
  const there = new Set(manifest.sessions.map(sessionKey));
  for (const s of localSessions) {
    const out = { song: idToUid.get(s.songId) ?? null, title: s.title, artist: s.artist, start: s.start, seconds: s.seconds, maxSpeed: s.maxSpeed ?? null };
    if (!there.has(sessionKey(out))) { manifest.sessions.push(out); there.add(sessionKey(out)); changed = true; result.sessionsOut++; }
  }
  for (const s of manifest.sessions) {
    if (have.has(sessionKey(s))) continue;
    await store.addSession({ songId: uidToId.get(s.song) ?? null, title: s.title, artist: s.artist, start: s.start, seconds: s.seconds, maxSpeed: s.maxSpeed });
    have.add(sessionKey(s));
    result.sessionsIn++;
  }

  if (changed) {
    manifest.updated = Date.now();
    await remote.put(MANIFEST, JSON.stringify(manifest), mf?.sha, msg('Sync library'));
  }
  return { state: next, result, songs: Object.keys(manifest.songs).length };
}

/** A backup file (JSON text) of everything in the store. */
export async function exportBackup(store) {
  const remote = memoryRemote();
  await syncLibrary({ store, remote, device: 'backup' });
  return JSON.stringify({ format: 'fretboard-backup', version: 1, created: new Date().toISOString(), files: remote.files });
}

/** Merges a backup file into the store (nothing is deleted). */
export async function importBackup(store, text) {
  let backup;
  try { backup = JSON.parse(text); } catch { throw new SyncError('That file isn’t a Fretboard backup.'); }
  if (backup?.format !== 'fretboard-backup' || !backup.files) throw new SyncError('That file isn’t a Fretboard backup.');
  const remote = memoryRemote({ ...backup.files });
  // A store that never deletes: a song missing from the backup stays.
  const keep = { ...store, deleteSong: async () => {} };
  const { result } = await syncLibrary({ store: keep, remote, device: 'backup' });
  return result;
}
