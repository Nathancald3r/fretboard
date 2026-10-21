import assert from 'node:assert/strict';
import { chartType, filterSongs, folderNames, SORTS } from '../js/songmeta.js';

assert.equal(chartType({ kind: 'gp' }), 'pro');
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
