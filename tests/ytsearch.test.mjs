// Run: node tests/ytsearch.test.mjs
import assert from 'node:assert/strict';
import { categorize, groupResults, freshFirst, songQuery, rankResults, versionHints, pickConfident, explainPick, tabEvidence } from '../js/ytsearch.js';

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


// The version note steers the pick: "Passion Live version" prefers the Passion live recording.
const song = { title: 'Chris Tomlin - Here I Am To Worship', versionNote: 'Passion Live version, left out acapella bridge for obvious reasons.' };
const h = versionHints(song);
assert.ok(h.flags.live && h.words.includes('passion') && h.words.includes('acapella'), JSON.stringify(h));
assert.ok(!h.words.includes('version') && !h.words.includes('worship'));
const tom = { artist: 'Chris Tomlin', title: 'Here I Am To Worship', seconds: 276 };
const withNote = rankResults([
  r('studio', 'Chris Tomlin - Here I Am To Worship (Official Audio)', 'Chris Tomlin', 270, true),
  r('passion', 'Here I Am To Worship (Live) - Passion 2005', 'Chris Tomlin', 280),
], { ...tom, hints: h });
assert.equal(withNote[0].id, 'passion', 'the live version the note names');
const noNote = rankResults([
  r('studio', 'Chris Tomlin - Here I Am To Worship (Official Audio)', 'Chris Tomlin', 270, true),
  r('passion', 'Here I Am To Worship (Live) - Passion 2005', 'Chris Tomlin', 280),
], tom);
assert.equal(noNote[0].id, 'studio', 'without a note the studio recording still wins');
assert.deepEqual(versionHints({ title: 'x' }), { words: [], flags: {} });

// Confident auto-pick: clear lead and a length within 8% of the tab.
const ranked = rankResults([
  r('official', 'Metallica: Nothing Else Matters (Official Music Video)', 'Metallica', 386, true),
  r('cover', 'Nothing Else Matters guitar cover', 'Some Guitarist', 390),
], want);
assert.equal(pickConfident(ranked, 388)?.id, 'official');
assert.equal(pickConfident(ranked, 300), null, 'length too far from the tab: ask');
assert.equal(pickConfident(rankResults([r('a', 'Metallica - Nothing Else Matters', 'Metallica', 388), r('b', 'Metallica - Nothing Else Matters', 'Metallica', 389)], want), 388), null, 'tie: ask');
assert.equal(pickConfident([], 388), null);
assert.match(explainPick(ranked[0], want), /official/);
assert.match(explainPick(ranked[0], want), /length/);
// Evidence from the tab.
const ev = tabEvidence({ type: 'Official' }, ['Lead Vocals', 'Acoustic Guitar']);
assert.ok(ev.official && ev.vocals && ev.acousticOnly);
assert.ok(!tabEvidence(null, ['Electric Guitar']).acousticOnly);
const vocalPick = rankResults([
  r('inst', 'Metallica - Nothing Else Matters (Instrumental)', 'Metallica', 388),
  r('song', 'Metallica - Nothing Else Matters', 'Metallica', 388),
], { ...want, evidence: ev });
assert.equal(vocalPick[0].id, 'song');
const dur = rankResults([r('far', 'Metallica - Nothing Else Matters', 'Metallica', 330), r('near', 'Metallica - Nothing Else Matters', 'Metallica', 389)], want);
assert.equal(dur[0].id, 'near');

// Pressing Find again shows videos not shown before first.
assert.deepEqual(freshFirst([{ id: 'a' }, { id: 'b' }, { id: 'c' }], new Set(['a'])).map((r) => r.id), ['b', 'c', 'a']);

// Sections: official first, then the artist's other versions, covers, lyric videos, practice.
{
  const w = { artist: 'Chris Tomlin', title: 'Here I Am To Worship', seconds: 276, hints: { words: ['passion'], flags: {} } };
  const mk = (id, title, author) => ({ id, title, author, seconds: 280 });
  const ranked = rankResults([
    mk('p1', 'Here I Am To Worship - Guitar Lesson', 'Some Teacher'),
    mk('l1', 'Chris Tomlin - Here I Am To Worship (Lyrics)', 'Lyric Channel'),
    mk('c1', 'Here I Am To Worship (cover) by Jane', 'Jane'),
    mk('a1', 'Here I Am To Worship (Live) - Passion 2005', 'Passion'),
    mk('o1', 'Chris Tomlin - Here I Am To Worship (Official Music Video)', 'Chris Tomlin'),
    mk('o2', 'Here I Am To Worship', 'Chris Tomlin - Topic'),
  ], w);
  const cat = Object.fromEntries(ranked.map((r) => [r.id, r.cat]));
  assert.deepEqual(cat, { p1: 'practice', l1: 'lyrics', c1: 'cover', a1: 'official', o1: 'official', o2: 'official' });
  const g = groupResults(ranked);
  assert.deepEqual(g.map((x) => x.key), ['official', 'cover', 'lyrics', 'practice']);
  assert.equal(g[0].items.length, 2);
  assert.deepEqual(groupResults(ranked, new Set(['o1']))[0].items.map((r) => r.id), ['o2', 'a1']);
}

console.log('ytsearch: all tests passed');
