// Run: node tests/chordsheetview.test.mjs
import assert from 'node:assert/strict';
import { inlinePieces, overPieces, toWords, readSections, foldRepeats, capoPlan, viewHtml, chordTokens } from '../js/chordsheetview.js';
import { readChordPro, curlyChords } from '../js/chordpro.js';
import { sheetToChordPro } from '../js/sharecore.js';
import { shiftChordName } from '../js/transpose.js';

const text = (words) => words.map((w) => w.map((p) => (p.c ? `[${p.c}]` : '') + p.t).join('')).join(' ');

/* ---------- ChordPro inline: [G] and {G} both read ---------- */
assert.deepEqual(inlinePieces('Seven P.M. thou[G]ghts in my [D]home'), [
  { t: 'Seven P.M. thou' }, { c: 'G', t: 'ghts in my ' }, { c: 'D', t: 'home' },
]);
assert.deepEqual(inlinePieces('Seven P.M. thou{G}ghts in my {D}home'), inlinePieces('Seven P.M. thou[G]ghts in my [D]home'), 'curly chords are read as the same');
assert.deepEqual(inlinePieces('[Em]Who to put [x2]'), [{ c: 'Em', t: 'Who to put [x2]' }], 'a bracket that is not a chord stays text');
assert.equal(text(toWords(inlinePieces('Seven thou[G]ghts in my [D]home [C]'))), 'Seven thou[G]ghts in my [D]home [C]');
// a word keeps its chords together (it wraps as one unit); a chord between spaces is a word of its own
const w = toWords(inlinePieces('thou[G]ghts [C] home'));
assert.equal(w.length, 3);
assert.deepEqual(w[0], [{ t: 'thou' }, { c: 'G', t: 'ghts' }]);
assert.deepEqual(w[1], [{ c: 'C', t: '' }]);

/* ---------- chords over words (how a sheet is stored) ---------- */
assert.deepEqual(overPieces('G      C', 'Amazing grace how'), [{ c: 'G', t: 'Amazing ' }, { c: 'C', t: 'grace how' }], 'a chord over the gap goes to the next word');
assert.equal(text(toWords(overPieces('G      C', 'Amazing grace how'))), '[G]Amazing [C]grace how');
assert.equal(text(toWords(overPieces('     F#m    C#m', 'Without telling you exactly'))), 'Witho[F#m]ut tell[C#m]ing you exactly', 'chords split a word where they stand');
assert.equal(text(toWords(overPieces('E                F#m', 'I let'))), '[E]I let [F#m]', 'a chord past the end of the words is kept');
assert.equal(text(toWords(overPieces('G  C', ' Go home'))), '[G]Go [C]home', 'a chord over a gap goes to the next word');
assert.ok(overPieces('G  C  (x2)', 'Go home now').some((p) => /x2/.test(p.t)), 'a repeat mark stays on the line');
assert.ok(chordTokens('E  F#m  C#m') && !chordTokens('Without telling you'));

/* ---------- sections ---------- */
const sheet = `[Intro]
E F#m

[Verse 1]
E                 F#m
I let the sun come down
C#m
Some more words

[Chorus]
F#                C#m
Let the sun come down
E
And you might never know

[Verse 2]
F#m
Seven P.M. thoughts in my home

[Chorus]
F#                C#m
Let the sun come down
E
And you might never know

[Chorus]
F#                C#m
Let the sun come down
E
And you might never know

[Bridge]
G#m7  B
Hold on

[Chorus]

[Outro]
E F#m
`;
const blocks = readSections(sheet);
assert.deepEqual(blocks.map((b) => b.name), ['Intro', 'Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Chorus', 'Bridge', 'Chorus', 'Outro']);
assert.equal(blocks[0].lines[0].t, 'c', 'a chord-only line');
assert.equal(text(blocks[1].lines[0].words), '[E]I let the sun come [F#m]down');
assert.equal(blocks[7].lines.length, 0, 'a name with no lines under it');

/* ---------- repeats fold ---------- */
const folded = foldRepeats(blocks);
assert.deepEqual(folded.map((x) => (x.marker ? `~${x.name}${x.times > 1 ? ` x${x.times}` : ''}` : `${x.name}${x.times > 1 ? ` x${x.times}` : ''}`)),
  ['Intro', 'Verse 1', 'Chorus', 'Verse 2', '~Chorus x2', 'Bridge', '~Chorus', 'Outro'],
  'the first chorus in full; the same chorus later is a marker, twice in a row ×2; the bare [Chorus] is one too');
assert.deepEqual(foldRepeats(blocks, false).map((x) => x.name), blocks.map((b) => b.name), 'collapse off: every section in full');
assert.equal(foldRepeats(blocks, false).every((x) => !x.marker), true);

