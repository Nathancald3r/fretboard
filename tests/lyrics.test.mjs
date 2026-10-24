// Run: node tests/lyrics.test.mjs
import assert from 'node:assert/strict';
import { lyricsTrack, buildLyrics, lineAt } from '../js/lyrics.js';

const alphaTab = await import('@coderline/alphatab');
const load = (tex) => {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, new alphaTab.Settings());
  return importer.readScore();
};
// Played bars without repeats: bar i starts at i * 3840 ticks (4/4).
const straight = (score) => score.masterBars.map((mb, i) => ({ start: i * 3840, masterIndex: mb.index }));
const text = (line) => line.words.map((w) => w.text + (w.joined ? '' : ' ')).join('').trim();

const score = load(`\\title "t" .
\\track "Guitar" \\staff {tabs}
0.6.1 | 0.6.1 | 0.6.1 | 0.6.1 |
\\track "Lead Vocals" \\staff {score}
\\lyrics "Hel-lo my friend. How are you to night"
C4.4 C4.4 C4.4 C4.4 | C4.4 C4.4 C4.4 C4.4 | r.1 | C4.4 C4.4 r.2`);

assert.equal(lyricsTrack(score), 1, 'the vocal track has the lyrics');
assert.equal(lyricsTrack(load(`\\title "x" .
0.6.1 |`)), -1, 'no lyrics');

const lines = buildLyrics(score, 1, straight(score));
assert.equal(text(lines[0]), 'Hello my friend. How are you to', 'hyphenated syllables join');
assert.equal(lines[0].words[0].joined, true);
assert.equal(lines[0].words[0].tick, 0);
// The whole-bar rest (a long gap) starts a new line.
assert.equal(lines.length, 2);
assert.equal(text(lines[1]), 'night');
assert.equal(lines[1].start, 3 * 3840);

assert.equal(lineAt(lines, 0), 0);
assert.equal(lineAt(lines, 2 * 3840 + 100), 1, 'during the rest: the next line');
assert.equal(lineAt(lines, 99999), 1);
// With a lead, the next line comes up before it's sung, but only once the last word has started.
const back = [{ start: 0, end: 2000, words: [{ tick: 0 }, { tick: 1000 }] }, { start: 2000, end: 4000, words: [{ tick: 2000 }] }];
assert.equal(lineAt(back, 900, 1500), 0, 'the line is still being sung');
assert.equal(lineAt(back, 1200, 1500), 1, 'last word started, next line within the lead');
assert.equal(lineAt(back, 1200, 0), 0);

// A repeated bar uses verse 2 the second time.
const sc2 = load(`\\title "r" .
\\track "Voice" \\staff {score}
\\lyrics "one two"
C4.2 C4.2 |`);
const [b1, b2] = sc2.tracks[0].staves[0].bars[0].voices[0].beats;
b1.lyrics = ['one', 'three'];
b2.lyrics = ['two', 'four'];
const twice = [{ start: 0, masterIndex: 0 }, { start: 3840, masterIndex: 0 }];
const all = buildLyrics(sc2, 0, twice).flatMap((l) => l.words.map((w) => w.text));
assert.deepEqual(all, ['one', 'two', 'three', 'four']);

// A word cut by a jump in the sheet ("h-" then "Je-sus") keeps its hyphen; a lone "Hey," after a
// rest runs on into the next line instead of standing alone.
const sc3 = load(`\\title "c" .
\\track "Voice" \\staff {score}
\\lyrics "a b c d e f"
C4.4 r.2 C4.4 | C4.4 C4.4 C4.4 C4.4 |`);
const words3 = ['Hey,', 'let', 'it', 'h-', 'Je-', 'sus'];
sc3.masterBars.forEach((mb, i) => sc3.tracks[0].staves[0].bars[i].voices[0].beats.filter((b) => !b.isRest)
  .forEach((b) => { b.lyrics = [words3.shift()]; }));
assert.deepEqual(buildLyrics(sc3, 0, straight(sc3)).map(text), ['Hey, let it h- Jesus']);

console.log('lyrics: all tests passed');
