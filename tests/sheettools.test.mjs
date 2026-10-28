// Run: node tests/sheettools.test.mjs
import assert from 'node:assert/strict';
import { readSections, foldRepeats, viewHtml, lineHash, sectionHash } from '../js/chordsheetview.js';
import { clampSpeed, pxPerSecond, notesMap, setNote, dropNote, orphanNotes, backingChords, idOfLine } from '../js/sheettools.js';
import { shapesFor } from '../js/chordshapes.js';

/* ---------- scroll speed ---------- */
assert.equal(clampSpeed(0), 5, 'nothing → the default');
assert.equal(clampSpeed(-3), 1);
assert.equal(clampSpeed(99), 20);
assert.equal(clampSpeed('7'), 7);
assert.equal(pxPerSecond(5), 30);
assert.ok(pxPerSecond(6) > pxPerSecond(5), 'faster is faster');

/* ---------- notes ---------- */
const sheet = '[Verse]\nG       C\nAmazing grace\nD\nHow sweet\n\n[Chorus]\nG\nHome\n';
const blocks = readSections(sheet);
const verse = blocks[0].lines[0];
const { k, label } = idOfLine(verse);
assert.equal(label, 'Amazing grace');
assert.equal(k, lineHash(verse));
assert.notEqual(lineHash(blocks[0].lines[0]), lineHash(blocks[0].lines[1]), 'different lines have different ids');

let list = setNote([], { k, text: ' slow here ', color: 'blue', label, now: 5 });
assert.deepEqual(list, [{ k, text: 'slow here', color: 'blue', label: 'Amazing grace', at: 5 }]);
list = setNote(list, { k, text: 'slower', color: 'nope', now: 9 });
assert.equal(list.length, 1, 'one note a line');
assert.equal(list[0].text, 'slower');
assert.equal(list[0].color, 'yellow', 'an unknown colour is yellow');
assert.equal(list[0].at, 5, 'the first time is kept');
assert.equal(list[0].label, 'Amazing grace', 'the label is kept');
assert.equal(setNote([], { k, text: '', color: 'green' })[0].text, '', 'a colour alone is a highlight');
assert.equal(setNote([], { k, text: 'x'.repeat(900) })[0].text.length, 400);
assert.deepEqual(dropNote(list, k), []);
assert.deepEqual(dropNote(null, k), []);
assert.equal(notesMap(list).get(k).text, 'slower');
assert.equal(notesMap(null).size, 0);

/* ---------- a note shows on its line, and a changed line leaves it in the list at the end ---------- */
const items = foldRepeats(blocks);
let html = viewHtml(items, { notes: notesMap(list) });
assert.match(html, new RegExp(`class="ln hc hl c-yellow" data-k="${k}" data-an="${k}"`), 'the line is tinted');
assert.match(html, /class="an c-yellow"[^>]*><span class="ai">✎<\/span> slower<\/div>/, 'its words sit under it');
assert.equal((html.match(/data-an=/g) || []).length, 2, 'the line and its callout carry the id');
assert.doesNotMatch(viewHtml(items, { notes: notesMap(setNote([], { k, text: '', color: 'pink' })) }), /class="an /, 'a highlight has no callout');
assert.match(viewHtml(items), new RegExp(`data-k="${k}"`), 'every line has an id even with no notes');
assert.doesNotMatch(viewHtml(items), /data-an=/);

const edited = readSections(sheet.replace('Amazing grace', 'Amazing grace, now'));
assert.deepEqual(orphanNotes(list, blocks), [], 'nothing is lost while the line is there');
const gone = orphanNotes(list, edited);
assert.equal(gone.length, 1, 'the line changed: the note is an orphan');
html = viewHtml(foldRepeats(edited), { notes: notesMap(list), orphans: gone });
assert.match(html, /Notes on lines you changed/);
assert.match(html, /<i>Amazing grace<\/i> · slower/, 'the orphan says what line it was on');

// a section's name takes a note too
const sk = sectionHash('Chorus');
const withSec = setNote([], { k: sk, text: 'build', color: 'green', label: 'Chorus' });
html = viewHtml(items, { notes: notesMap(withSec) });
assert.match(html, new RegExp(`class="sh hl c-green" data-k="${sk}" data-an="${sk}"`));
assert.deepEqual(orphanNotes(withSec, blocks), []);
assert.equal(sectionHash('chorus'), sectionHash(' Chorus '), 'a name is read without caring for case or spaces');

// words are escaped
assert.doesNotMatch(viewHtml(items, { notes: notesMap(setNote([], { k, text: '<b>hi</b>' })) }), /<b>hi/);

/* ---------- a backing track's chords ---------- */
const lookup = (n) => shapesFor(n);
const bars = backingChords(['G', 'G', 'C', 'Em', 'Xyz', 'D/F#', 'G'], lookup);
assert.deepEqual(bars.map((b) => b.name), ['G', 'C', 'Em', 'D/F#', 'G'], 'repeats once, unknown chords left out');
assert.ok(bars.every((b) => Number.isInteger(b.root) && typeof b.type === 'string'));
assert.equal(backingChords(['G', 'C', 'G', 'C', 'G', 'C'], lookup, 3).length, 3, 'at most max bars');
assert.deepEqual(backingChords([], lookup), []);

console.log('ok sheettools');
