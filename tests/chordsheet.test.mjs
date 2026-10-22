// Run: node tests/chordsheet.test.mjs
import assert from 'node:assert/strict';
import { parseSheet, isChordLine, sungWords, barSpans, sheetChords } from '../js/chordsheet.js';

const alphaTab = await import('@coderline/alphatab');
const load = (tex) => {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, new alphaTab.Settings());
  return importer.readScore();
};

assert.ok(isChordLine('E                  Bsus4         F#7sus4         Asus2'));
assert.ok(isChordLine('Bsus4 E/G# Asus2             E'));
assert.ok(!isChordLine('Here I am to bow  down'));
assert.ok(!isChordLine('A new day'), 'a lyric that starts with a chord letter is words');

const sheet = `[Intro]
E   Bsus4

[Verse 1]
E                  Bsus4
Light of the world, You step down

[Chorus]
             Bsus4
Here I am to bow  down`;
const { words, chords } = parseSheet(sheet);
assert.deepEqual(words, ['light', 'of', 'the', 'world', 'you', 'step', 'down', 'here', 'i', 'am', 'to', 'bow', 'down']);
assert.deepEqual(chords.filter((c) => c.before === 0).map((c) => c.name), ['E', 'Bsus4']);

// two empty bars, then a word a beat; the chorus is sung twice but written once
const sung = ['Light', 'of', 'the', 'world', 'You', 'step', 'down', 'Here', 'I', 'am', 'to', 'bow', 'down', 'Here', 'I', 'am', 'to', 'bow', 'down', 'yeah'];
const beats = sung.map((w) => `0.1.4 {lyrics ${JSON.stringify(w)}}`);
const barsTex = ['r.1', 'r.1'];
for (let i = 0; i < beats.length; i += 4) barsTex.push(beats.slice(i, i + 4).join(' ').padEnd(1));
const score = load(`\\title "T" .
\\track "Vocals" \\staff {score}
${barsTex.join(' | ')}`);
const bars = barSpans(score);
assert.equal(sungWords(score, bars).length, sung.length);
const got = sheetChords(sheet, sungWords(score, bars), bars);
const at = (bar) => got[bar].all.map((c) => `${c.offset}:${c.name}`).join(' ');
assert.equal(at(0), '0:E', 'intro chords one bar each before the first word');
assert.equal(at(1), '0:Bsus4');
assert.equal(at(2), '0:E');
assert.equal(at(3), '0:Bsus4', 'Bsus4 over "You"');
assert.equal(at(4), '2880:Bsus4', 'over "bow"');
assert.equal(at(6), '960:Bsus4', 'the repeated chorus gets its chord too');
assert.equal(sheetChords('Am\nsomething else entirely here', sungWords(score, bars), bars), null, 'a sheet of another song is left out');
console.log('chordsheet ok');
