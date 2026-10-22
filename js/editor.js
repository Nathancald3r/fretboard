// Editing a tab: arrange the sections, copy or delete bars, rename sections, with undo and redo.
// The edited tab is saved as a Guitar Pro file in the song; the file it came from is kept as the song's
// "original" (download it or go back to it from the Edit sheet).
import { updateSong } from './db.js';
import { versionLabel } from './songmeta.js';
import { askVersion } from './version.js';

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

// Runs fn on the score as plain data (Maps and arrays) and returns Guitar Pro bytes of the result.
function viaJson(score, fn) {
  const AT = hooks.AT;
  const o = AT.model.JsonConverter.scoreToJsObject(score);
  fn(o);
  return write(AT.model.JsonConverter.jsObjectToScore(o, new AT.Settings()));
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

const FIELDS = ['kind', 'data', 'syncPoints', 'syncDone', 'loops', 'skips', 'transpose', 'capo', 'edited', 'onOriginal'];
const snapshot = (song) => Object.fromEntries(FIELDS.map((k) => [k, song[k]]));

async function restore(snap) {
  const song = hooks.song();
  const changes = {};
  FIELDS.forEach((k) => { changes[k] = snap[k]; });
  Object.assign(song, changes);
  await updateSong(song.id, changes);
  hooks.clearSelection(); // a range left over from before can point at bars that no longer exist
  hooks.reload();
  paint();
}

async function apply(label, make, merge = '', keep = undefined) {
  const song = hooks.song();
  if (!song) return;
  const r0 = selectionRange();
  pendingSel = keep === undefined ? (r0 || null) : keep; // the bars stay selected after the change
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
    edited: null, onOriginal: false,
  };
  if (!song.original) {
    const ext = song.kind === 'xml' ? 'musicxml' : song.kind === 'gp' ? 'gp' : song.kind === 'text' ? 'txt' : 'tex';
    changes.original = { kind: song.kind, data: song.data, name: `${song.title || 'tab'}.${ext}`, savedAt: Date.now() };
  }
  const top = undo[undo.length - 1];
  if (merge && top?.merge === merge && Date.now() - top.at < 2500) top.at = Date.now(); // typing or nudging counts as one step
  else {
    undo.push({ label, snap: before, merge, at: Date.now() });
    if (undo.length > MAX_UNDO) undo.shift();
  }
  redo = [];
  Object.assign(song, changes);
  await updateSong(song.id, changes);
  hooks.clearSelection(); // a range left over from before can point at bars that no longer exist
  hooks.reload();
  paint();
  if (merge) return;
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

// "Your order" and "Original" switch places: the version not shown is kept with its sync and loops.
async function goBackToOriginal(toOriginal = true) {
  const song = hooks.song();
  if (!song?.original || !!song.onOriginal === toOriginal) return;
  if (!toOriginal && !song.edited) return;
  undo.push({ label: toOriginal ? 'Back to the original' : 'Back to your order', snap: snapshot(song) });
  redo = [];
  const keep = { kind: song.kind, data: song.data, syncPoints: song.syncPoints || [], syncDone: !!song.syncDone, loops: song.loops || [], skips: song.skips || [] };
  const o = toOriginal ? song.original : song.edited;
  const changes = toOriginal
    ? { kind: o.kind, data: o.data, syncPoints: [], syncDone: false, loops: [], skips: [], edited: keep, onOriginal: true }
    : { ...o, edited: null, onOriginal: false };
  Object.assign(song, changes);
  await updateSong(song.id, changes);
  hooks.clearSelection(); // a range left over from before can point at bars that no longer exist
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
  const mine = !song?.onOriginal || song?.edited;
  $('ed-original').innerHTML = orig
    ? `<span class="seg" role="group" aria-label="Which version plays">
        <button class="small ${song.onOriginal ? "" : "on"}" data-act="restore-edited" aria-pressed="${!song.onOriginal}" ${mine ? '' : 'disabled'}>Your order</button>
        <button class="small ${song.onOriginal ? "on" : ""}" data-act="restore-original" aria-pressed="${!!song.onOriginal}">Original</button></span>
      Original kept: <b>${esc(orig.name)}</b> (${new Date(orig.savedAt).toLocaleDateString()}). <button class="small ghost" data-act="dl-original">Download original</button>`
    : 'Nothing edited yet. The first change keeps a copy of the file you have now as the original.';
  if (document.activeElement !== $('ed-chords')) $('ed-chords').value = song?.chordSheet || '';
  $('ed-note').hidden = song?.kind !== 'text';
  paintSelection();
  paintBeat();
}

function selectionRange() {
  const r = hooks.selection();
  return r ? { a: r.first, b: r.last } : null;
}

function paintSelection() {
  const r = selectionRange();
  $('ed-sel').textContent = r ? `Selected: bar${r.a === r.b ? ' ' + (r.a + 1) : 's ' + (r.a + 1) + '–' + (r.b + 1)}` : 'Tap bars in the tab (drag for several) to copy or remove them.';
  $('ed-bar-dup').disabled = $('ed-bar-del').disabled = !r;
  if (typeof paintBar === 'function') paintBar();
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

function doBars(act, label = '') {
  const r = selectionRange();
  if (!r) { toast('Select some bars in the tab first.'); return; }
  const n = r.b - r.a + 1;
  const word = n === 1 ? `bar ${r.a + 1}` : `bars ${r.a + 1}–${r.b + 1}`;
  if (act === 'dup') apply(`Repeat ${word}`, (score) => rearrange(score, orderDuplicateBars(total(), r.a, r.b)), '', { a: r.b + 1, b: r.b + n });
  else {
    const order = orderDeleteBars(total(), r.a, r.b);
    if (!order) { toast('A tab needs at least one bar.'); return; }
    apply(label || `Remove ${word}`, (score) => rearrange(score, order), '', null);
  }
}


/* ---------- notes, tempo and bars at the selected beat ---------- */

// The beat you tapped in the tab. string: the internal number, higher = higher on the page.
let sel = null;

let lastBeat = null; // the beat under the last click, right-click included
export function pickBeat(beat) {
  lastBeat = beat || lastBeat;
  if (!beat || !$('ed-sheet') || $('ed-sheet').hidden) return;
  const bar = beat.voice.bar;
  if (beat.voice.index !== 0) { toast('Edit the first voice only.'); return; }
  const top = beat.notes.length ? Math.max(...beat.notes.map((n) => n.string)) : sel?.string;
  sel = { track: bar.staff.track.index, staff: bar.staff.index, bar: bar.index, beat: beat.index, string: top || bar.staff.tuning.length };
  if (editMode()) {
    // Tapping a bar selects it; with Extend on, everything from the first bar to this one.
    const cur = selectionRange();
    if (ctxPending && cur && bar.index >= cur.a && bar.index <= cur.b) { paintBeat(); return; } // right-click inside the selection keeps it
    if (!extending && !ctxPending && cur && cur.a === bar.index && cur.b === bar.index) { deselect(); paintBeat(); return; } // tap the selected bar again to deselect
    const from = extending && anchor !== null ? anchor : bar.index;
    if (!extending || anchor === null) anchor = bar.index;
    setTimeout(() => hooks.selectBars(Math.min(from, bar.index), Math.max(from, bar.index)), 0);
    if (extending) { extending = false; $('ed-extend').setAttribute('aria-pressed', 'false'); }
  }
  paintBeat();
}

const beatModel = () => {
  const bar = hooks.score()?.tracks[sel.track]?.staves[sel.staff]?.bars[sel.bar];
  return bar ? { bar, beat: bar.voices[0].beats[sel.beat] } : null;
};

function transposed() {
  const song = hooks.song();
  if (song?.transpose || song?.capo) { toast('Turn off Transpose / Capo before editing notes.'); return true; }
  return false;
}

function paintBeat() {
  const box = $('ed-notes');
  if (!box) return;
  const m = sel && beatModel();
  if (!m || !m.beat) sel = null;
  box.classList.toggle('off', !sel);
  $('ed-pos').textContent = sel ? `Bar ${sel.bar + 1}, beat ${sel.beat + 1}` : 'Tap a note or beat in the tab to edit it.';
  if (!sel) return;
  const staff = hooks.score().tracks[sel.track].staves[sel.staff];
  const note = m.beat.notes.find((n) => n.string === sel.string);
  $('ed-string').textContent = `string ${staff.tuning.length - sel.string + 1}`;
  $('ed-fret').value = note ? note.fret : '';
  $('ed-dur').value = String(m.beat.duration);
  $('ed-dot').checked = m.beat.dots > 0;
  const mb = m.bar.masterBar;
  $('ed-tempo').value = mb.tempoAutomations?.[0]?.value || '';
  $('ed-tsn').value = mb.timeSignatureNumerator;
  $('ed-tsd').value = String(mb.timeSignatureDenominator);
}

function beatJson(o) {
  const staff = o.get('tracks')[sel.track].get('staves')[sel.staff];
  const bar = staff.get('bars')[sel.bar];
  return { beat: bar.get('voices')[0].get('beats')[sel.beat] };
}

function noteEdit(label, fn, merge = '') {
  if (!sel || transposed()) return;
  apply(label, (score) => viaJson(score, (o) => fn(beatJson(o))), merge);
}

function setFret(fret) {
  if (!sel) return;
  const str = sel.string;
  fret = Math.max(0, Math.min(36, Math.round(fret)));
  noteEdit(`Fret ${fret} in bar ${sel.bar + 1}`, ({ beat }) => {
    const notes = beat.get('notes');
    const n = notes.find((x) => x.get('string') === str);
    if (n) n.set('fret', fret);
    else notes.push(new Map([['id', nextId++], ['string', str], ['fret', fret]]));
    beat.set('isempty', false);
  }, 'fret');
}

function nudgeFret(by) {
  const m = sel && beatModel();
  const note = m?.beat.notes.find((n) => n.string === sel.string);
  setFret(note ? note.fret + by : 0);
}

function removeNote() {
  if (!sel) return;
  const str = sel.string;
  noteEdit(`Remove note in bar ${sel.bar + 1}`, ({ beat }) => {
    beat.set('notes', beat.get('notes').filter((x) => x.get('string') !== str));
  });
}

function setDuration(value, dots) {
  noteEdit('Change note length', ({ beat }) => { beat.set('duration', value); beat.set('dots', dots); }, 'dur');
}

function setTempoAt(bpm) {
  if (!sel || !(bpm >= 20 && bpm <= 400)) return;
  apply(`Tempo ${bpm} from bar ${sel.bar + 1}`, (score) => viaJson(score, (o) => {
    const list = o.get('masterbars')[sel.bar].get('tempoautomations');
    if (list.length) list[0].set('value', bpm);
    else list.push(new Map([['islinear', false], ['type', 0], ['value', bpm], ['ratioposition', 0], ['text', ''], ['isvisible', true]]));
  }), 'tempo');
}

function setTimeSig(n, d) {
  if (!sel || !(n >= 1 && n <= 32) || ![1, 2, 4, 8, 16, 32].includes(d)) return;
  apply(`Bar ${sel.bar + 1} in ${n}/${d}`, (score) => viaJson(score, (o) => {
    const mb = o.get('masterbars')[sel.bar];
    mb.set('timesignaturenumerator', n);
    mb.set('timesignaturedenominator', d);
  }), 'timesig');
}

// An empty bar (a whole rest) right after the tapped one, in every track.
function insertEmptyBar() {
  const at = sel ? sel.bar : selectionRange()?.b;
  if (at === undefined) { toast('Tap a bar in the tab first.'); return; }
  apply(`Add an empty bar after bar ${at + 1}`, (score) => viaJson(score, (o) => {
    const mbs = o.get('masterbars');
    const mb = freshIds(structuredClone(mbs[at]));
    mb.delete('section');
    mb.set('isrepeatstart', false);
    mb.set('repeatcount', 0);
    mb.set('alternateendings', 0);
    mbs.splice(at + 1, 0, mb);
    o.get('tracks').forEach((t) => t.get('staves').forEach((s) => {
      const bar = freshIds(structuredClone(s.get('bars')[at]));
      bar.get('voices').forEach((v) => {
        const first = v.get('beats')[0];
        if (!first) return;
        first.set('notes', []);
        first.set('duration', 1);
        first.set('dots', 0);
        first.set('tupletnumerator', 1);
        first.set('tupletdenominator', 1);
        v.set('beats', [first]);
      });
      s.get('bars').splice(at + 1, 0, bar);
    }));
  }));
}

function moveBeat(by) {
  if (!sel) return;
  const bars = hooks.score().tracks[sel.track].staves[sel.staff].bars;
  let b = sel.bar;
  let i = sel.beat + by;
  if (i < 0) { b--; if (b < 0) return; i = bars[b].voices[0].beats.length - 1; }
  else if (i >= bars[b].voices[0].beats.length) { b++; if (b >= bars.length) return; i = 0; }
  sel = { ...sel, bar: b, beat: i };
  paintBeat();
}

function moveString(by) {
  if (!sel) return;
  const n = hooks.score().tracks[sel.track].staves[sel.staff].tuning.length;
  sel = { ...sel, string: Math.max(1, Math.min(n, sel.string + by)) };
  paintBeat();
}

let typedAt = 0;
let typedFret = 0;
function typeDigit(d) {
  const now = Date.now();
  typedFret = now - typedAt < 900 && typedFret * 10 + d <= 36 ? typedFret * 10 + d : d;
  typedAt = now;
  setFret(typedFret);
}

function initNotes() {
  $('ed-fret-dec').addEventListener('click', () => nudgeFret(-1));
  $('ed-fret-inc').addEventListener('click', () => nudgeFret(1));
  $('ed-fret').addEventListener('change', (e) => { if (e.target.value !== '') setFret(Number(e.target.value)); });
  $('ed-str-up').addEventListener('click', () => moveString(1));
  $('ed-str-down').addEventListener('click', () => moveString(-1));
  $('ed-note-del').addEventListener('click', removeNote);
  $('ed-beat-prev').addEventListener('click', () => moveBeat(-1));
  $('ed-beat-next').addEventListener('click', () => moveBeat(1));
  const dur = () => setDuration(Number($('ed-dur').value), $('ed-dot').checked ? 1 : 0);
  $('ed-dur').addEventListener('change', dur);
  $('ed-dot').addEventListener('change', dur);
  $('ed-tempo').addEventListener('change', (e) => setTempoAt(Number(e.target.value)));
  const sig = () => setTimeSig(Number($('ed-tsn').value), Number($('ed-tsd').value));
  $('ed-tsn').addEventListener('change', sig);
  $('ed-tsd').addEventListener('change', sig);
  $('ed-bar-add').addEventListener('click', insertEmptyBar);
}


/* ---------- edit mode: clipboard, rests, version ---------- */

const editMode = () => document.body.classList.contains('edit-mode');
let clip = null; // copied bars, as plain data: { masters: [...], bars: [track][staff][bar] }
let anchor = null; // first bar of a range being extended
let extending = false;
let pendingSel = null;

function capture(score, a, b) {
  const AT = hooks.AT;
  const o = AT.model.JsonConverter.scoreToJsObject(score);
  const pick = (list) => range(a, b).map((i) => structuredClone(list[i]));
  return {
    masters: pick(o.get('masterbars')),
    bars: o.get('tracks').map((t) => t.get('staves').map((s) => pick(s.get('bars')))),
  };
}

function copyBars(cut) {
  const r = selectionRange();
  if (!r) { toast('Select some bars first: tap a bar in the tab.'); return; }
  clip = capture(hooks.readScore(), r.a, r.b);
  paintBar();
  const word = r.a === r.b ? `bar ${r.a + 1}` : `bars ${r.a + 1}–${r.b + 1}`;
  if (cut) doBars('del', `Cut ${word}`);
  else toast(`Copied ${word}. Tap where it should go, then Paste.`);
}

function pasteBars() {
  if (!clip) { toast('Copy or cut some bars first.'); return; }
  const r = selectionRange();
  const at = r ? r.b : sel?.bar;
  if (at === undefined) { toast('Tap the bar to paste after.'); return; }
  const n = clip.masters.length;
  apply(`Paste ${n} bar${n > 1 ? 's' : ''} after bar ${at + 1}`, (score) => viaJson(score, (o) => {
    const tracks = o.get('tracks');
    if (tracks.length !== clip.bars.length) throw new Error('This tab has different tracks than the copied bars.');
    o.get('masterbars').splice(at + 1, 0, ...clip.masters.map((m) => freshIds(structuredClone(m))));
    tracks.forEach((t, ti) => t.get('staves').forEach((s, si) => {
      s.get('bars').splice(at + 1, 0, ...(clip.bars[ti][si] || []).map((b) => freshIds(structuredClone(b))));
    }));
  }), '', { a: at + 1, b: at + n });
}

// Empties the selected bars: each becomes rests (one rest per beat of the time signature).
function restBars() {
  const r = selectionRange();
  if (!r) { toast('Select some bars first.'); return; }
  apply(r.a === r.b ? `Rest in bar ${r.a + 1}` : `Rests in bars ${r.a + 1}–${r.b + 1}`, (score) => viaJson(score, (o) => {
    const mbs = o.get('masterbars');
    o.get('tracks').forEach((t) => t.get('staves').forEach((s) => {
      for (let i = r.a; i <= r.b; i++) {
        const mb = mbs[i];
        const n = Math.min(32, mb.get('timesignaturenumerator') || 4);
        const d = mb.get('timesignaturedenominator') || 4;
        s.get('bars')[i].get('voices').forEach((v, vi) => {
          const first = v.get('beats')[0];
          if (!first) return;
          first.set('notes', []);
          first.set('duration', d);
          first.set('dots', 0);
          first.set('tupletnumerator', 1);
          first.set('tupletdenominator', 1);
          v.set('beats', vi === 0 ? range(0, n - 1).map((k) => (k === 0 ? first : freshIds(structuredClone(first)))) : [first]);
        });
      }
    }));
  }), '', { a: r.a, b: r.b });
}

function deselect() {
  anchor = null;
  extending = false;
  $('ed-extend').setAttribute('aria-pressed', 'false');
  hooks.clearSelection();
}

function paintBar() {
  const r = selectionRange();
  ['ed-copy', 'ed-cut', 'ed-dup', 'ed-rest', 'ed-del'].forEach((id) => { $(id).disabled = !r; });
  $('ed-paste').disabled = !clip || (!r && !sel);
  $('ed-addbar').disabled = !r && !sel;
  $('ed-deselect').hidden = !r;
}

function paintVersion() {
  const song = hooks.song();
  const label = song ? versionLabel(song) : '';
  const pill = $('pl-version');
  pill.hidden = !label && !editMode();
  pill.textContent = label ? `🎧 ${label}` : '🎧 Set version…';
  pill.title = song?.version?.note ? song.version.note : 'Which recording this tab follows';
  $('ed-version-chip').textContent = label || 'Set version…';
  $('ed-back').href = song ? `#song/${song.id}` : '#library';
}

async function chooseVersion() {
  const song = hooks.song();
  if (!song) return;
  await askVersion(song);
  paintVersion();
}

function enterEditMode() {
  const song = hooks.song();
  if (!song) return;
  paintVersion();
  const sheet = $('ed-sheet');
  if (sheet.hidden) document.querySelector('[data-sheet-btn=edit]')?.click();
  if (!song.version) setTimeout(chooseVersion, 500); // first thing: which recording is this based on?
}

function initEditMode() {
  window.addEventListener('fbeditmode', enterEditMode);
  // From the practice player, "Edit tab" goes to the editing mode instead of opening a sheet.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sheet-btn=edit]');
    if (!b || editMode() || !hooks.song()) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    location.hash = `edit/${hooks.song().id}`;
  }, true);
  $('ed-deselect').addEventListener('click', deselect);
  $('ed-copy').addEventListener('click', () => copyBars(false));
  $('ed-cut').addEventListener('click', () => copyBars(true));
  $('ed-paste').addEventListener('click', pasteBars);
  $('ed-dup').addEventListener('click', () => doBars('dup'));
  $('ed-del').addEventListener('click', () => doBars('del'));
  $('ed-rest').addEventListener('click', restBars);
  $('ed-addbar').addEventListener('click', insertEmptyBar);
  $('ed-extend').addEventListener('click', () => {
    extending = !extending;
    $('ed-extend').setAttribute('aria-pressed', String(extending));
  });
  $('ed-version-chip').addEventListener('click', chooseVersion);
  $('pl-version').addEventListener('click', () => { if (editMode()) chooseVersion(); });
  window.addEventListener('fbscore', () => {
    paintVersion();
    if (pendingSel) {
      const p = pendingSel;
      pendingSel = null;
      const last = total() - 1;
      setTimeout(() => hooks.selectBars(Math.min(p.a, last), Math.min(p.b, last)), 150);
    }
  });
  window.addEventListener('fbselection', paintBar);
  initContextMenu();
}

