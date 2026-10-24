// Run: node tests/midi.test.mjs
import assert from 'node:assert/strict';
import { readMidi, midiToMusicXml, pickStep } from '../js/midi.js';

// A small MIDI writer: tracks of [tick, bytes] events.
function midiFile(tracks, division = 480, format = 1) {
  const out = [];
  const u32 = (v) => [v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255];
  const vlq = (v) => { const b = [v & 127]; while ((v >>= 7)) b.unshift((v & 127) | 128); return b; };
  out.push(...[77, 84, 104, 100], ...u32(6), 0, format, 0, tracks.length, division >> 8, division & 255);
  for (const events of tracks) {
    const body = [];
    let last = 0;
    for (const [tick, bytes] of [...events].sort((a, b) => a[0] - b[0])) { body.push(...vlq(tick - last), ...bytes); last = tick; }
    body.push(0, 0xff, 0x2f, 0);
    out.push(...[77, 84, 114, 107], ...u32(body.length), ...body);
  }
  return new Uint8Array(out).buffer;
}
const meta = (type, data) => [0xff, type, data.length, ...data];
const text = (s) => [...s].map((c) => c.charCodeAt(0));
const note = (ch, tick, len, key, vel = 100) => [[tick, [0x90 | ch, key, vel]], [tick + len, [0x80 | ch, key, 0]]];

const Q = 480;
const conductor = [[0, meta(0x03, text('Test Song'))], [0, meta(0x01, text('By Jane Writer, 1999'))], [0, meta(0x51, [0x07, 0xa1, 0x20])], [0, meta(0x58, [4, 2, 24, 8])], [0, meta(0x59, [1, 0])]];
// guitar: an open E minor chord (a bar), then a melody note
const guitar = [[0, meta(0x03, text('Lead'))], [0, [0xc0, 25]],
  ...[40, 47, 52, 55, 59, 64].flatMap((k) => note(0, 0, 4 * Q - 40, k)), ...note(0, 4 * Q, Q, 67)];
// drums: kick and hi-hat on beat one, snare on two, played for a bar and a half
const drums = [...note(9, 0, 60, 36), ...note(9, 0, 60, 42), ...note(9, Q, 60, 38), ...note(9, 4 * Q, 60, 36)];
const buf = midiFile([conductor, guitar, drums]);

const m = readMidi(buf);
assert.equal(m.title, 'Test Song');
assert.equal(m.artist, 'Jane Writer');
assert.equal(Math.round(m.tempos[0].bpm), 120);
assert.deepEqual(m.keys[0], { tick: 0, fifths: 1, minor: false });
assert.deepEqual(m.tracks.map((t) => [t.name, t.channel, t.program, t.notes.length]), [['Lead', 0, 25, 7], ['', 9, 0, 4]]);

const r = midiToMusicXml(buf);
assert.equal(r.bars, 2);
assert.deepEqual(r.tracks, ['Lead', 'Drums']);
assert.equal(r.step, 6, 'straight 16ths');
// the chord let go just before bar 2 is written as a whole note, not a note and a rest
const bar1 = r.xml.split('<part id="P1">')[1].split('<measure number="2">')[0];
assert.ok(!bar1.includes('<rest/>'), 'no rest in the chord bar');
assert.equal((bar1.match(/<type>whole<\/type>/g) || []).length, 6);
// open E minor (E2 B2 E3 G3 B3 E4): frets 0 2 2 0 0 0
const frets = [...bar1.matchAll(/<string>(\d)<\/string><fret>(\d+)<\/fret>/g)].map((x) => x[1] + ':' + x[2]).sort();
assert.deepEqual(frets, ['1:0', '2:0', '3:0', '4:2', '5:2', '6:0']);
assert.match(r.xml, /<staff-tuning line="1"><tuning-step>E<\/tuning-step><tuning-octave>2<\/tuning-octave>/);
assert.match(r.xml, /<midi-program>26<\/midi-program>/);
// drums: unpitched notes tied to their drum sound
assert.match(r.xml, /<midi-instrument id="P2-I38"><midi-channel>10<\/midi-channel><midi-unpitched>39<\/midi-unpitched>/);
assert.match(r.xml, /<unpitched><display-step>C<\/display-step><display-octave>5<\/display-octave><\/unpitched><duration>\d+<\/duration><instrument id="P2-I38"\/>/);
assert.match(r.xml, /<sign>percussion<\/sign>/);
assert.match(r.xml, /<work-title>Test Song<\/work-title>/);
assert.match(r.xml, /<fifths>1<\/fifths>/);
assert.match(r.xml, /<sound tempo="120"\/>/);
// every bar of every voice adds up to the bar's length (4/4 = 96 units)
for (const part of r.xml.split('<part id=').slice(1)) {
  for (const meas of part.split('<measure ').slice(1)) {
    const voices = new Map();
    for (const n of meas.matchAll(/<note>(<chord\/>)?.*?<duration>(\d+)<\/duration>.*?<voice>(\d+)<\/voice>/g)) if (!n[1]) voices.set(n[3], (voices.get(n[3]) || 0) + Number(n[2]));
    for (const [v, d] of voices) assert.equal(d, 96, `voice ${v} fills its bar`);
  }
}

// triplets: eighth-note triplets snap to a triplet grid
const trip = [];
for (let i = 0; i < 12; i++) trip.push(...note(0, Math.round(i * Q / 3), Math.round(Q / 3) - 10, 60 + (i % 5)));
const tb = midiFile([[[0, [0xc0, 0]], ...trip]], Q, 0);
assert.equal(pickStep(readMidi(tb)), 8);
const tx = midiToMusicXml(tb, { title: 'Trips' }).xml;
assert.match(tx, /<type>eighth<\/type><time-modification><actual-notes>3<\/actual-notes>/);
assert.match(tx, /<work-title>Trips<\/work-title>/);

// overlapping notes on one track go into a second voice
const legato = midiFile([[...note(0, 0, 4 * Q, 67), ...note(0, 0, Q, 72), ...note(0, Q, Q, 74), ...note(0, 2 * Q, 2 * Q, 76)]], Q, 0);
assert.match(midiToMusicXml(legato).xml, /<voice>2<\/voice>/);

// a piano with both hands on one track gets two staves
const piano = midiFile([[...[0, 1, 2, 3].flatMap((b) => [...note(0, b * Q, Q, 72), ...note(0, b * Q, Q, 43)])]], Q, 0);
const px = midiToMusicXml(piano).xml;
assert.match(px, /<staves>2<\/staves>/);
assert.match(px, /<clef number="2"><sign>F<\/sign>/);

assert.throws(() => readMidi(new Uint8Array([1, 2, 3, 4]).buffer), /Not a MIDI file/);
console.log('midi: all tests passed');
