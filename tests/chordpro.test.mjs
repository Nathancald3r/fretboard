// Run: node tests/chordpro.test.mjs
import assert from 'node:assert/strict';
import { readChordPro, chordsOver, withoutNotes, chartToChordPro } from '../js/chordpro.js';

// a ChordPro line as chords over words
assert.deepEqual(chordsOver('He [Bb]loves us oh how He [Eb2/G]loves us'), [
  '   Bb                 Eb2/G',
  'He loves us oh how He loves us',
]);
assert.deepEqual(chordsOver('How He loves us [Eb2] so'), ['                Eb2', 'How He loves us  so']);
assert.deepEqual(chordsOver('[G][C]Go'), ['G C', '  Go'], 'two chords in a row don’t run together; the words move over');
assert.deepEqual(chordsOver('| [Bb] | [F] |'), ['| Bb | F |'], 'chords between bar lines stay one line');
assert.deepEqual(chordsOver('[F2(no3)] [C]'), ['F2(no3) C']);

const cho = `{title: How He Loves}
{artist: John Mark McMillan}
{key: Bb}
{tempo: 49}
{time: 6/8}
{capo: 3}
{ccli: 5032549}
# a remark, not shown

{start_of_verse: Verse 1}
{comment: ✎ Nate (typed): Woah this is nates annotations}
[Bb]He is jealous for me
{end_of_verse}

{comment: Instrumental}
| [Bb] | [Fsus] |

{soc}
(Yeah) He [Bb]loves us
{eoc}
{ci: ✎ Sam: louder here}
`;
const r = readChordPro(cho);
assert.equal(r.title, 'How He Loves');
assert.equal(r.artist, 'John Mark McMillan');
assert.equal(r.key, 'Bb');
assert.equal(r.capo, 3);
assert.equal(r.tempo, 49);
assert.deepEqual(r.notes, [{ by: 'Nate', text: 'Woah this is nates annotations' }, { by: 'Sam', text: 'louder here' }]);
assert.equal(r.text, `How He Loves - John Mark McMillan
Chords · Key: Bb · Capo: 3 · Tempo: 49 · Time: 6/8

[Verse 1]
✎ Nate (typed): Woah this is nates annotations
Bb
He is jealous for me

[Instrumental]
| Bb | Fsus |

[Chorus]
          Bb
(Yeah) He loves us

✎ Sam: louder here

CCLI Song # 5032549
`);
const clean = readChordPro(cho, { notes: false });
assert.ok(!clean.text.includes('✎'), 'the clean copy has no notes');
assert.ok(!withoutNotes(cho).includes('✎'));
assert.equal(readChordPro(withoutNotes(cho)).notes.length, 0);

// a chart PDF's text: title block, a section, chords (one with a raised 2, one in two touching pieces) over words
const it = (str, x, y, w, h = 15) => ({ str, x, y, w, h });
const page = {
  items: [
    it('How He Loves', 39, 38, 130, 18.6),
    it('John Mark McMillan', 39, 55, 70, 7.8),
    it('Key - Bb | Tempo - 49 | Time - 6/8', 39, 75, 140, 10.2),
    it('VERSE 1', 39, 104, 60),
    it('Bb', 61, 123, 18), it('He', 61, 135, 18), it('is jealous for me', 84, 135, 110),
    it('Eb', 229, 208, 17), it('2', 246, 206, 7, 12), it('The weight of His wind and', 61, 220, 164), it('mercy', 229, 220, 37),
    it('Eb', 142, 276, 17), it('2', 159, 274, 7, 12), it('/G', 166, 276, 18),
    it('Of these af -', 61, 288, 76), it('flictions', 142, 288, 47), it('eclipsed by glory', 193, 288, 102),
    it('CCLI Song # 5032549', 261, 393, 80, 8.4),
  ],
  notes: [{ by: 'Nate', text: 'Woah', y: 210 }],
};
const out = chartToChordPro([page], { fileName: 'How He Loves - Capo 3.pdf' });
assert.equal(out, `{title: How He Loves}
{artist: John Mark McMillan}
{key: Bb}
{tempo: 49}
{time: 6/8}
{capo: 3}
{ccli: 5032549}

{start_of_verse: Verse 1}
[Bb]He is jealous for me
{comment: ✎ Nate: Woah}
The weight of His wind and [Eb2]mercy
Of these af[Eb2/G]flictions eclipsed by glory
{end_of_verse}
`);
assert.equal(chartToChordPro([{ items: [it('Just some words', 40, 40, 100)] }]), null, 'no chords over words: not a chart');

console.log('chordpro ok');