// two in a row, written out: one section ×2
const twice = foldRepeats(readSections('[Chorus]\nG\nHey\n\n[Chorus]\nG\nHey\n\n[Verse]\nC\nHo'));
assert.deepEqual(twice.map((x) => [x.name, x.times, !!x.marker]), [['Chorus', 2, false], ['Verse', 1, false]]);
// same lines under another name: a marker that says what it repeats
const other = foldRepeats(readSections('[Verse 1]\nG\nHey you\nC\nHo ho\n\n[Verse 2]\nC\nOther\n\n[Verse 3]\nG\nHey you\nC\nHo ho'));
assert.equal(other[2].marker, true);
assert.equal(other[2].of, 'Verse 1');
// one changed line: not a repeat
const changed = foldRepeats(readSections('[Chorus]\nG\nHey you\n\n[Verse]\nC\nHo\n\n[Chorus]\nG\nHey me'));
assert.equal(changed.some((x) => x.marker), false);
// a one-line stanza with no name is not folded, a longer unnamed one is
const un = foldRepeats(readSections('G\nHey you\n\nC\nOther line\nWith more\n\nG\nHey you\n\nC\nOther line\nWith more'));
assert.deepEqual(un.map((x) => !!x.marker), [false, false, false, true]);

/* ---------- capo: the shapes to play, the sounding key stays ---------- */
assert.deepEqual(capoPlan({}), { capo: 0, move: 0 });
assert.deepEqual(capoPlan({ capo: 2 }), { capo: 2, move: -2 }, 'capo 2: every chord shows two half steps lower');
assert.deepEqual(capoPlan({ capo: 2, shift: 3 }), { capo: 2, move: 1 }, 'transpose moves the key, the capo then lowers the shapes');
assert.deepEqual(capoPlan({ written: 3 }), { capo: 3, move: 0 }, 'the sheet’s own capo: shown as written');
assert.deepEqual(capoPlan({ written: 3, capo: 0 }), { capo: 0, move: 3 }, 'a sheet written for capo 3, played without: the sounding chords');
assert.deepEqual(capoPlan({ written: 3, capo: 5, shift: 1 }), { capo: 5, move: -1 });
assert.equal(shiftChordName('F#m', -2, false), 'Em');
assert.equal(shiftChordName('C#m7/G#', -2, false), 'Bm7/F#');

/* ---------- html: chords stay over their words, moved chords keep the name the shapes need ---------- */
const html = viewHtml(foldRepeats(readSections('[Verse 1]\nG        D\nSeven thoughts\n\n[Chorus]\nC\nHey\n\n[Chorus]\nC\nHey')), { rename: (c) => shiftChordName(c, -2, false) });
assert.ok(html.includes('<div class="sh">Verse 1</div>'));
assert.ok(html.includes('<div class="sh">Chorus <span class="rep">×2</span></div>'), 'two in a row: one block, ×2');
assert.ok(html.includes('<span class="chord" data-chord="G">F</span>'), 'moved down two: shown F');
assert.ok(html.includes('<span class="cs">'));
const marker = viewHtml(foldRepeats(readSections('[Chorus]\nC\nHey\n\n[Verse]\nG\nHo\n\n[Chorus]\nC\nHey')));
assert.ok(marker.includes('<div class="tx-rep"><span class="ic">↻</span> Chorus</div>'));
assert.ok(!/<img/i.test(viewHtml(foldRepeats(readSections('G\n<img src=x onerror=1> hey')))), 'words are escaped');

/* ---------- ChordPro: {G} read like [G]; a sheet survives the trip out and back ---------- */
assert.equal(curlyChords('Seven {G}thoughts in my {Dm7}home'), 'Seven [G]thoughts in my [Dm7]home');
assert.equal(curlyChords('{key: G}'), '{key: G}', 'a directive is not a chord');
assert.equal(curlyChords('{c: Chorus}'), '{c: Chorus}');
const cho = readChordPro('{title: Test}\n{start_of_verse: Verse 1}\nSeven P.M. thou{G}ghts in my {D}home\n{end_of_verse}\n');
assert.equal(cho.title, 'Test');
assert.equal(text(readSections(cho.text).find((b) => b.name === 'Verse 1').lines[0].words), 'Seven P.M. thou[G]ghts in my [D]home', 'curly chords land on their words');

const stored = `Sun Come Down - Chance
Chords · Key: F#m

${sheet}`;
const out = sheetToChordPro(stored, { title: 'Sun Come Down', artist: 'Chance' });
assert.ok(out.includes('[E]I let the sun come [F#m]down'), 'written with square brackets');
const back = readChordPro(out).text;
const again = readSections(back.split('\n').slice(2).join('\n'));
const before = readSections(sheet);
const flat = (bl) => bl.map((b) => `${b.name}\n${b.lines.map((l) => (l.t === 'w' ? text(l.words) : l.t === 'c' ? l.items.map((x) => x.c || x.x).join(' ') : l.s)).join('\n')}`).join('\n--\n');
assert.equal(flat(again), flat(before), 'sheet → ChordPro → sheet reads the same on screen');
console.log('ok');
