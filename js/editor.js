// Editing a tab: arrange the sections, copy or delete bars, rename sections, with undo and redo.
// The edited tab is saved as a Guitar Pro file in the song; the file it came from is kept as the song's
// "original" (download it or go back to it from the Edit sheet).
import { updateSong } from './db.js';

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toast = (msg) => window.dispatchEvent(new CustomEvent('fbtoast', { detail: msg }));
const MAX_UNDO = 60;

let hooks = null;
let undo = [];
let redo = [];
let lastSongId = null;

/* ---------- the score as plain data ---------- */

// Sections as runs of bars: a run starts at a bar with a section mark (bars before the first mark are the "Intro").
export function sectionRuns(masterBars) {
  const starts = [];
  masterBars.forEach((mb, i) => { if (mb.section) starts.push(i); });
  if (!starts.length || starts[0] !== 0) starts.unshift(0);
  return starts.map((first, k) => {
    const mb = masterBars[first];
    const name = (mb.section?.text || mb.section?.marker || '').trim();
    return { first, last: (starts[k + 1] ?? masterBars.length) - 1, name: name || (k === 0 && !mb.section ? 'Start' : `Bar ${first + 1}`) };
  });
}

// New bar order after an operation on runs of bars. All return an array of old bar numbers.
export const orderMove = (runs, i, dir) => {
  const j = i + dir;
  if (j < 0 || j >= runs.length) return null;
  const list = runs.map((_, k) => k);
  [list[i], list[j]] = [list[j], list[i]];
  return list.flatMap((k) => range(runs[k].first, runs[k].last));
};
export const orderDuplicate = (runs, i) => runs.flatMap((r, k) => (k === i ? [...range(r.first, r.last), ...range(r.first, r.last)] : range(r.first, r.last)));
export const orderDelete = (runs, i) => (runs.length < 2 ? null : runs.flatMap((r, k) => (k === i ? [] : range(r.first, r.last))));
export const orderDuplicateBars = (total, a, b) => [...range(0, b), ...range(a, b), ...range(b + 1, total - 1)];
export const orderDeleteBars = (total, a, b) => (b - a + 1 >= total ? null : [...range(0, a - 1), ...range(b + 1, total - 1)]);
function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

let nextId = 1_000_000;
function freshIds(m) {
  if (m instanceof Map) { if (m.has('id')) m.set('id', nextId++); m.forEach(freshIds); } else if (Array.isArray(m)) m.forEach(freshIds);
  return m;
}

// Rebuilds the score with its bars in a new order (an old bar may appear twice or not at all). Returns Guitar Pro bytes.
function rearrange(score, order, rename) {
  const AT = hooks.AT;
  const o = AT.model.JsonConverter.scoreToJsObject(score);
  const seen = new Set();
  const take = (list, i) => { const c = structuredClone(list[i]); return c; };
  const bars = o.get('masterbars');
  o.set('masterbars', order.map((i) => {
    const c = take(bars, i);
    if (seen.has(i)) freshIds(c);
    seen.add(i);
    return c;
  }));
  o.get('tracks').forEach((t) => t.get('staves').forEach((s) => {
    const sb = s.get('bars');
    const dup = new Set();
    s.set('bars', order.map((i) => {
      const c = take(sb, i);
      if (dup.has(i)) freshIds(c);
      dup.add(i);
      return c;
    }));
  }));
  if (rename) {
    const mb = o.get('masterbars')[rename.bar];
    const sec = mb.get('section');
    if (rename.name) {
      if (sec) { sec.set('text', rename.name); if (sec.has('marker')) sec.set('marker', ''); }
      else mb.set('section', new Map([['text', rename.name], ['marker', '']]));
    } else mb.delete('section');
  }
  return write(AT.model.JsonConverter.jsObjectToScore(o, new AT.Settings()));
}

function write(score) {
  const bytes = new hooks.AT.exporter.Gp7Exporter().export(score, new hooks.AT.Settings());
  // Make sure the new file reads back before it replaces anything.
  const back = hooks.AT.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(bytes), new hooks.AT.Settings());
  if (back.masterBars.length !== score.masterBars.length) throw new Error('The edited tab did not read back correctly.');
  return bytes;
}

/* ---------- applying and undoing ---------- */

const FIELDS = ['kind', 'data', 'syncPoints', 'syncDone', 'loops', 'skips', 'transpose', 'capo'];
const snapshot = (song) => Object.fromEntries(FIELDS.map((k) => [k, song[k]]));

async function restore(snap) {
  const song = hooks.song();
  const changes = {};
  FIELDS.forEach((k) => { changes[k] = snap[k]; });
  Object.assign(song, changes);
  await updateSong(song.id, changes);
  hooks.reload();
  paint();
}

