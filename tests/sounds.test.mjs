// Run: node tests/sounds.test.mjs
import assert from 'node:assert/strict';
import { soundFor, soundName, TYPICAL } from '../js/sounds.js';

const program = (text) => { const s = soundFor(text); return s?.drum ? 'drum' : s?.[1] ?? null; };
const cases = {
  'Acoustic guitar': 25, piano: 0, PIANO: 0, vibraphone: 11, vibes: 11, xylophone: 13, xylaphone: 13, zylophone: 13,
  marimba: 12, glockenspiel: 9, glockenspeil: 9, timpani: 47, 'steel drum': 114, 'steel drums': 114,
  conga: 116, 'conga drum': 116, bongos: 117, cajon: 117,
  shaker: 'drum', tambourine: 'drum', cowbell: 'drum', 'snare drum': 'drum', 'hi-hat': 'drum', drums: 'drum', 'drum machine': 'drum',
  'electric bass': 33, 'bass guitar': 33, 'upright bass': 32, bells: 14, pads: 89, sax: 65, saxophone: 65, 'tenor sax': 66,
  ukulele: 24, mandolin: 25, fiddle: 110, violin: 40, viola: 41, cello: 42, celo: 42, trombone: 57, 'french horn': 60, clarinet: 71,
  harmonica: 22, accordian: 21, rhodes: 4, hammond: 16, 'church organ': 19, 'lead guitar': 29, 'backing vocals': 52, banjo: 105,
  'big string section': 48, qwertyuiop: null, '': null,
};
for (const [text, want] of Object.entries(cases)) assert.equal(program(text), want, `"${text}"`);
assert.equal(soundName(13), 'Xylophone');
assert.equal(soundName(25), 'Acoustic guitar');
assert.ok(TYPICAL.length < 30, 'a short list to pick from');
console.log('sounds: all tests passed');
