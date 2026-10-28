// The background line-up manager (scripts/autosync.mjs): requests made safe, one song at a time, each job's steps and result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutosync, parseRequest, stepOf, jobKey } from '../scripts/autosync.mjs';

const UG = 'https://tabs.ultimate-guitar.com/tab/chris-tomlin/holy-forever-official-3715413';
const later = () => new Promise((r) => setTimeout(r, 5));
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

test('a request is made safe', () => {
  assert.deepEqual(parseRequest({ title: ' Holy Forever ', artist: 'Chris Tomlin', ug: UG + '?x=1#y' }), { title: 'Holy Forever', artist: 'Chris Tomlin', ug: UG });
  assert.equal(parseRequest({ title: '--help' }).title, 'help', 'a leading dash would read as an option');
  assert.ok(parseRequest({ title: '' }).error);
  assert.ok(parseRequest({ title: 'x', ug: 'https://evil.example/tab/a/b-official-1' }).error, 'only Ultimate Guitar');
  assert.ok(parseRequest({ title: 'x', ug: 'https://tabs.ultimate-guitar.com/tab/a/b-chords-1' }).error, 'only an Official tab');
  assert.equal(parseRequest({ title: 'a\nb\u0000c' }).title, 'a b c');
  assert.equal(parseRequest({ title: 'x'.repeat(500) }).title.length, 120);
});

test('the pipeline lines become the pill words', () => {
  assert.equal(stepOf('    5. lining the tab up with the video'), 'lining the tab up with the video');
  assert.equal(stepOf('    2. the official tab on UG'), 'checking the official tab');
  assert.equal(stepOf('  trying Holy Forever (Chris Tomlin)'), 'trying “Holy Forever”');
  assert.equal(stepOf('    saving every track from UG (about 20 s)...'), '');
});

test('a passing song is done and delivered; the file is readable', async () => {
  const seen = [];
  const a = createAutosync({
    runner: async (q) => { q.log('    5. lining the tab up with the video'); seen.push(q); return { verdict: 'PASS', file: '/x/a.fretboard' }; },
    read: (f) => `text of ${f}`,
  });
  const j = a.start({ title: 'Holy Forever', artist: 'Chris Tomlin', ug: UG });
  assert.equal(j.key, jobKey('Holy Forever', 'Chris Tomlin'));
  await later();
  const [done] = a.list();
  assert.equal(done.state, 'done');
  assert.equal(done.deliver, true);
  assert.equal(done.step, 'lining the tab up with the video');
  assert.equal(seen[0].ug, UG);
  assert.equal(a.file(done.key), 'text of /x/a.fretboard');
  assert.equal(a.file('nope'), null);
});

test('timing only is delivered; a LISTEN is made but not delivered; a FAIL with no file is failed', async () => {
  const results = { a: { verdict: 'LISTEN', file: '/x', timingOnly: true }, b: { verdict: 'LISTEN', file: '/x' }, c: { verdict: 'ERROR', reason: 'no official tab on Ultimate Guitar' } };
  const a = createAutosync({ runner: async (q) => results[q.title] });
  for (const t of ['a', 'b', 'c']) { a.start({ title: t, artist: '', ug: '' }); await later(); }
  const by = Object.fromEntries(a.list().map((j) => [j.title, j]));
  assert.deepEqual([by.a.state, by.a.deliver, by.a.timingOnly], ['done', true, true]);
  assert.deepEqual([by.b.state, by.b.deliver], ['done', false]);
  assert.deepEqual([by.c.state, by.c.deliver, by.c.reason], ['failed', false, 'no official tab on Ultimate Guitar']);
});

test('one song at a time, in order; asking again while one is waiting changes nothing', async () => {
  const g = gate();
  const order = [];
  const a = createAutosync({ runner: async (q) => { order.push(`start ${q.title}`); await g.p; order.push(`end ${q.title}`); return { verdict: 'PASS', file: '/x' }; } });
  a.start({ title: 'one', artist: '', ug: '' });
  a.start({ title: 'two', artist: '', ug: '' });
  const again = a.start({ title: 'two', artist: '', ug: '' });
  await later();
  assert.deepEqual(order, ['start one']);
  assert.equal(a.list().find((j) => j.title === 'two').state, 'queued');
  assert.equal(again.state, 'queued');
  assert.equal(a.list().length, 2);
  g.open();
  await later(); await later();
  assert.deepEqual(order, ['start one', 'end one', 'start two', 'end two']);
});

test('a runner that throws leaves a reason, and the next song still runs', async () => {
  const a = createAutosync({ runner: async (q) => { if (q.title === 'bad') throw new Error('python is missing'); return { verdict: 'PASS', file: '/x' }; } });
  a.start({ title: 'bad', artist: '', ug: '' });
  a.start({ title: 'good', artist: '', ug: '' });
  await later(); await later();
  const by = Object.fromEntries(a.list().map((j) => [j.title, j]));
  assert.equal(by.bad.state, 'failed');
  assert.equal(by.bad.reason, 'python is missing');
  assert.equal(by.good.state, 'done');
});

test('a finished song can be asked for again', async () => {
  let runs = 0;
  const a = createAutosync({ runner: async () => { runs++; return { verdict: 'PASS', file: '/x' }; } });
  a.start({ title: 't', artist: '', ug: '' });
  await later();
  a.start({ title: 't', artist: '', ug: '' });
  await later();
  assert.equal(runs, 2);
  assert.equal(a.list().length, 1);
});
