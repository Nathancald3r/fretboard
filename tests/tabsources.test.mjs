// Run: node tests/tabsources.test.mjs
import assert from 'node:assert/strict';
import { splitQuery, sourceUrl, TAB_SOURCES, matchScore, bestMatch } from '../js/tabsources.js';

assert.deepEqual(splitQuery('Metallica - Nothing Else Matters'), { artist: 'Metallica', song: 'Nothing Else Matters' });
assert.deepEqual(splitQuery('Wonderwall'), { artist: '', song: 'Wonderwall' });

assert.equal(sourceUrl('911tabs', 'Metallica - Nothing Else Matters'),
  'https://www.911tabs.com/tabs/m/metallica/guitar_pro_tabs/nothing_else_matters_guitar_pro_tab.htm');
assert.equal(sourceUrl('911tabs', "The Beatles - Don't Let Me Down"),
  'https://www.911tabs.com/tabs/b/beatles/guitar_pro_tabs/dont_let_me_down_guitar_pro_tab.htm', '"The" dropped, apostrophe removed');
assert.equal(sourceUrl('911tabs', 'Wonderwall'), 'https://www.911tabs.com/search.php?search=Wonderwall', 'no artist: search');
assert.equal(sourceUrl('gprotab', 'Metallica - Nothing Else Matters'), 'https://gprotab.net/en/search?type=song&q=Nothing%20Else%20Matters');
assert.match(sourceUrl('ug-gp', 'Oasis Wonderwall'), /value=Oasis%20Wonderwall&type=500$/);
assert.ok(TAB_SOURCES.every((s) => s.url({ artist: 'a', song: 'b' }).startsWith('https://')));

assert.equal(matchScore('Metallica-Nothing-Else-Matters-01-02-2020.gp', 'Metallica - Nothing Else Matters'), 1);
assert.equal(matchScore('Oasis-Wonderwall.gp5', 'Metallica - One'), 0);
assert.equal(bestMatch(['Oasis-Wonderwall.gp5', 'The Beatles - Let It Be.gp'], 'beatles let it be'), 1);
assert.equal(bestMatch(['x.gp'], 'something else'), -1);

console.log('tabsources: all tests passed');
