// Run: node tests/sheetsync.test.mjs
import assert from 'node:assert/strict';
import { readSections, foldRepeats, viewHtml } from '../js/chordsheetview.js';
import { numberUnits, displayTargets, setMark, dropMark, chainOf, marksMap, nextUnit, medianPace, positionAt, follow } from '../js/sheetsync.js';

const sheet = `[Verse 1]
G       D
Amazing grace
Em      C
How sweet

[Chorus]
C       G
Sing it out
Am      D
Loud

[Chorus]
C       G
Sing it out
Am      D
Loud

[Verse 2]
G       D
Twas grace
Em      C
That taught

[Chorus]
C       G
Sing it out
Am      D
Loud
`;

/* ---------- the lines, in the order they are sung ---------- */
const blocks = readSections(sheet);
const units = numberUnits(blocks);
assert.equal(units.length, 10, 'every line is a unit, repeats too');
assert.deepEqual(units.map((x) => x.bi), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4], 'each knows its section');
assert.equal(units[2].hash, units[4].hash, 'the same line written again has the same hash');
assert.notEqual(units[2].id, units[4].id, 'but its own id: which time it was seen');
assert.equal(units[2].id.split('#')[1], '0');
assert.equal(units[4].id.split('#')[1], '1');
assert.equal(units[8].id.split('#')[1], '2');
assert.equal(blocks[0].lines[0].u, 0, 'the line carries its number');
assert.equal(blocks[0].lines[0].uf, true);

// a run of tab lines is one unit
const tabs = readSections('[Intro]\ne|-----0-----2-----|\nB|-----1-----3-----|\nG|-----0-----2-----|\n\n[Verse]\nG\nHello');
const tu = numberUnits(tabs);
assert.equal(tu.length, 2, 'a tab system is one unit');
assert.deepEqual(tabs[0].lines.map((l) => l.u), [0, 0, 0]);
assert.deepEqual(tabs[0].lines.map((l) => l.uf), [true, false, false]);
// notes ("✎ ...") are not lines to follow
assert.equal(numberUnits(readSections('[Verse]\nG\nHi\n✎ play softly\nC\nHo')).length, 2);

/* ---------- where each line is shown when repeats are folded ---------- */
const items = foldRepeats(blocks);
assert.deepEqual(items.map((i) => i.src), [[0], [1, 2], [3], [4]], 'items know their sections');
const targets = displayTargets(units, items);
assert.deepEqual(targets[0], { u: 0 }, 'a shown line is itself');
assert.deepEqual(targets[4], { u: 2 }, 'the Chorus written twice in a row shows the first one for both');
assert.deepEqual(targets[5], { u: 3 });
assert.deepEqual(targets[8], { b: 4 }, 'a later repeat is the marker standing for its section');
const open = displayTargets(units, foldRepeats(blocks, false));
assert.ok(open.every((t, i) => t.u === i), 'unfolded: every line is its own');

const html = viewHtml(items, { times: new Map([[0, { t: 12.4 }], [2, { t: 75, bad: true }]]), next: 1 });
assert.match(html, /data-i="0"/);
assert.match(html, /<span class="tm" data-u="0"[^>]*>0:12<\/span>/, 'a time is a badge on its line');
assert.match(html, /<span class="tm bad" data-u="2"/, 'a time that does not fit is marked');
assert.match(html, /class="ln hc next" data-k="[^"]+" data-i="1"/, 'the next line to tap is marked');
assert.match(html, /<div class="tx-rep" data-b="4">/, 'a marker lists the sections it stands for');
assert.doesNotMatch(viewHtml(items), /class="tm/, 'no badges without times');

/* ---------- the times you tapped ---------- */
let marks = [];
marks = setMark(marks, units[0].id, 10.123);
marks = setMark(marks, units[1].id, 14);
assert.equal(marks[0].t, 10.12, 'rounded to a hundredth');
marks = setMark(marks, units[0].id, 11);
assert.equal(marks.length, 2, 'one time a line');
assert.equal(marks.find((m) => m.id === units[0].id).t, 11);
assert.equal(setMark([], 'x', -4)[0].t, 0);
assert.deepEqual(dropMark(marks, units[0].id).map((m) => m.id), [units[1].id]);
assert.deepEqual(dropMark(null, 'x'), []);

// the times that fit the order of the lines are followed; a stray one is left out and shown as bad
const tapped = [[0, 10], [1, 14], [2, 99], [3, 22], [4, 26], [5, 30]].map(([u, t]) => ({ id: units[u].id, t }));
const c = chainOf(tapped, units);
assert.deepEqual(c.chain.map((m) => m.u), [0, 1, 3, 4, 5], 'the 99 s tap on line 2 does not fit');
assert.deepEqual([...c.bad], [2]);
assert.deepEqual(chainOf([{ id: 'gone#0', t: 5 }], units).all, [], 'a time for a line that is not in the sheet any more is ignored');
assert.equal(marksMap(tapped, units).get(2).bad, true);
assert.equal(marksMap(tapped, units).get(0).bad, false);

// which line to tap next
assert.equal(nextUnit([], units), 0);
assert.equal(nextUnit(tapped.slice(0, 2), units), 2);
assert.equal(nextUnit([{ id: units[9].id, t: 100 }], units), null, 'after the last line there is none');
assert.equal(nextUnit([], []), null);

/* ---------- the video's time → a place in the sheet ---------- */
const chain = [{ u: 0, t: 10 }, { u: 2, t: 18 }, { u: 4, t: 30 }];
assert.equal(positionAt(chain, 5, 9), null, 'before the first line: the intro');
assert.equal(positionAt([{ u: 0, t: 10 }], 20, 9), null, 'one tap is not enough');
assert.equal(positionAt(chain, 10, 9), 0);
assert.equal(positionAt(chain, 14, 9), 1, 'halfway between two taps, halfway between the lines');
assert.equal(positionAt(chain, 18, 9), 2);
assert.equal(positionAt(chain, 24, 9), 3);
assert.ok(Math.abs(positionAt(chain, 17.99, 9) - 2) < 0.01, 'continuous across a tap');
// after the last tap it carries on at the usual pace (4 and 6 s a line: the upper median) and stops at the last line
assert.equal(medianPace(chain), 6);
assert.equal(positionAt(chain, 36, 9), 5);
assert.equal(positionAt(chain, 9999, 9), 9, 'the last line stays');
assert.equal(medianPace([{ u: 0, t: 0 }]), 4, 'no pace to measure: a default');
assert.equal(medianPace([{ u: 0, t: 0 }, { u: 1, t: 0.1 }]), 0.5, 'never absurdly fast');

/* ---------- easing ---------- */
assert.equal(follow(100, 100, 0.016), 100);
assert.equal(follow(100, 200, 0), 100, 'no time, no move');
const one = follow(0, 100, 0.016, 0.35);
assert.ok(one > 0 && one < 10, 'a frame moves a little');
let x = 0;
for (let i = 0; i < 90; i++) x = follow(x, 100, 1 / 60, 0.35); // 1.5 s
assert.ok(x > 98 && x < 100, 'and it arrives without overshooting');
let y = 0, ys = [];
for (let i = 0; i < 30; i++) { y = follow(y, 100, 1 / 60, 0.35); ys.push(y); }
assert.ok(ys.every((v, i) => i === 0 || v >= ys[i - 1]), 'steadily');
assert.equal(follow(0, 100, 1 / 30, 0.35) > follow(0, 100, 1 / 60, 0.35), true, 'a longer frame moves further, so the speed does not depend on the frame rate');

console.log('ok sheetsync');