async function apply(label, make) {
  const song = hooks.song();
  if (!song) return;
  let bytes;
  try {
    bytes = make(hooks.readScore());
  } catch (e) {
    toast('Could not make that change: ' + (e?.message || e));
    return;
  }
  const before = snapshot(song);
  const changes = {
    kind: 'gp',
    data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    // Bar numbers moved, so what was tied to them starts over (Undo brings it back)
    syncPoints: [], syncDone: false, loops: [], skips: [],
  };
  if (!song.original) {
    const ext = song.kind === 'xml' ? 'musicxml' : song.kind === 'gp' ? 'gp' : song.kind === 'text' ? 'txt' : 'tex';
    changes.original = { kind: song.kind, data: song.data, name: `${song.title || 'tab'}.${ext}`, savedAt: Date.now() };
  }
  undo.push({ label, snap: before });
  if (undo.length > MAX_UNDO) undo.shift();
  redo = [];
  Object.assign(song, changes);
  await updateSong(song.id, changes);
  hooks.reload();
  paint();
  const hadSync = before.syncPoints?.length;
  toast(label + (hadSync ? '. The video sync starts over: Undo brings it back.' : '.'));
}

export async function undoEdit() {
  const step = undo.pop();
  if (!step) return;
  redo.push({ label: step.label, snap: snapshot(hooks.song()) });
  await restore(step.snap);
  toast('Undid: ' + step.label);
}

export async function redoEdit() {
  const step = redo.pop();
  if (!step) return;
  undo.push({ label: step.label, snap: snapshot(hooks.song()) });
  await restore(step.snap);
  toast('Redid: ' + step.label);
}

async function goBackToOriginal() {
  const song = hooks.song();
  if (!song?.original) return;
  if (!confirm('Go back to the original file? Your edits are kept in Undo until you leave this song.')) return;
  undo.push({ label: 'Back to the original', snap: snapshot(song) });
  redo = [];
  const o = song.original;
  const changes = { kind: o.kind, data: o.data, syncPoints: [], syncDone: false, loops: [], skips: [] };
  Object.assign(song, changes);
  await updateSong(song.id, changes);
  hooks.reload();
  paint();
}

