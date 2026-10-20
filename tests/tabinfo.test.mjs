import assert from 'node:assert/strict';
import { parseSource, parseFilename, sourceLine } from '../js/tabinfo.js';

const ug = parseSource('https://tabs.ultimate-guitar.com/tab/chris-tomlin/here-i-am-to-worship-guitar-pro-1234567');
assert.equal(ug.site, 'Ultimate Guitar');
assert.equal(ug.type, 'Guitar Pro');
assert.equal(ug.artist, 'Chris Tomlin');
assert.equal(ug.song, 'Here I Am To Worship');
assert.equal(ug.id, '1234567');

const v2 = parseSource('https://tabs.ultimate-guitar.com/tab/hillsong-worship/who-you-say-i-am-ver2-guitar-pro-99999');
assert.equal(v2.version, 2);
assert.equal(v2.type, 'Guitar Pro');
assert.equal(v2.song, 'Who You Say I Am');
const v3 = parseSource('https://tabs.ultimate-guitar.com/tab/air-supply/here-i-am-guitar-pro-ver2-4455667');
assert.equal(v3.version, 2);

assert.equal(parseSource('javascript:alert(1)'), null);
assert.equal(parseSource('not a link'), null);
assert.equal(parseSource('https://gprotab.net/en/tabs/x').site, 'GProTab');

assert.deepEqual(parseFilename('Led Zeppelin-Stairway to Heaven-12-08-2025.gp'), { artist: 'Led Zeppelin', song: 'Stairway to Heaven', date: '2025-12-08' });
assert.equal(parseFilename('Relient K-Forget And Not Slow Down-10-16-2025 (1).gp').date, '2025-10-16');
assert.equal(parseFilename('mysong.gp'), null);

assert.equal(sourceLine({ sourceUrl: 'https://tabs.ultimate-guitar.com/tab/chris-tomlin/here-i-am-to-worship-guitar-pro-1234567', versionNote: 'Passion Live version' }), 'Ultimate Guitar · Guitar Pro · Passion Live version');
assert.equal(sourceLine({}), '');
console.log('tabinfo: all tests passed');
