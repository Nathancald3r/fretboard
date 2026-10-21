import assert from 'node:assert/strict';
import { chartType, filterSongs, folderNames, SORTS } from '../js/songmeta.js';

assert.equal(chartType({ kind: 'gp' }), 'pro');
assert.equal(chartType({ kind: 'tex', fileName: 'Song.pdf' }), 'pro'); // read from a PDF: shown in the library
assert.equal(chartType({ kind: 'tex' }), 'exercise');
assert.equal(chartType({ kind: 'xml' }), 'pro');
assert.equal(chartType({ kind: 'tex' }), 'exercise');
assert.equal(chartType({ kind: 'text', data: 'e|-----0-----3-----|\nB|---1-----0-----1---|' }), 'tab');
assert.equal(chartType({ kind: 'text', data: 'G      D\nAmazing grace how sweet\nEm     C' }), 'chords');

const songs = [
  { id: 1, kind: 'gp', title: 'B', artist: 'x', rating: 2, folder: 'Worship', added: 1 },
  { id: 2, kind: 'text', title: 'A', artist: 'y', data: 'G D', rating: 5, added: 2 },
  { id: 3, kind: 'tex', title: 'Warm-up', artist: 'Exercise', added: 3 },
];
assert.deepEqual(filterSongs(songs).map((s) => s.id), [1, 2]);
assert.deepEqual(filterSongs(songs, { chart: 'chords' }).map((s) => s.id), [2]);
assert.deepEqual(filterSongs(songs, { folder: 'Worship' }).map((s) => s.id), [1]);
assert.deepEqual(filterSongs(songs, { folder: '' }).map((s) => s.id), [2]);
assert.deepEqual(filterSongs(songs, { text: 'y' }).map((s) => s.id), [2]);
assert.deepEqual([...songs].sort(SORTS.rating).map((s) => s.id), [2, 1, 3]);
assert.deepEqual(folderNames(songs, ['Empty']), ['Empty', 'Worship']);
console.log('songmeta ok');

import { syncState } from '../js/songmeta.js';
assert.equal(syncState({}).state, 'none');
assert.equal(syncState({ recording: { kind: 'youtube' } }).state, 'progress');
assert.deepEqual(syncState({ recording: {}, videoMaster: 5, syncPoints: [[0, 1]], videoBpm: 90 }).steps, [true, true, true, false]);
assert.equal(syncState({ recording: {}, videoMaster: 5, syncPoints: [[0, 1], [4, 9]], syncDone: true }).state, 'synced');
assert.equal(syncState({ recording: {}, syncDone: true }).state, 'progress'); // can't be done before it is lined up

import { versionLabel } from '../js/songmeta.js';
assert.equal(versionLabel({}), '');
assert.equal(versionLabel({ version: { type: 'official' } }), 'Studio original');
assert.equal(versionLabel({ version: { type: 'live' } }), 'Live');
assert.equal(versionLabel({ version: { type: 'cover', artist: 'Jane' } }), 'Cover · Jane');
assert.equal(versionLabel({ version: { type: 'cover', artist: 'Jane', live: true } }), 'Live cover · Jane');

// split entries from older PDF imports, grouped to combine
{
  const { splitGroups } = await import('../js/songmeta.js');
  const lib = [
    { id: 1, kind: 'tex', title: 'Champion', artist: 'Bethel Music', added: 1 },
    { id: 2, kind: 'sheet', title: 'Champion (Piano)', artist: 'Bethel Music' },
    { id: 3, kind: 'sheet', title: 'Champion (Synth Pad)', artist: 'Bethel Music' },
    { id: 4, kind: 'sheet', title: 'Lonely (Piano)', artist: 'X' }, // one part, nothing to join: left alone
    { id: 5, kind: 'sheet', title: 'Hymn (Piano)', artist: 'Y' },
    { id: 6, kind: 'sheet', title: 'Hymn (Organ)', artist: 'Y' },
    { id: 7, kind: 'tex', title: 'Other (Live)', artist: 'Z' }, // a tab, not a split part
  ];
  const g = splitGroups(lib);
  assert.equal(g.length, 2);
  assert.equal(g[0].base.id, 1);
  assert.deepEqual(g[0].parts.map((p) => p.name), ['Piano', 'Synth Pad']);
  assert.equal(g[1].title, 'Hymn');
  assert.equal(g[1].base, null);
  assert.equal(splitGroups([{ kind: 'sheet', title: 'A (B)', sheets: [{}] }, { kind: 'sheet', title: 'A (C)', sheets: [{}] }]).length, 0, 'already combined');
  console.log('songmeta split groups ok');
}