function download(name, bytes, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---------- the Edit sheet ---------- */

function runs() {
  const score = hooks.score();
  return score ? sectionRuns(score.masterBars) : [];
}

function paint() {
  const box = $('ed-body');
  if (!box) return;
  const song = hooks.song();
  if (song?.id !== lastSongId) { lastSongId = song?.id ?? null; undo = []; redo = []; }
  $('ed-undo').disabled = !undo.length;
  $('ed-redo').disabled = !redo.length;
  $('ed-undo').title = undo.length ? `Undo: ${undo[undo.length - 1].label} (Ctrl+Z)` : 'Nothing to undo';
  $('ed-redo').title = redo.length ? `Redo: ${redo[redo.length - 1].label} (Ctrl+Y)` : 'Nothing to redo';
  $('ed-count').textContent = undo.length ? `${undo.length} change${undo.length > 1 ? 's' : ''} this visit` : '';
  const list = runs();
  box.innerHTML = list.map((r, i) => `<li class="ed-sec" data-i="${i}">
      <input class="ed-name" value="${esc(r.name)}" maxlength="40" aria-label="Section name" data-rename="${i}">
      <span class="muted small-text">bars ${r.first + 1}–${r.last + 1}</span>
      <span class="ed-btns">
        <button class="ghost small" data-act="up" ${i === 0 ? 'disabled' : ''} title="Move earlier (Alt+↑ with the cursor in it)" aria-label="Move ${esc(r.name)} earlier">▲</button>
        <button class="ghost small" data-act="down" ${i === list.length - 1 ? 'disabled' : ''} title="Move later (Alt+↓)" aria-label="Move ${esc(r.name)} later">▼</button>
        <button class="ghost small" data-act="dup" title="Repeat this section right after itself" aria-label="Copy ${esc(r.name)}">⧉</button>
        <button class="ghost small danger" data-act="del" ${list.length < 2 ? 'disabled' : ''} title="Remove this section" aria-label="Remove ${esc(r.name)}">✕</button>
      </span></li>`).join('');
  const orig = song?.original;
  $('ed-original').innerHTML = orig
    ? `Original kept: <b>${esc(orig.name)}</b> (${new Date(orig.savedAt).toLocaleDateString()}). <button class="small ghost" data-act="dl-original">Download original</button> <button class="small ghost" data-act="restore-original">Go back to original</button>`
    : 'Nothing edited yet. The first change keeps a copy of the file you have now as the original.';
  $('ed-note').hidden = song?.kind !== 'text';
  paintSelection();
}

function selectionRange() {
  const r = hooks.selection();
  return r ? { a: r.first, b: r.last } : null;
}

function paintSelection() {
  const r = selectionRange();
  $('ed-sel').textContent = r ? `Selected: bar${r.a === r.b ? ' ' + (r.a + 1) : 's ' + (r.a + 1) + '–' + (r.b + 1)}` : 'Tap bars in the tab (drag for several) to copy or remove them.';
  $('ed-bar-dup').disabled = $('ed-bar-del').disabled = !r;
}

const total = () => hooks.score()?.masterBars.length || 0;

function doSection(act, i) {
  const list = runs();
  const r = list[i];
  if (!r) return;
  const ops = {
    up: () => ['Move “' + r.name + '” earlier', orderMove(list, i, -1)],
    down: () => ['Move “' + r.name + '” later', orderMove(list, i, 1)],
    dup: () => ['Copy “' + r.name + '”', orderDuplicate(list, i)],
    del: () => ['Remove “' + r.name + '”', orderDelete(list, i)],
  };
  const [label, order] = ops[act]();
  if (order) apply(label, (score) => rearrange(score, order));
}

function doBars(act) {
  const r = selectionRange();
  if (!r) { toast('Select some bars in the tab first.'); return; }
  const n = r.b - r.a + 1;
  const word = n === 1 ? `bar ${r.a + 1}` : `bars ${r.a + 1}–${r.b + 1}`;
  if (act === 'dup') apply(`Copy ${word}`, (score) => rearrange(score, orderDuplicateBars(total(), r.a, r.b)));
  else {
    const order = orderDeleteBars(total(), r.a, r.b);
    if (!order) { toast('A tab needs at least one bar.'); return; }
    apply(`Remove ${word}`, (score) => rearrange(score, order));
  }
}

const sheetOpen = () => !$('ed-sheet').hidden;
const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

export function initEditor(h) {
  hooks = h;
  $('ed-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) doSection(b.dataset.act, Number(b.closest('.ed-sec').dataset.i));
  });
  $('ed-body').addEventListener('change', (e) => {
    const i = e.target.dataset.rename;
    if (i === undefined) return;
    const r = runs()[Number(i)];
    const name = e.target.value.trim();
    if (!r || name === r.name) return;
    apply(`Rename “${r.name}”`, (score) => rearrange(score, range(0, score.masterBars.length - 1), { bar: r.first, name }));
  });
  $('ed-undo').addEventListener('click', undoEdit);
  $('ed-redo').addEventListener('click', redoEdit);
  $('ed-bar-dup').addEventListener('click', () => doBars('dup'));
  $('ed-bar-del').addEventListener('click', () => doBars('del'));
  $('ed-original').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const song = hooks.song();
    if (act === 'dl-original' && song?.original) download(song.original.name, song.original.kind === 'text' || song.original.kind === 'tex' ? new TextEncoder().encode(song.original.data) : song.original.data);
    if (act === 'restore-original') goBackToOriginal();
  });
  $('ed-export').addEventListener('click', () => {
    const song = hooks.song();
    if (!song) return;
    try { download(`${song.title || 'tab'}.gp`, write(hooks.readScore())); } catch (err) { toast('Could not save the file: ' + (err?.message || err)); }
  });
  window.addEventListener('fbselection', paintSelection);
  window.addEventListener('fbscore', paint);
  document.querySelector('[data-sheet-btn=edit]')?.addEventListener('click', () => setTimeout(paint, 0));

  document.addEventListener('keydown', (e) => {
    if (document.getElementById('view-player')?.hidden || typing(e) || !hooks.song()) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); (e.shiftKey ? redoEdit : undoEdit)(); }
    else if (mod && k === 'y') { e.preventDefault(); redoEdit(); }
    else if (mod && k === 'd' && selectionRange()) { e.preventDefault(); doBars('dup'); }
    else if (mod && k === 'e') { e.preventDefault(); document.querySelector('[data-sheet-btn=edit]')?.click(); }
    else if ((k === 'delete' || k === 'backspace') && sheetOpen() && selectionRange()) { e.preventDefault(); doBars('del'); }
    else if (e.altKey && (k === 'arrowup' || k === 'arrowdown')) {
      const bar = hooks.cursorBar();
      const list = runs();
      const i = list.findIndex((r) => bar >= r.first && bar <= r.last);
      if (i >= 0) { e.preventDefault(); doSection(k === 'arrowup' ? 'up' : 'down', i); }
    }
  });
}