/* ---------- right-click menu on the tab ---------- */

function linkNow(bar) {
  const link = $('pa-link-here');
  if (!link || link.disabled) { toast('Open the linked video first (Video button), then play it to the right moment.'); return; }
  if (hooks.pinned() === null && bar !== null) hooks.pin(bar);
  setTimeout(() => link.click(), 80);
}

function pinHere() {
  const link = $('pa-link-here');
  if (!link || link.disabled) { toast('Open the linked video first (Video button), then play it to the right moment.'); return; }
  if (lastBeat) hooks.selectBars(lastBeat.voice.bar.index, lastBeat.voice.bar.index); // the bar you right-clicked
  setTimeout(() => link.click(), 80);
}

let ctxEl = null;
let ctxPending = false;
const closeCtx = () => { ctxEl?.remove(); ctxEl = null; };

function showCtx(items, x, y) {
  closeCtx();
  ctxEl = document.createElement('div');
  ctxEl.className = 'card-menu ctx-menu';
  ctxEl.setAttribute('role', 'menu');
  ctxEl.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button role="menuitem" data-i="${i}" ${it.off ? 'disabled' : ''} class="${it.danger ? 'danger' : ''}">${esc(it.label)}${it.key ? `<small>${esc(it.key)}</small>` : ''}</button>`).join('');
  document.body.append(ctxEl);
  Object.assign(ctxEl.style, { left: Math.max(8, Math.min(x, innerWidth - 240)) + 'px', top: Math.max(8, Math.min(y, innerHeight - ctxEl.offsetHeight - 8)) + 'px' });
  ctxEl.addEventListener('click', (e) => {
    const it = items[Number(e.target.closest('[data-i]')?.dataset.i)];
    if (!it || it.off) return;
    closeCtx();
    it.run();
  });
}

function initContextMenu() {
  const area = $('score-scroll');
  area.addEventListener('pointerdown', (e) => { ctxPending = e.button === 2; }, true);
  area.addEventListener('contextmenu', (e) => { e.preventDefault(); openTabMenu(e.clientX, e.clientY); });
  // On a phone: press and hold on the tab.
  let hold = 0;
  let from = null;
  area.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    from = { x: e.clientX, y: e.clientY };
    hold = setTimeout(() => openTabMenu(from.x, from.y), 600);
  });
  area.addEventListener('pointermove', (e) => { if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 10) clearTimeout(hold); });
  ['pointerup', 'pointercancel'].forEach((t) => area.addEventListener(t, () => clearTimeout(hold)));
  function openTabMenu(x, y) {
    const song = hooks.song();
    if (!song) return;
    const barUnder = hooks.barAt(x, y);
    // pickBeat has run for this right-click by now (it selects the bar under the pointer in edit mode).
    setTimeout(() => {
      ctxPending = false;
      const r = selectionRange();
      const bars = r ? (r.a === r.b ? `bar ${r.a + 1}` : `bars ${r.a + 1}–${r.b + 1}`) : '';
      let items;
      if (editMode()) {
        items = [
          { label: r ? `Copy ${bars}` : 'Copy', key: 'Ctrl+C', off: !r, run: () => copyBars(false) },
          { label: 'Cut', key: 'Ctrl+X', off: !r, run: () => copyBars(true) },
          { label: 'Paste after', key: 'Ctrl+V', off: !clip || (!r && !sel), run: pasteBars },
          '-',
          { label: 'Repeat (play twice)', key: 'Ctrl+D', off: !r, run: () => doBars('dup') },
          { label: 'Make rests', off: !r, run: restBars },
          { label: 'Insert empty bar after', off: !r && !sel, run: insertEmptyBar },
          { label: 'Delete bars', key: 'Del', danger: true, off: !r, run: () => doBars('del') },
          '-',
          { label: 'Undo' + (undo.length ? `: ${undo[undo.length - 1].label}` : ''), key: 'Ctrl+Z', off: !undo.length, run: undoEdit },
          { label: 'Redo', key: 'Ctrl+Y', off: !redo.length, run: redoEdit },
          { label: 'Deselect', key: 'Esc', off: !r, run: deselect },
          '-',
          hooks.pinned() !== null
            ? { label: `📍 Unpin bar ${hooks.pinned() + 1}`, run: () => hooks.pin(null) }
            : { label: '📍 Pin this bar (for video sync)', off: barUnder === null, run: () => hooks.pin(barUnder) },
        ];
      } else {
        items = [
          { label: r ? `Loop ${bars}` : 'Loop (select bars first)', off: !r, run: () => hooks.loopSelection() },
          { label: 'Save this loop', off: !r, run: () => document.querySelector('#pl-loops [data-save]')?.click() },
          { label: 'Clear selection', key: 'Esc', off: !r, run: deselect },
          '-',
          hooks.pinned() !== null
            ? { label: `📍 Unpin bar ${hooks.pinned() + 1}`, run: () => hooks.pin(null) }
            : { label: '📍 Pin this bar (lock it as where the music starts)', off: barUnder === null, run: () => hooks.pin(barUnder) },
          { label: hooks.pinned() !== null ? `🎧 Link the video now to bar ${hooks.pinned() + 1}` : '🎧 Link the video now to this bar', off: hooks.pinned() === null && barUnder === null, run: () => linkNow(barUnder) },
          { label: hooks.holdScroll() ? '📌 Let the tab follow the playhead' : '📌 Keep the tab still while playing', run: () => hooks.toggleHold() },
          '-',
          { label: '✎ Edit this tab', run: () => { location.hash = `edit/${song.id}`; } },
        ];
      }
      showCtx(items, x, y);
    }, 30);
  }
  document.addEventListener('pointerdown', (e) => { if (ctxEl && !e.target.closest('.ctx-menu')) closeCtx(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });
  window.addEventListener('hashchange', closeCtx);
  window.addEventListener('blur', closeCtx);
}

const sheetOpen = () => !$('ed-sheet').hidden;
const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

export function initEditor(h) {
  hooks = h;
  initNotes();
  initEditMode();
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
  $('ed-chords-save').addEventListener('click', async () => {
    const song = hooks.song();
    if (!song) return;
    const chordSheet = $('ed-chords').value.replace(/\s+$/, '');
    song.chordSheet = chordSheet;
    await updateSong(song.id, { chordSheet });
    hooks.reload();
    $('ed-chords-msg').textContent = chordSheet ? 'Saved. The chords are lined up with the words again.' : 'Saved: no chord sheet, so chords come from the tab.';
  });
  $('ed-undo').addEventListener('click', undoEdit);
  $('ed-redo').addEventListener('click', redoEdit);
  $('ed-bar-dup').addEventListener('click', () => doBars('dup'));
  $('ed-bar-del').addEventListener('click', () => doBars('del'));
  $('ed-original').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const song = hooks.song();
    if (act === 'dl-original' && song?.original) download(song.original.name, song.original.kind === 'text' || song.original.kind === 'tex' ? new TextEncoder().encode(song.original.data) : song.original.data);
    if (act === 'restore-original') goBackToOriginal(true);
    if (act === 'restore-edited') goBackToOriginal(false);
  });
  $('ed-export').addEventListener('click', () => {
    const song = hooks.song();
    if (!song) return;
    const name = [song.title || 'tab', song.artist].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|]+/g, ' ');
    try { download(`${name}.gp`, write(hooks.readScore())); } catch (err) { toast('Could not save the file: ' + (err?.message || err)); }
  });
  // While the sheet is open the tab gets room above it, scrolled so the staff is in reach.
  new MutationObserver(() => {
    const open = !$('ed-sheet').hidden;
    document.body.classList.toggle('editing', open);
    if (open) setTimeout(() => $('score-scroll')?.scrollTo({ top: 70, behavior: 'smooth' }), 120);
  }).observe($('ed-sheet'), { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('fbselection', paintSelection);
  window.addEventListener('fbscore', paint);
  document.querySelector('[data-sheet-btn=edit]')?.addEventListener('click', () => setTimeout(paint, 0));

  document.addEventListener('keydown', (e) => {
    if (document.getElementById('view-player')?.hidden || typing(e) || !hooks.song()) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (k === 'escape' && selectionRange()) { deselect(); return; } // also in Practice: Esc clears a selected range / loop
    if (mod && k === 'z') { e.preventDefault(); (e.shiftKey ? redoEdit : undoEdit)(); }
    else if (mod && k === 'y') { e.preventDefault(); redoEdit(); }
    else if (mod && editMode() && k === 'c' && selectionRange()) { e.preventDefault(); copyBars(false); }
    else if (mod && editMode() && k === 'x' && selectionRange()) { e.preventDefault(); copyBars(true); }
    else if (mod && editMode() && k === 'v') { e.preventDefault(); pasteBars(); }
    else if (mod && k === 'd' && selectionRange()) { e.preventDefault(); doBars('dup'); }
    else if (mod && k === 'e') { e.preventDefault(); document.querySelector('[data-sheet-btn=edit]')?.click(); }
    else if (sheetOpen() && sel && !mod && !e.altKey && /^[0-9]$/.test(e.key)) { e.preventDefault(); typeDigit(Number(e.key)); }
    else if (sheetOpen() && sel && !mod && !e.altKey && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) {
      e.preventDefault();
      if (k === 'arrowleft') moveBeat(-1); else if (k === 'arrowright') moveBeat(1); else moveString(k === 'arrowup' ? 1 : -1);
    }
    else if ((k === 'delete' || k === 'backspace') && sheetOpen() && sel && !selectionRange()) { e.preventDefault(); removeNote(); }
    else if ((k === 'delete' || k === 'backspace') && sheetOpen() && selectionRange()) { e.preventDefault(); doBars('del'); }
    else if (e.altKey && (k === 'arrowup' || k === 'arrowdown')) {
      const bar = hooks.cursorBar();
      const list = runs();
      const i = list.findIndex((r) => bar >= r.first && bar <= r.last);
      if (i >= 0) { e.preventDefault(); doSection(k === 'arrowup' ? 'up' : 'down', i); }
    }
  });
}
