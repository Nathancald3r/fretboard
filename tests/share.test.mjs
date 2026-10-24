// Run: node tests/share.test.mjs
import assert from 'node:assert/strict';
import {
  sheetToChordPro, songToChordPro, shiftKey, playKey, fretboardFile, readFretboardFile, readShared,
  setlistText, readSetlistText, makeZip, readZip, crc32, makePdf, pdfAttachment, safeName,
} from '../js/sharecore.js';
import { readChordPro } from '../js/chordpro.js';

// keys
assert.equal(shiftKey('G', 2), 'A');
assert.equal(shiftKey('Bb', -1), 'A');
assert.equal(shiftKey('A', 1), 'Bb', 'flat keys are named with flats');
assert.equal(shiftKey('Em', 1), 'Fm');
assert.equal(shiftKey('C', 0), 'C');
assert.deepEqual(playKey({ kind: 'text', data: 'X - Y\nChords · Key: G\n\nG', transpose: 2 }), { key: 'A', written: 'G', shift: 2 });
assert.deepEqual(playKey({ kind: 'gp', data: new ArrayBuffer(1) }), { key: '', written: '', shift: 0 }, 'no written key: the original');

// a Fretboard chord sheet (as read from ChordPro, or UG) → ChordPro
const sheet = `Amazing Grace - John Newton
Chords · Key: G · Capo: 2 · Tempo: 72 · Time: 3/4

[Verse 1]
G         C       G
Amazing grace how sweet the sound
   D
That saved
G  C  D  (x2)

[Chorus]
Em    D
Oh my [soul]
✎ Nate: slow down here

[Intro tab]
e|---0---|
B|---1---|

CCLI Song # 12345
© Public Domain
`;
const cho = sheetToChordPro(sheet, { title: 'Amazing Grace', artist: 'John Newton' });
assert.match(cho, /^\{title: Amazing Grace\}\n\{artist: John Newton\}\n\{key: G\}\n\{capo: 2\}\n\{tempo: 72\}\n\{time: 3\/4\}\n/);
assert.match(cho, /\{start_of_verse: Verse 1\}\n\[G\]Amazing gr\[C\]ace how \[G\]sweet the sound\nTha\[D\]t saved\n\[G\]  \[C\]  \[D\]  \(x2\)\n/, cho);
assert.match(cho, /\{end_of_verse\}\n\n\{start_of_chorus: Chorus\}\n\[Em\]Oh my \[D\]\(soul\)\n\{comment: ✎ Nate: slow down here\}\n\{end_of_chorus\}/, 'square brackets in the words never read as chords');
assert.match(cho, /\{start_of_tab: Intro tab\}\ne\|---0---\|\nB\|---1---\|\n\{end_of_tab\}/);
assert.match(cho, /\{ccli: 12345\}\n\{copyright: Public Domain\}\n$/);
// valid: Fretboard's own ChordPro reader gets it all back
const back = readChordPro(cho);
assert.equal(back.title, 'Amazing Grace');
assert.equal(back.key, 'G');
assert.equal(back.capo, 2);
assert.equal(back.tempo, 72);
assert.equal(back.ccli, '12345');
assert.match(back.text, /\[Verse 1\]\nG {9}C {7}G\nAmazing grace how sweet the sound/);
// each directive is well formed, each block opened is closed
for (const line of cho.split('\n')) if (line.startsWith('{')) assert.match(line, /^\{[a-z_]+(: .+)?\}$/, line);
const opened = cho.match(/\{start_of_\w+/g).length;
assert.equal(cho.match(/\{end_of_\w+\}/g).length, opened);

// in your key: the chords and the key move, the capo stays
const up = sheetToChordPro(sheet, { title: 'Amazing Grace', shift: 3 });
assert.match(up, /\{key: Bb\}/);
assert.match(up, /\[Bb\]Amazing gr\[Eb\]ace/);
assert.match(up, /\[Gm\]Oh my \[F\]/);
assert.match(up, /# Fretboard: moved \+3 from G/);
assert.equal(readChordPro(up).key, 'Bb');

// a song: its transpose, and the tabs combined with it
const song = { kind: 'text', title: 'T', artist: 'A', data: 'T - A\nChords · Key: D\n\nD\nHi', transpose: -2, parts: [{ name: 'Bass', data: 'G|--3--|\nD|-----|' }] };
const sc = songToChordPro(song);
assert.match(sc, /\{key: C\}/);
assert.match(sc, /\[C\]Hi/);
assert.match(sc, /\{start_of_tab: Bass tab\}\nG\|--3--\|\nD\|-----\|\n\{end_of_tab\}\n$/);
// a plain text tab with no head
const tab = sheetToChordPro('e|---0---|\nB|---1---|\n\nPlay it twice', { title: 'Riff' });
assert.match(tab, /\{start_of_tab\}\ne\|---0---\|\nB\|---1---\|\n\{end_of_tab\}\n\nPlay it twice\n$/);

// .fretboard files: songs and setlists, private things left out, bytes kept
const bytes = new Uint8Array([1, 2, 3, 250]).buffer;
const songs = [
  { id: 7, kind: 'gp', title: 'One', data: bytes, rating: 5, practiceSeconds: 99, transpose: 2 },
  { id: 9, kind: 'text', title: 'Two', data: 'x' },
];
const file = fretboardFile(songs, { setlists: [{ name: 'Sunday', date: '2026-10-25', songIds: [9, 7, 3] }] });
const read = readFretboardFile(file);
assert.equal(read.songs.length, 2);
assert.equal(read.songs[0].rating, undefined);
assert.equal(read.songs[0].id, undefined);
assert.equal(read.songs[0].transpose, 2, 'your key goes with the song');
assert.deepEqual([...new Uint8Array(read.songs[0].data)], [1, 2, 3, 250]);
assert.deepEqual(read.setlists, [{ name: 'Sunday', date: '2026-10-25', songs: [1, 0] }]);
assert.equal(readShared(file).length, 2, 'the old reader still works');
assert.equal(readFretboardFile('{"format":"other"}'), null);
assert.equal(readFretboardFile('not json'), null);

// Setlist.txt
const txt = setlistText({ name: 'Sunday', date: '2026-10-25' }, [
  { title: 'Two', artist: 'B', key: 'E', file: '01 Two.cho' },
  { title: 'One', key: '', file: '02 One.pdf' },
]);
assert.match(txt, /^Setlist: Sunday\nDate: 2026-10-25 \(Sunday 25 October 2026\)\n\n1\. Two - B · Key: E · 01 Two\.cho\n2\. One · 02 One\.pdf\n/);
assert.deepEqual(readSetlistText(txt), { name: 'Sunday', date: '2026-10-25', files: ['01 Two.cho', '02 One.pdf'] });
assert.equal(readSetlistText('hello'), null);
assert.equal(safeName('AC/DC: Back?'), 'ACDC Back');

// zip: what goes in comes out (and crc32 is the standard one)
assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
const zip = makeZip([{ name: '01 Two.cho', data: '{title: Two}\n' }, { name: 'Setlist.txt', data: txt }, { name: 'b.gp', data: bytes }]);
const files = await readZip(zip);
assert.deepEqual(files.map((f) => f.name), ['01 Two.cho', 'Setlist.txt', 'b.gp']);
assert.equal(new TextDecoder().decode(files[1].data), txt);
assert.deepEqual([...files[2].data], [1, 2, 3, 250]);
// a deflated zip (as other apps make them)
{
  const { deflateRawSync } = await import('node:zlib');
  const text = new TextEncoder().encode('hello hello hello hello');
  const packed = deflateRawSync(text);
  const z = makeZip([{ name: 'a.txt', data: packed }]);
  const v = new DataView(z.buffer);
  v.setUint16(8, 8, true); // local header: deflated
  const cd = z.length - 22 - 46 - 5;
  v.setUint16(cd + 10, 8, true);
  v.setUint32(cd + 24, text.length, true);
  const [a] = await readZip(z);
  assert.equal(new TextDecoder().decode(a.data), 'hello hello hello hello');
}

// PDF: pages, and the song attached for another Fretboard
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const pdf = makePdf([{ jpeg, width: 100, height: 141 }, { jpeg, width: 100, height: 50 }], { title: 'Café ♪', attach: { name: 'One.fretboard', data: file } });
const s = new TextDecoder('latin1').decode(pdf);
assert.ok(s.startsWith('%PDF-1.4\n'));
assert.match(s, /\/Type \/Pages \/Kids \[6 0 R 9 0 R\] \/Count 2/);
assert.match(s, /\/MediaBox \[0 0 595\.28 839\.34\]/);
assert.match(s, /\/EmbeddedFiles << \/Names \[\(One\.fretboard\) 5 0 R\]/);
// the xref points at each object
const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
assert.ok(s.slice(xref).startsWith('xref\n0 12\n'));
const offs = s.slice(xref).split('\n').slice(3, 14).map((l) => Number(l.slice(0, 10)));
offs.forEach((o, i) => assert.ok(s.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
assert.equal(pdfAttachment(pdf), file);
assert.equal(readFretboardFile(pdfAttachment(pdf)).songs[1].title, 'Two');
assert.equal(pdfAttachment(makePdf([{ jpeg, width: 1, height: 1 }])), null);

console.log('share: all passed');
