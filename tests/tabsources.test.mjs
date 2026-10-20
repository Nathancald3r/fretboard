// Run: node tests/tabsources.test.mjs
import assert from 'node:assert/strict';
import { splitQuery, sourceUrl, TAB_SOURCES } from '../js/tabsources.js';

assert.deepEqual(splitQuery('', 'Metallica - Nothing Else Matters'), { artist: 'Metallica', song: 'Nothing Else Matters' });
assert.deepEqual(splitQuery('Oasis', 'Wonderwall'), { artist: 'Oasis', song: 'Wonderwall' });

assert.equal(sourceUrl('911tabs', 'Metallica', 'Nothing Else Matters'),
  'https://www.911tabs.com/tabs/m/metallica/guitar_pro_tabs/nothing_else_matters_guitar_pro_tab.htm');
assert.equal(sourceUrl('911tabs', 'The Beatles', "Don't Let Me Down"),
  'https://www.911tabs.com/tabs/b/beatles/guitar_pro_tabs/dont_let_me_down_guitar_pro_tab.htm', '"The" dropped, apostrophe removed');
assert.equal(sourceUrl('911tabs', '', 'Wonderwall'), 'https://www.911tabs.com/search.php?search=Wonderwall', 'no artist: search');
assert.equal(sourceUrl('gprotab', 'Metallica', 'Nothing Else Matters'), 'https://gprotab.net/en/search?type=song&q=Nothing%20Else%20Matters');
assert.equal(sourceUrl('gprotab', 'Metallica', ''), 'https://gprotab.net/en/search?type=artist&q=Metallica');
assert.match(sourceUrl('ug-gp', 'Oasis', 'Wonderwall'), /value=Oasis%20Wonderwall&type=500$/);
assert.ok(TAB_SOURCES.every((s) => s.url({ artist: 'a', song: 'b' }).startsWith('https://')));

console.log('tabsources: all tests passed');
