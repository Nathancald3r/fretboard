// Run: node tests/sync.test.mjs
import assert from 'node:assert/strict';
import { syncLibrary, memoryRemote, githubRemote, exportBackup, importBackup, songRecord, songFromRecord, hashOf } from '../js/sync.js';

// A device: the same calls the app's IndexedDB store makes.
function device() {
  let nextId = 1;
  const songs = new Map();
  let setlists = [];
  const sessions = [];
  const clone = (v) => structuredClone(v);
  return {
    songs, sessions,
    get setlists() { return setlists; },
    state: {},
    store: {
      listSongs: async () => [...songs.values()].map(clone),
      putSong: async (s) => { const song = clone(s); song.id ??= nextId++; songs.set(song.id, song); return song.id; },
      deleteSong: async (id) => { songs.delete(id); },
      getSetlists: async () => clone(setlists),
      setSetlists: async (l) => { setlists = clone(l); },
      listSessions: async () => clone(sessions),
      addSession: async (s) => { sessions.push(clone(s)); },
    },
  };
}
const add = (d, song) => d.store.putSong({ added: 1000, ...song });
const titles = (d) => [...d.songs.values()].map((s) => s.title).sort();
const bytes = (...v) => new Uint8Array(v).buffer;
async function sync(d, remote) {
  const out = await syncLibrary({ store: d.store, remote, state: d.state });
  d.state = out.state;
  return out.result;
}

// Records round-trip, bytes included; play-along audio files stay local.
const gp = { id: 4, uid: 'u1', kind: 'gp', title: 'Song', data: bytes(1, 2, 255), lastOpened: 5, recording: { kind: 'file', data: bytes(9) }, syncPoints: [1] };
const rec = songRecord(gp);
assert.equal(rec.id, undefined);
assert.equal(rec.recording, undefined);
assert.equal(rec.syncPoints, undefined);
assert.deepEqual(JSON.parse(JSON.stringify(rec)).data, { $b64: 'AQL/' });
const back = songFromRecord(JSON.parse(JSON.stringify(rec)), gp);
assert.deepEqual([...new Uint8Array(back.data)], [1, 2, 255]);
assert.equal(back.id, 4);
assert.equal(back.recording.kind, 'file');
assert.equal(await hashOf(songRecord(back)), await hashOf(rec));
// notation parts (sheet music PDFs) inside a song travel with it, bytes intact
const withSheets = { kind: 'tex', title: 'Champion', data: 'tex', sheets: [{ name: 'Piano', program: 0, fileName: 'p.pdf', data: new Uint8Array([37, 80, 68, 70]).buffer }] };
const sb = songFromRecord(JSON.parse(JSON.stringify(songRecord(withSheets))));
assert.deepEqual([...new Uint8Array(sb.sheets[0].data)], [37, 80, 68, 70]);
assert.equal(sb.sheets[0].name, 'Piano');
assert.equal(songFromRecord(JSON.parse(JSON.stringify(songRecord({ kind: 'sheet', data: new Uint8Array([1]).buffer })))).kind, 'sheet', 'sheet music stays sheet music');
assert.ok(songRecord({ ...gp, recording: { kind: 'youtube', url: 'x' } }).recording, 'YouTube links sync');

// Two devices.
const remote = memoryRemote();
const A = device();
const B = device();
const a1 = await add(A, { kind: 'tex', title: 'Wonderwall', data: '\\title "W" . 0.6.4' });
await add(A, { kind: 'gp', title: 'Blackbird', data: bytes(1, 2, 3) });
await A.store.setSetlists([{ id: 77, name: 'Sunday', songIds: [a1] }]);
A.sessions.push({ songId: a1, title: 'Wonderwall', start: 111, seconds: 60 });

let r = await sync(A, remote);
assert.equal(r.uploaded, 2);
r = await sync(B, remote);
assert.equal(r.downloaded, 2);
assert.deepEqual(titles(B), ['Blackbird', 'Wonderwall']);
const bWonder = [...B.songs.values()].find((s) => s.title === 'Wonderwall');
assert.deepEqual(B.setlists[0].songIds, [bWonder.id], 'setlists map to the local ids');
assert.equal(B.sessions[0].songId, bWonder.id);
assert.deepEqual([...new Uint8Array([...B.songs.values()].find((s) => s.title === 'Blackbird').data)], [1, 2, 3]);

// Nothing changed: nothing moves.
r = await sync(A, remote);
assert.deepEqual([r.uploaded, r.downloaded, r.sessionsIn, r.sessionsOut], [0, 0, 0, 0]);
// Opening a song (lastOpened) is not a change.
A.songs.get(a1).lastOpened = 999;
r = await sync(A, remote);
assert.equal(r.uploaded, 0);

// An edit on B reaches A.
bWonder.transpose = 2; bWonder.updated = 5000;
B.songs.set(bWonder.id, bWonder);
await sync(B, remote);
r = await sync(A, remote);
assert.equal(r.downloaded, 1);
assert.equal(A.songs.get(a1).transpose, 2);
assert.equal(A.songs.get(a1).id, a1, 'kept its local id');

