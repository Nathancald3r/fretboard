// Run: node tests/wanted.test.mjs
import assert from 'node:assert/strict';
import { wantRecord, wantOf, wantLabel, wantSync, nextWanted, wantWorking, wantFailed, wantRetry, wantDone, cleanWant } from '../js/wanted.js';
import { songFromRecord, songRecord } from '../js/sync.js';

const t0 = 1_000_000;
const w = wantRecord({ title: ' Ho Hey ', artist: 'The Lumineers' }, t0);
assert.deepEqual([w.kind, w.title, w.artist, w.data, w.want], ['text', 'Ho Hey', 'The Lumineers', '', { state: 'asked', at: t0 }]);
assert.equal(wantLabel(w), 'Asked: your computer will get it');
assert.equal(wantLabel({ kind: 'gp', title: 'x' }), '');

// the choice made when asking: official tab only (no video, no line-up) survives every state change
const tabOnly = { ...wantRecord({ title: 'Ho Hey', sync: false }, t0), uid: 't' };
assert.deepEqual(tabOnly.want, { state: 'asked', at: t0, sync: false });
assert.deepEqual([wantSync(w), wantSync(tabOnly), wantSync({ kind: 'gp' })], [true, false, true], 'sync is the default');
assert.equal(wantLabel(tabOnly), 'Asked: your computer will get the tab (no video)');
assert.equal(wantOf(wantWorking(tabOnly, 'PC', t0 + 1)).sync, false);
assert.equal(wantOf(wantFailed(tabOnly, 'x', t0 + 2)).sync, false);
assert.equal(wantOf(wantRetry(wantFailed(tabOnly, 'x', t0 + 2), t0 + 3)).sync, false);
assert.equal('sync' in wantOf(wantRetry(w, t0 + 3)), false, 'a normal request carries no flag');

// the queue: oldest asked first; a "working" one only when it has been stuck for hours
const a = { ...wantRecord({ title: 'A' }, t0 + 50), uid: 'a' };
const b = { ...wantRecord({ title: 'B' }, t0 + 10), uid: 'b' };
const busy = { ...wantWorking({ ...wantRecord({ title: 'C' }, t0), uid: 'c' }, 'PC', t0 + 100), uid: 'c' };
const bad = { ...wantFailed({ ...wantRecord({ title: 'D' }, t0), uid: 'd' }, 'no official tab', t0 + 5), uid: 'd' };
assert.deepEqual(nextWanted([a, b, busy, bad, { kind: 'gp', title: 'plain' }], t0 + 1000).map((s) => s.uid), ['b', 'a']);
assert.deepEqual(nextWanted([busy], t0 + 100 + 3 * 3600 * 1000).map((s) => s.uid), ['c'], 'a worker that died mid-song is retried');
assert.equal(wantOf(bad).reason, 'no official tab');
assert.equal(wantLabel(bad), 'Couldn’t get it: no official tab');
assert.equal(wantLabel(busy), 'Your computer is getting it…');
assert.equal(wantRetry(bad, t0 + 9).want.state, 'asked');

// finished: the real song under the placeholder's uid and added date, no request left
const made = { kind: 'gp', title: 'Ho Hey', artist: 'The Lumineers', data: new Uint8Array([1]).buffer, want: { state: 'asked', at: 1 }, syncPoints: [[0, 2467]], syncDone: true };
const done = wantDone({ ...w, uid: 'u1', id: 7 }, made, t0 + 5000);
assert.deepEqual([done.uid, done.id, done.added, done.updated, done.want, done.syncDone], ['u1', 7, t0, t0 + 5000, undefined, true]);

// records from the repository are cleaned
assert.equal(cleanWant({ state: 'bogus' }), null);
assert.equal(cleanWant('x'), null);
assert.deepEqual(cleanWant({ state: 'failed', at: 5, reason: 'x'.repeat(500), junk: 1 }).reason.length, 300);
const back = songFromRecord(JSON.parse(JSON.stringify(songRecord({ ...w, uid: 'u1' }))));
assert.deepEqual(back.want, { state: 'asked', at: t0 }, 'the request travels with the song');
assert.equal(songFromRecord({ kind: 'text', title: 'x', want: { state: 'nope' } }).want, undefined);
console.log('wanted ok');
