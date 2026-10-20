// Run: node tests/ytsearch.test.mjs
import assert from 'node:assert/strict';
import { songQuery, rankResults } from '../js/ytsearch.js';

assert.deepEqual(songQuery({ title: 'Chris Tomlin - Here I Am To Worship' }), { artist: 'Chris Tomlin', title: 'Here I Am To Worship', text: 'Chris Tomlin Here I Am To Worship' });
assert.equal(songQuery({ artist: 'Oasis', title: 'Wonderwall' }).text, 'Oasis Wonderwall');

const want = { artist: 'Metallica', title: 'Nothing Else Matters', seconds: 388 };
const pick = (list) => rankResults(list, want)[0].id;
const r = (id, title, author, seconds = 388, verified = false) => ({ id, title, author, seconds, verified });

assert.equal(pick([
  r('cover', 'Nothing Else Matters - Metallica (guitar cover)', 'Some Guitarist'),
  r('lesson', 'Nothing Else Matters guitar lesson', 'Guitar Teacher'),
  r('karaoke', 'Metallica - Nothing Else Matters (Karaoke)', 'Sing King'),
  r('official', 'Metallica: Nothing Else Matters (Official Music Video)', 'Metallica', 386, true),
]), 'official', "the artist's channel wins");
assert.equal(pick([
  r('fan', 'Metallica - Nothing Else Matters', 'random uploader'),
  r('topic', 'Nothing Else Matters', 'Metallica - Topic'),
]), 'topic', 'the album track on "Artist - Topic"');
assert.equal(pick([
  r('other', 'Nothing Else Matters (Official Video)', 'Another Band'),
  r('fan', 'Metallica - Nothing Else Matters', 'random uploader'),
]), 'fan', "someone else's official version loses to the original");
assert.equal(pick([
  r('live', 'Metallica - Nothing Else Matters (Live)', 'Metallica'),
  r('studio', 'Metallica - Nothing Else Matters (Remastered)', 'Metallica'),
]), 'studio', 'studio over live');
assert.equal(rankResults([r('a', 'x', 'y'), r('a', 'x', 'y')], want).length, 1, 'duplicates dropped');

console.log('ytsearch: all tests passed');