// Both edit the same song: the newer edit wins.
Object.assign(A.songs.get(a1), { capo: 3, updated: 9000 });
Object.assign(B.songs.get(bWonder.id), { capo: 1, updated: 8000 });
await sync(B, remote);
await sync(A, remote);
await sync(B, remote);
assert.equal(A.songs.get(a1).capo, 3);
assert.equal(B.songs.get(bWonder.id).capo, 3);

// A deletes Blackbird: B loses it too.
const aBlack = [...A.songs.values()].find((s) => s.title === 'Blackbird');
A.songs.delete(aBlack.id);
r = await sync(A, remote);
assert.equal(r.deletedThere, 1);
r = await sync(B, remote);
assert.equal(r.deletedHere, 1);
assert.deepEqual(titles(B), ['Wonderwall']);

// A new song and a session on B, a new setlist on A, synced both ways.
await add(B, { kind: 'text', title: 'Hallelujah', data: 'e|--0--|' });
B.sessions.push({ songId: bWonder.id, title: 'Wonderwall', start: 222, seconds: 30 });
await A.store.setSetlists([...A.setlists, { id: 88, name: 'Gig', songIds: [a1] }]);
await sync(B, remote);
await sync(A, remote);
await sync(B, remote);
assert.deepEqual(titles(A), ['Hallelujah', 'Wonderwall']);
assert.equal(A.sessions.length, 2);
assert.deepEqual(B.setlists.map((l) => l.name), ['Sunday', 'Gig']);

// The same file added on both devices (the demo songs) doesn't become two songs.
const C = device();
await add(C, { kind: 'tex', title: 'Wonderwall', data: '\\title "W" . 0.6.4' });
await sync(C, remote);
assert.deepEqual(titles(C), ['Hallelujah', 'Wonderwall']);

// Backups: export from A, restore into an empty device and into A again (no duplicates).
const backup = await exportBackup(A.store);
const D = device();
const res = await importBackup(D.store, backup);
assert.equal(res.downloaded, 2);
assert.deepEqual(titles(D), ['Hallelujah', 'Wonderwall']);
assert.equal(D.sessions.length, 2);
await importBackup(A.store, backup);
assert.deepEqual(titles(A), ['Hallelujah', 'Wonderwall']);
assert.equal(A.sessions.length, 2);
await assert.rejects(importBackup(D.store, '{"x":1}'), /isn’t a Fretboard backup/);

// The GitHub client: the requests it makes and how it reads the answers.
const calls = [];
const files = {};
const fakeFetch = async (url, opts) => {
  calls.push({ url, method: opts.method, auth: opts.headers.Authorization, body: opts.body && JSON.parse(opts.body) });
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (url === 'https://api.github.com/repos/me/lib') return json(200, { private: true });
  if (url === 'https://api.github.com/repos/me/pub') return json(200, { private: false });
  const path = decodeURIComponent(url.split('/contents/')[1] || '');
  if (opts.method === 'GET') return files[path] ? json(200, { sha: 's-' + path, size: 1, content: btoa(files[path]) }) : json(404, { message: 'Not Found' });
  if (opts.method === 'PUT') { files[path] = atob(opts.body && JSON.parse(opts.body).content); return json(201, { content: { sha: 'new' } }); }
  return json(200, {});
};
const gh = githubRemote({ repo: 'me/lib', token: 'test-token', fetch: fakeFetch });
await gh.check();
await assert.rejects(githubRemote({ repo: 'me/pub', token: 't', fetch: fakeFetch }).check(), /public/);
calls.length = 0;
const E = device();
await add(E, { kind: 'tex', title: 'Über', data: 'ü' });
await syncLibrary({ store: E.store, remote: gh, device: 'test' });
assert.ok(calls.every((c) => c.auth === 'Bearer test-token'));
const puts = calls.filter((c) => c.method === 'PUT');
assert.equal(puts.length, 2, 'one song file and the manifest');
assert.match(puts[0].url, /contents\/fretboard\/songs\/\w+\.json$/);
assert.match(puts[1].url, /contents\/fretboard\/library\.json$/);
assert.equal(new TextDecoder().decode(Uint8Array.from(atob(puts[0].body.content), (c) => c.charCodeAt(0))).includes('Über'), true, 'UTF-8 content');
// A sync that stopped halfway left a song file but no library.json: GitHub wants that file's
// sha ("422 sha wasn't supplied"), so the client reads it and writes over it.
const strict = { 'fretboard/songs/x.json': 'old' };
const strictFetch = async (url, opts) => {
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const p = decodeURIComponent(url.split('/contents/')[1] || '');
  if (opts.method === 'GET') return p in strict ? json(200, { sha: 'cur', size: 1, content: btoa(strict[p]) }) : json(404, {});
  const body = JSON.parse(opts.body);
  if (p in strict && body.sha !== 'cur') return json(422, { message: 'Invalid request. "sha" wasn\'t supplied.' });
  strict[p] = atob(body.content);
  return json(201, { content: { sha: 'cur2' } });
};
const half = githubRemote({ repo: 'me/lib', token: 't', fetch: strictFetch });
assert.equal(await half.put('fretboard/songs/x.json', 'new', undefined, 'm'), 'cur2');
assert.equal(strict['fretboard/songs/x.json'], 'new');
const refused = githubRemote({ repo: 'me/lib', token: 'x', fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
await assert.rejects(refused.get('fretboard/library.json'), /token was refused/);

console.log('sync: all tests passed');
