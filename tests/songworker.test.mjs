// Run: node tests/songworker.test.mjs
// A phone asks for a song, the worker (a second device of the same library) delivers it, the phone gets it.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncLibrary, memoryRemote } from '../js/sync.js';
import { wantRecord, wantOf, wantRetry } from '../js/wanted.js';
import { round, fileStore, candidates } from '../scripts/songworker.mjs';

function phone() {
  let nextId = 1;
  const songs = new Map();
  const clone = (v) => structuredClone(v);
  const d = {
    songs, state: {}, setlists: [], sessions: [],
    store: {
      listSongs: async () => [...songs.values()].map(clone),
      putSong: async (s) => { const song = clone(s); song.id ??= nextId++; songs.set(song.id, song); return song.id; },
      deleteSong: async (id) => { songs.delete(id); },
      getSetlists: async () => d.setlists,
      setSetlists: async (l) => { d.setlists = clone(l); },
      listSessions: async () => d.sessions,
      addSession: async (s) => { d.sessions.push(clone(s)); },
    },
  };
  return d;
}
const sync = async (d, remote) => { const o = await syncLibrary({ store: d.store, remote, state: d.state, device: 'phone' }); d.state = o.state; return o; };
const only = (d) => [...d.songs.values()][0];

const tmp = mkdtempSync(join(tmpdir(), 'songworker-'));
try {
  const remote = memoryRemote();
  const p = phone();
  const store = fileStore(join(tmp, 'library'));

  // the phone asks; the placeholder reaches the repository
  await p.store.putSong(wantRecord({ title: 'Ho Hey', artist: 'The Lumineers' }, Date.now() - 1000));
  await sync(p, remote);

  // a finished song, as fromlink.py writes it
  const fb = join(tmp, 'Ho_Hey.fretboard');
  const entry = { kind: 'gp', title: 'Ho Hey', artist: 'The Lumineers', fileName: 'Ho Hey.gp', data: { $bytes: Buffer.from([1, 2, 3]).toString('base64') },
    recording: { kind: 'youtube', id: 'SuZytYa71lk', title: 't', author: 'a' }, syncPoints: [[0, 2467], [4, 9000]], syncDone: true,
    autoSync: { from: 'yt2gp5' }, version: { type: 'official' }, sourceUrl: 'https://tabs.ultimate-guitar.com/tab/the-lumineers/ho-hey-official-2422311' };
  writeFileSync(fb, JSON.stringify({ format: 'fretboard-songs', version: 1, songs: [entry] }));

  // PASS: while it runs the phone sees "working"; afterwards the real song, same uid, no request left
  let seen = null;
  const asked = [];
  const pass = async (job) => {
    asked.push(job);
    await sync(p, remote);
    seen = wantOf(only(p))?.state;
    return { verdict: 'PASS', file: fb };
  };
  let out = await round({ store, remote, runner: pass });
  assert.deepEqual(out, { done: 1, failed: 0, asked: 1 });
  assert.deepEqual(asked, [{ title: 'Ho Hey', artist: 'The Lumineers', sync: true }]);
  assert.equal(seen, 'working', 'the phone shows the song as being fetched');
  const uid = only(p).uid;
  await sync(p, remote);
  const got = only(p);
  assert.equal(p.songs.size, 1, 'the placeholder is replaced, not duplicated');
  assert.equal(got.uid, uid);
  assert.equal(got.kind, 'gp');
  assert.equal(got.want, undefined);
  assert.deepEqual([got.recording.id, got.syncDone, got.syncPoints[0][1]], ['SuZytYa71lk', true, 2467]);
  assert.deepEqual([...new Uint8Array(got.data)], [1, 2, 3]);

  // nothing asked: nothing runs
  out = await round({ store, remote, runner: async () => { throw new Error('should not run'); } });
  assert.equal(out.asked, 0);

  // FAIL: the reason reaches the phone, nothing is delivered; "try again" asks once more and it can pass
  await p.store.putSong(wantRecord({ title: 'Riptide', artist: 'Vance Joy' }));
  await sync(p, remote);
  out = await round({ store, remote, runner: async () => ({ verdict: 'FAIL' }) });
  assert.deepEqual(out, { done: 0, failed: 1, asked: 1 });
  await sync(p, remote);
  const bad = [...p.songs.values()].find((s) => s.title === 'Riptide');
  assert.equal(bad.kind, 'text');
  assert.equal(wantOf(bad).state, 'failed');
  assert.match(wantOf(bad).reason, /don’t line up/);
  out = await round({ store, remote, runner: async () => ({ verdict: 'ERROR', reason: 'no official tab on Ultimate Guitar' }) });
  assert.equal(out.asked, 0, 'a failed one is not retried by itself');
  await p.store.putSong(wantRetry(bad));
  await sync(p, remote);
  out = await round({ store, remote, runner: async () => { throw new Error('boom'); } });
  assert.deepEqual(out, { done: 0, failed: 1, asked: 1 }, 'a crashing runner is a reason, not a crash');
  await sync(p, remote);
  assert.equal(wantOf([...p.songs.values()].find((s) => s.title === 'Riptide')).reason, 'boom');

  // the user chose "tab only" when asking: the runner is told so (no video search, no line-up) and the tab is delivered
  const tabEntry = { kind: 'gp', title: 'Count On Me', artist: 'Bruno Mars', fileName: 'Count On Me.gp', data: { $bytes: Buffer.from([9, 8]).toString('base64') }, version: { type: 'official' } };
  const tabFile = join(tmp, 'Count_On_Me.fretboard');
  writeFileSync(tabFile, JSON.stringify({ format: 'fretboard-songs', version: 1, songs: [tabEntry] }));
  await p.store.putSong(wantRecord({ title: 'Count On Me', artist: 'Bruno Mars', sync: false }));
  await sync(p, remote);
  const jobs = [];
  out = await round({ store, remote, runner: async (job) => { jobs.push(job); return { verdict: 'PASS', file: tabFile }; } });
  assert.deepEqual(out, { done: 1, failed: 0, asked: 1 });
  assert.deepEqual(jobs, [{ title: 'Count On Me', artist: 'Bruno Mars', sync: false }]);
  await sync(p, remote);
  const tabSong = [...p.songs.values()].find((s) => s.title === 'Count On Me');
  assert.deepEqual([tabSong.kind, tabSong.want, tabSong.recording, tabSong.syncPoints], ['gp', undefined, undefined, undefined], 'the tab, with no video or sync');

  // timing only (fromlink exit 4): the sync checks pass and only the tab's chords differ from the video: delivered like a PASS.
  // A plain LISTEN is not delivered, whatever file it made.
  const stressed = join(tmp, 'Stressed_Out.fretboard');
  writeFileSync(stressed, JSON.stringify({ format: 'fretboard-songs', version: 1, songs: [{ ...tabEntry, title: 'Stressed Out', artist: 'twenty one pilots', recording: { kind: 'youtube', id: 'pXRviuL6vMY', title: 't', author: 'a' }, syncPoints: [[0, 453], [4, 9000]] }] }));
  await p.store.putSong(wantRecord({ title: 'Stressed Out', artist: 'twenty one pilots' }));
  await sync(p, remote);
  out = await round({ store, remote, runner: async () => ({ verdict: 'LISTEN', file: stressed, video: 'pXRviuL6vMY', timingOnly: true }) });
  assert.deepEqual(out, { done: 1, failed: 0, asked: 1 });
  await sync(p, remote);
  const so = [...p.songs.values()].filter((s) => s.title === 'Stressed Out');
  assert.deepEqual([so.length, so[0].kind, so[0].want, so[0].syncPoints[0][1]], [1, 'gp', undefined, 453], 'delivered, with its sync, the placeholder replaced');
  await p.store.putSong(wantRecord({ title: 'Believer', artist: 'Imagine Dragons' }));
  await sync(p, remote);
  out = await round({ store, remote, runner: async () => ({ verdict: 'LISTEN', file: tabFile, video: 'x' }) });
  assert.deepEqual(out, { done: 0, failed: 1, asked: 1 }, 'a LISTEN that needs a listen stays on the computer');
  await sync(p, remote);
  assert.equal(wantOf([...p.songs.values()].find((s) => s.title === 'Believer')).state, 'failed');
  await p.store.deleteSong([...p.songs.values()].find((s) => s.title === 'Believer').id);
  await sync(p, remote);

  // paused and dry rounds fetch nothing
  await p.store.putSong(wantRecord({ title: 'Pompeii', artist: 'Bastille' }));
  await sync(p, remote);
  const never = async () => { throw new Error('should not run'); };
  assert.equal((await round({ store, remote, runner: never, paused: () => true })).asked, 1);
  assert.equal((await round({ store, remote, runner: never, dry: true })).done, 0);
  assert.equal(wantOf([...(await store.listSongs())].find((s) => s.title === 'Pompeii')).state, 'asked');

  // a delivered file that can't be read is a failure, not a lost song
  writeFileSync(fb, 'not json');
  out = await round({ store, remote, runner: async () => ({ verdict: 'PASS', file: fb }) });
  assert.deepEqual(out, { done: 0, failed: 1, asked: 1 });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// which videos are tried: the artist's own, official audio / lyric first, never covers or lyric reuploads
const found = [
  { id: 'mv', title: 'The Lumineers - Ho Hey (Official Video)', author: 'The Lumineers', seconds: 162, verified: true },
  { id: 'lyr', title: 'The Lumineers - Ho Hey (Lyrics)', author: 'Lounge Lyrics', seconds: 167 },
  { id: 'live', title: 'The Lumineers - Ho Hey (Live on KEXP)', author: 'KEXP', seconds: 178 },
  { id: 'cov', title: 'Ho Hey - The Lumineers (guitar cover)', author: 'Some Guitarist', seconds: 160 },
  { id: 'aud', title: 'Ho Hey (Official Audio)', author: 'The Lumineers - Topic', seconds: 160 },
];
const list = candidates(found, { title: 'Ho Hey', artist: 'The Lumineers' }).map((r) => r.id);
assert.equal(list[0], 'aud', 'the official audio before the music video');
assert.ok(list.includes('mv'));
assert.ok(!list.includes('cov') && !list.includes('lyr'), 'no covers, no fan lyric videos');
assert.ok(list.length <= 3);
console.log('songworker ok');
