// Viewer for pasted plain-text tabs and chord sheets: highlighting, text size, auto-scroll,
// transpose, the strumming pattern, the song's video, and Perform (just the song, big).
import { updateSong, getValue, setValue, putSong, listSongs } from './db.js';
import { shapesFor } from './chordshapes.js';
import { chordDiagram } from './keys.js';
import { strum } from './pluck.js';
import { splitSheet, sheetToChordPro } from './sharecore.js';
import { readChordPro, curlyChords } from './chordpro.js';
import { createPracticeTimer, formatDuration } from './practice.js';
import { asciiTabToAlphaTex } from './asciitab.js';
import { shapesKey, keyLabel, toNashville, toRoman, pitchClass, noteName } from './theory.js';
import { shiftChordName } from './transpose.js';
import { findRecording } from './ytsearch.js';
import { playStrum, stopStrum } from './strumplay.js';
import { CHORD, TAB_LINE, chordTokens, cleanTabText, readSections, foldRepeats, viewHtml, capoPlan, chordsOf } from './chordsheetview.js';
import { clampSpeed, pxPerSecond, notesMap, setNote, dropNote, orphanNotes, backingChords } from './sheettools.js';
import { startClick, stopClick, setClickBpm, clicking, countIn, cancelCount, counting } from './sheetclick.js';
import { initVideoBar } from './sheetvideo.js';
import { numberUnits, displayTargets, setMark, dropMark, chainOf, marksMap, nextUnit } from './sheetsync.js';
import { createFollower } from './sheetfollow.js';
import { backingTex, STYLES } from './backing.js';

export { cleanTabText };

const $ = (id) => document.getElementById(id);

let song = null;
let scrolling = false;
let performing = false;
let tempo = 100;
let sizeStep = () => {}; // set by initText: the magnifier's step (1 bigger, -1 smaller)
let vbar = null; // the video panel's player and bar (js/sheetvideo.js), made by initText
let follower = null; // lights the line being sung and scrolls with the video (js/sheetfollow.js)
let units = []; // the sheet's lines in the order they are sung (js/sheetsync.js)
let timing = false; // the stopwatch is on: tap a line to give it the video's time
const TAP_LEAD = 0.3; // seconds: a tap comes this long after the line was sung
let followOn = true;
try { followOn = localStorage.getItem('fretboard-tx-follow') !== '0'; } catch { /* ignore */ }
let lastFrame = 0;
let carry = 0;

const timer = createPracticeTimer({
  isActive: () => !$('view-text').hidden,
  onTick: (s) => { $('tx-time').textContent = 'Practiced ' + formatDuration(s); },
});

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function songChords(text) {
  return cleanTabText(text).split('\n').flatMap((line) =>
    TAB_LINE.test(line) ? [] : (chordTokens(line) || []).filter((t) => CHORD.test(t)).map((t) => t.replace(/[()]/g, '')));
}

// Rewrites a chord line, keeping each chord at its original column where possible
// so chords stay above the right lyric.
// played: the chord's name as played (transposed), for its shapes; kept on it as data-chord
function chordLine(line, rename, played) {
  let html = '';
  let col = 0;
  for (const m of line.matchAll(/\S+/g)) {
    const chord = CHORD.test(m[0]);
    const shown = rename && chord ? m[0].replace(/[^()]+/, rename) : m[0];
    const gap = Math.max(col ? 1 : 0, m.index - col);
    const name = chord ? m[0].replace(/[()]/g, '') : '';
    html += ' '.repeat(gap) + (chord ? `<span class="chord" data-chord="${escape(played ? played(name) : name)}">${escape(shown)}</span>` : escape(shown));
    col += gap + shown.length;
  }
  return html;
}

// rename: optional, a chord name -> the name to show (Nashville numbers, or moved to another key)
export function highlight(text, rename, played) {
  return cleanTabText(text).split('\n').map((line) => {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) return `<span class="section">${escape(line)}</span>`;
    if (TAB_LINE.test(line)) return `<span class="tab-line">${escape(line)}</span>`;
    if (chordTokens(line)) return chordLine(line, rename, played);
    return escape(line);
  }).join('\n');
}

// A chord sheet starts with "Song - Artist", "Chords · Key: Bb · Capo: 3rd fret · Tuning: …" and maybe
// "From: <url>" (the UG helper, a ChordPro import, the editor). Those lines become the facts over the
// sheet; body is the sheet without them (null: it has no head).
export function sheetHead(text) {
  const clean = cleanTabText(text);
  const s = splitSheet(clean);
  const lines = clean.split('\n');
  const head = lines.length > s.body.length;
  return {
    key: s.key,
    capo: s.capo,
    tuning: s.tuning,
    url: s.url,
    body: head ? s.body.join('\n').replace(/^\n+/, '') : null,
  };
}

/* ---------- editing as ChordPro ---------- */

const hasChords = (text) => songChords(text).length > 0;
const TUNING = /^\s*\{\s*tuning\s*:\s*(.*?)\s*\}\s*$/im;

/** What the editor shows: a chord sheet as ChordPro ("[G]Amazing [C]grace"), a tab as it is. */
export function editorText(song) {
  if (!hasChords(song.data)) return String(song.data || '');
  return sheetToChordPro(song.data).replace(/^\{comment: Tuning (.*)\}$/m, '{tuning: $1}');
}

const looksChordPro = (text) => /^\s*\{\s*[\w-]+\s*(:[^}]*)?\}\s*$/m.test(text) || /\[[A-G][#b]?[^\]\s]{0,10}\]\S/.test(text) || curlyChords(text) !== text;

/**
 * The editor's text back as a chord sheet (chords over the words). ChordPro is turned back; anything
 * else (a pasted UG page) is kept as it is. old: the song before (its UG link is kept).
 */
export function fromEditor(text, { title = '', artist = '', old = null } = {}) {
  if (!looksChordPro(text)) return { data: cleanTabText(text), title, artist };
  const tuning = TUNING.exec(text)?.[1] || '';
  const r = readChordPro(text.replace(new RegExp(TUNING.source, 'gim'), ''));
  title ||= r.title;
  artist ||= r.artist;
  const lines = r.text.replace(/\n$/, '').split('\n');
  lines[0] = [title || 'Untitled', artist].filter(Boolean).join(' - ');
  if (tuning) lines[1] += ` · Tuning: ${tuning}`;
  const url = old ? splitSheet(cleanTabText(old.data)).url : '';
  if (url) lines.splice(2, 0, `From: ${url}`);
  return { data: lines.join('\n') + '\n', title, artist };
}

/** The editor's text as the song page shows it (the Edit dialog's live preview). */
export function previewHtml(text) {
  const { data } = fromEditor(text);
  return viewHtml(foldRepeats(readSections(sheetHead(data).body ?? data)));
}

const FLAT_MAJORS = [5, 10, 3, 8, 1]; // F Bb Eb Ab Db
const flatKey = (k) => FLAT_MAJORS.includes(k.minor ? (k.tonic + 3) % 12 : k.tonic);
const keyName = (k) => noteName(k.tonic, flatKey(k)) + (k.minor ? 'm' : '');
const moveKey = (k, n) => k && { tonic: (((k.tonic + n) % 12) + 12) % 12, minor: k.minor };
const keyOf = (name) => (name ? { tonic: pitchClass(name), minor: /m$/.test(name) } : null);

// UG's strokes: 1 down, 101 up, 3 / 103 accented, 2 / 102 muted, 0 none.
const STROKE = { 1: ['↓', ''], 2: ['↓', 'mute'], 3: ['↓', 'acc'], 101: ['↑', ''], 102: ['↑', 'mute'], 103: ['↑', 'acc'] };
export function strumHtml(p, i = 0) {
  const perBeat = p.triplet ? 3 : Math.max(1, (p.per || 8) / 4);
  const cells = p.strokes.map((n, i) => {
    const [arrow, kind] = STROKE[n] || ['', 'rest'];
    const pos = i % perBeat;
    const count = pos === 0 ? String((Math.floor(i / perBeat) % 4) + 1) : !p.triplet && pos === perBeat / 2 ? '&' : '';
    const mark = kind === 'acc' ? '>' : kind === 'mute' ? '×' : '';
    return `<span class="st ${kind}${pos === 0 ? ' beat' : ''}"><i>${mark}</i><b>${arrow}</b><small>${count}</small></span>`;
  }).join('');
  const play = `<span class="tx-strum-play"><button class="ghost small" data-strum="${i}" data-mode="play" title="Hear it on the guitar, over and over, at the song's tempo">▶ Play</button>`
    + `<button class="ghost small" data-strum="${i}" data-mode="slow" title="Starts at 60% and speeds up a little every two times through">Slow practice</button>`
    + `<span class="mono muted tx-strum-speed"></span></span>`;
  return `<div class="tx-strum-row" data-row="${i}"><div class="tx-strum-head"><span class="muted">${escape(p.part || 'Strumming')}${p.bpm ? ` · ${p.bpm} bpm` : ''}</span>${play}</div>`
    + `<div class="tx-strokes">${cells}</div></div>`;
}

let sheetCapo = 0; // the capo the sheet was written for
let shown = { size: 15, cols: 1 }; // what fit() picked
let items = [];
let lastSections = []; // the sheet as read, whole (no repeats folded)

function render() {
  const head = sheetHead(song.data);
  // a combined song shows each tab in turn, under its instrument's name
  const text = [head.body ?? song.data, ...(song.parts || []).map((p) => `[${p.name} tab]\n${p.data}`)].join('\n\n');
  const sections = readSections(text);
  units = numberUnits(sections);
  const chords = chordsOf(sections);
  // the shapes' key: the page's Key: minus its capo, guessed from the chords only with no key line
  const detected = shapesKey(head.key, head.capo, chords);
  const keySelect = $('tx-key');
  keySelect.innerHTML = '';
  keySelect.add(new Option(detected ? `Auto (${keyLabel(detected)}${detected.from === 'page' ? ', from the page' : ''})` : 'Auto (no chords found)', 'auto'));
  for (let pc = 0; pc < 12; pc++) {
    for (const minor of [false, true]) keySelect.add(new Option(keyLabel({ tonic: pc, minor }), `${pc}${minor ? 'm' : ''}`));
  }
  keySelect.value = song.key || 'auto';
  $('tx-chords').value = song.chordMode || 'letters';
  // Key for Nashville numbers and Roman numerals: the saved choice, or detected from the chords.
  const key = song.key && song.key !== 'auto'
    ? { tonic: parseInt(song.key, 10), minor: song.key.endsWith('m') }
    : detected;
  const numbers = { nashville: toNashville, roman: toRoman }[song.chordMode];
  $('tx-key-row').hidden = !numbers;
  // Transpose moves the key; the capo then lowers the shapes (the sheet's own capo is already in its chords).
  // The key it sounds in is the page's, else the shapes' plus the sheet's capo, moved by the transpose only.
  const shift = song.transpose || 0;
  sheetCapo = head.capo || 0;
  const plan = capoPlan({ written: sheetCapo, capo: song.capo ?? null, shift });
  capo = plan.capo;
  const shapes = moveKey(detected, plan.move);
  const sounds = moveKey(keyOf(head.key) || moveKey(detected, sheetCapo), shift);
  const played = plan.move ? (c) => shiftChordName(c, plan.move, shapes ? flatKey(shapes) : false) : null;
  const rename = numbers && key ? (c) => numbers(c, key) : played;
  const fold = song.fold !== false;
  items = foldRepeats(sections, fold && !timing); // timing shows every line, repeats too
  lastSections = sections;
  const marks = activeMarks();
  $('tx-body').innerHTML = viewHtml(items, {
    rename, played, notes: notesMap(song.annotations), orphans: orphanNotes(song.annotations, sections),
    times: timing ? marksMap(marks, units) : null, next: timing ? nextUnit(marks, units) : null,
  });
  $('tx-fold').checked = fold;
  hidePop();
  drawShapes();
  tuckChords();
  fit();
  prepFollow();
  $('tx-shift').textContent = `Tr ${shift > 0 ? '+' : ''}${shift}`;
  $('tx-capo').textContent = capo ? `Capo ${capo}` : 'No capo';
  $('tx-keychip').innerHTML = sounds ? `Key <b>${keyName(sounds)}</b>${capo && shapes ? `<small> · ${keyName(shapes)} shapes</small>` : ''}` : '';
  $('tx-keychip').title = shift && sounds ? `Written in ${keyName(moveKey(sounds, -shift))}` : '';
  const facts = [
    // played in another key than written: whose key it is, and the written one (kept)
    shift && `${song.keyBy ? `<b>${escape(song.keyBy)}’s</b> key` : 'Your key'} · ${sounds ? `written in <b>${keyName(moveKey(sounds, -shift))}</b>` : `moved <b>${shift > 0 ? '+' : ''}${shift}</b>`}`,
    sheetCapo && capo !== sheetCapo && `Sheet written for capo <b>${sheetCapo}</b>`,
    `<b>${tempo}</b> bpm`,
    head.tuning && !/^E A D G B E$/.test(head.tuning) && `Tuning <b>${escape(head.tuning)}</b>`,
    // which key the numbers count from (the shapes as played, transposed too)
    numbers && key && `${song.chordMode === 'roman' ? 'Roman' : 'Nashville'} in <b>${keyName(moveKey(key, shift))}</b>`,
  ].filter(Boolean).map((f) => `<span class="chip">${f}</span>`);
  if (head.url) facts.push(`<a class="chip" href="${escape(head.url)}" target="_blank" rel="noopener">UG page</a>`);
  $('tx-facts').innerHTML = facts.join('');
  const strum = (song.strum || []).filter((p) => p.strokes?.length);
  $('tx-strum').hidden = !strum.length;
  $('tx-strum').innerHTML = strum.map(strumHtml).join('');
  // the strum is heard on the song's first chord, as the shapes are played (capo and transpose too)
  const first = chords[0];
  strumChord = { chord: first ? (plan.move ? shiftChordName(first, plan.move, shapes ? flatKey(shapes) : false) : first) : 'G', capo };
  stopStrumPlay();
}

// A chord wider than its word would leave a gap before the next word. Where the words after it carry no
// chord of their own, the chord hangs over them instead (a negative margin, in em, so it holds at any size).
function tuckChords() {
  const range = document.createRange();
  const width = (node, first) => {
    range.selectNodeContents(node);
    return (first ? range.getClientRects()[0] : range.getBoundingClientRect())?.width || 0;
  };
  const jobs = [];
  for (const cs of $('tx-body').querySelectorAll('.w > .cs:last-child')) {
    const next = cs.parentElement.nextSibling;
    if (next?.nodeType !== 3 || !/\S/.test(next.data)) continue;
    const over = cs.getBoundingClientRect().width - width(cs.lastElementChild);
    if (over > 1) jobs.push([cs, Math.min(over, width(next, true))]);
  }
  for (const [cs, px] of jobs) cs.style.marginRight = `${-px / parseFloat(getComputedStyle(cs).fontSize)}em`;
}

/* ---------- fit: columns and text size from the screen ---------- */

const SIZES = [11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28]; // the A− / A+ steps
const AUTO = [24, 22, 20, 19, 18, 17, 16, 15, 14, 13, 12]; // tried in turn, biggest first, until the song fits the screen

// On a screen wide enough for two columns: two columns, as big as the whole song still fits. Otherwise
// (a phone, or a song too long for two) the biggest text with the fewest columns that fits. A song that
// can't fit at any size stays one column, at a size that reads well, and scrolls. A size you picked
// (A− / A+) is kept; only the columns follow the screen.
function fit() {
  const body = $('tx-body');
  if (!song || $('view-text').hidden) return;
  layoutTools();
  const manual = song.textSize > 0 ? song.textSize : 0;
  const cs = getComputedStyle(body);
  const inner = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const vid = $('tx-vid');
  const docked = !vid.hidden && getComputedStyle(vid).bottom !== 'auto'; // the strip under the song; beside it takes no height
  const room = innerHeight - (body.getBoundingClientRect().top + window.scrollY) - (docked ? vid.offsetHeight : 0) - 14;
  const apply = (size, cols) => {
    body.style.fontSize = `${size}px`;
    body.style.columnCount = cols > 1 ? String(cols) : '';
    body.classList.toggle('one', cols === 1);
  };
  const across = (size) => Math.max(1, Math.min(3, Math.floor((inner + size * 2.2) / (size * 23.2)))); // a column holds ~21 em
  const wide = [...body.querySelectorAll('.pre')]; // tab lines keep their spacing: they must fit the column too
  body.classList.toggle('tabs', wide.length > 0); // and a single column with tabs is wider
  const fits = () => body.offsetHeight <= room && !wide.some((p) => p.scrollWidth > p.clientWidth + 1);
  const sizes = manual ? [manual] : AUTO;
  let pick = null;
  for (const size of sizes) { // a computer: two columns whenever the whole song fits in two
    if (across(size) < 2) continue;
    apply(size, 2);
    if (fits()) { pick = { size, cols: 2 }; break; }
  }
  for (const size of pick ? [] : sizes) {
    for (let cols = 1; cols <= across(size) && !pick; cols++) {
      apply(size, cols);
      if (fits()) pick = { size, cols };
    }
    if (pick) break;
  }
  if (!pick) { // it scrolls: one column, as big as reads well while the tab lines still fit across
    const down = manual ? [manual] : AUTO.filter((n) => n <= 15);
    for (const size of down) {
      apply(size, 1);
      if (!wide.some((p) => p.scrollWidth > p.clientWidth + 1)) { pick = { size, cols: 1 }; break; }
    }
  }
  shown = pick || { size: manual || 12, cols: 1 };
  apply(shown.size, shown.cols);
}

/* ---------- chord shapes: the song's chords as diagrams, every way to play each, your own pick kept ---------- */

let capo = 0;
let myShapes = {}; // "6:m" (root:type) -> "2,4,4,2,2,2": the shape you play that chord with, in every song
let showShapes = false;
try { showShapes = localStorage.getItem('fretboard-tx-shapes') === '1'; } catch { /* ignore */ }

const shapeKey = (s) => `${s.root}:${s.type}`;
// a chord's shapes, yours first
function shapesOf(name) {
  const s = shapesFor(name);
  if (!s || !s.voicings.length) return null;
  const mine = myShapes[shapeKey(s)];
  const i = mine ? s.voicings.findIndex((v) => v.frets.join(',') === mine) : -1;
  return { ...s, mine: i, start: Math.max(0, i) };
}

const hear = (frets) => strum(frets.map((f) => (f < 0 ? f : f + capo)));

function drawShapes() {
  const bar = $('tx-shapes');
  $('tx-shapes-btn').setAttribute('aria-pressed', String(showShapes));
  bar.hidden = !showShapes;
  if (!showShapes) { bar.innerHTML = ''; return; }
  const names = [...new Set([...$('tx-body').querySelectorAll('.chord')].map((e) => e.dataset.chord))];
  const cards = names.map((n) => {
    const s = shapesOf(n);
    if (!s) return '';
    const v = s.voicings[s.start];
    return `<button class="tx-shape" data-chord="${escape(n)}" title="${escape(n)}: tap for other ways to play it">${chordDiagram(v.frets, s.root, { title: n, barre: v.barre })}</button>`;
  }).join('');
  bar.innerHTML = cards || '<span class="muted">No chord shapes for these chords.</span>';
}

/* the pop-up over a chord: its diagram, the other shapes, and "make this my shape" */

let pop = null; // { name, s, i, pinned, anchor }
let popTimer = 0;

function drawPop() {
  const box = $('tx-pop');
  const { name, s, i } = pop;
  const v = s.voicings[i];
  const n = s.voicings.length;
  const notes = [
    !s.exact && 'Closest shape (the full chord isn’t in the list)',
    s.bass !== null && `Bass note ${name.split('/')[1]}`,
    capo && `With capo ${capo}`,
  ].filter(Boolean);
  box.innerHTML = `<div class="tx-pop-head"><b>${escape(name)}</b><button class="ghost small" data-pop="close" aria-label="Close">✕</button></div>`
    + `<button class="tx-pop-dia" data-pop="hear" title="Hear it">${chordDiagram(v.frets, s.root, { barre: v.barre })}</button>`
    + `<div class="tx-pop-nav"><button class="ghost small" data-pop="prev" aria-label="Previous shape" ${n < 2 ? 'disabled' : ''}>‹</button>`
    + `<span>${escape(v.name)}<br><small class="muted">${i + 1} of ${n}</small></span>`
    + `<button class="ghost small" data-pop="next" aria-label="Next shape" ${n < 2 ? 'disabled' : ''}>›</button></div>`
    + (notes.length ? `<div class="muted small-text">${notes.map(escape).join('<br>')}</div>` : '')
    + (i === s.mine ? '<div class="tx-pop-mine">✓ Your shape</div>' : `<button class="small" data-pop="save">★ Use this shape</button>`);
}

function placePop() {
  const box = $('tx-pop');
  const r = pop.anchor.getBoundingClientRect();
  const w = box.offsetWidth, h = box.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
  box.style.top = `${top}px`;
  box.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
}

function showPop(anchor, pinned) {
  clearTimeout(popTimer);
  const name = anchor.dataset.chord;
  const s = shapesOf(name);
  if (!s) return;
  if (pop && pop.anchor === anchor) { pop.pinned ||= pinned; return; }
  pop = { name, s, i: s.start, pinned, anchor };
  $('tx-pop').hidden = false;
  drawPop();
  placePop();
  requestAnimationFrame(() => { if (pop?.anchor === anchor) placePop(); });
}

function hidePop() {
  clearTimeout(popTimer);
  pop = null;
  const box = $('tx-pop');
  if (box) box.hidden = true;
}

async function popAction(act) {
  if (!pop) return;
  const n = pop.s.voicings.length;
  if (act === 'close') { hidePop(); return; }
  if (act === 'prev' || act === 'next') { pop.i = (pop.i + (act === 'next' ? 1 : n - 1)) % n; pop.pinned = true; drawPop(); hear(pop.s.voicings[pop.i].frets); return; }
  if (act === 'hear') { hear(pop.s.voicings[pop.i].frets); return; }
  if (act === 'save') {
    myShapes = { ...myShapes, [shapeKey(pop.s)]: pop.s.voicings[pop.i].frets.join(',') };
    pop.s.mine = pop.i;
    drawPop();
    drawShapes();
    await setValue('chordShapes', myShapes);
  }
}

function initShapes() {
  getValue('chordShapes').then((v) => { myShapes = v || {}; if (song && showShapes) drawShapes(); }).catch(() => {});
  const box = document.createElement('div');
  box.id = 'tx-pop';
  box.className = 'tx-pop';
  box.hidden = true;
  document.body.append(box);
  box.addEventListener('click', (e) => { const b = e.target.closest('[data-pop]'); if (b) popAction(b.dataset.pop); });
  box.addEventListener('mouseenter', () => clearTimeout(popTimer));
  box.addEventListener('mouseleave', () => { if (pop && !pop.pinned) popTimer = setTimeout(hidePop, 250); });
  const hover = matchMedia('(hover: hover) and (pointer: fine)');
  $('tx-body').addEventListener('mouseover', (e) => {
    const c = e.target.closest('.chord');
    if (!c || !hover.matches || (pop && pop.pinned)) return;
    clearTimeout(popTimer);
    popTimer = setTimeout(() => showPop(c, false), 120);
  });
  $('tx-body').addEventListener('mouseout', (e) => {
    if (!e.target.closest('.chord') || (pop && pop.pinned)) return;
    clearTimeout(popTimer);
    popTimer = setTimeout(hidePop, 250);
  });
  const tap = (e) => {
    const c = e.target.closest('.chord, .tx-shape');
    if (!c) return;
    if (pop && pop.anchor === c && pop.pinned) { hidePop(); return; }
    if (pop && pop.anchor !== c) hidePop();
    showPop(c, true);
  };
  $('tx-body').addEventListener('click', tap);
  $('tx-shapes').addEventListener('click', tap);
  document.addEventListener('pointerdown', (e) => { if (pop && !e.target.closest('#tx-pop, .chord, .tx-shape')) hidePop(); });
  window.addEventListener('scroll', () => { if (pop) placePop(); }, { passive: true });
  // a new width refits the columns; a height change alone (a phone's address bar) leaves the text still
  let fitWidth = innerWidth;
  let fitTimer = 0;
  window.addEventListener('resize', () => {
    if (pop) placePop();
    if (!song || innerWidth === fitWidth) return;
    fitWidth = innerWidth;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fit, 120);
  });
  $('tx-shapes-btn').addEventListener('click', () => {
    showShapes = !showShapes;
    try { localStorage.setItem('fretboard-tx-shapes', showShapes ? '1' : '0'); } catch { /* ignore */ }
    drawShapes();
    menu(false);
    fit();
  });
}

/* ---------- hearing the strumming pattern ---------- */

let strumChord = { chord: 'G', capo: 0 };
let strumOn = null; // { i, mode }

function stopStrumPlay() {
  strumOn = null;
  stopStrum();
  for (const b of document.querySelectorAll('#tx-strum [data-strum]')) b.textContent = b.dataset.mode === 'play' ? '▶ Play' : 'Slow practice';
  for (const s of document.querySelectorAll('#tx-strum .tx-strum-speed')) s.textContent = '';
}

async function toggleStrum(i, mode) {
  const again = strumOn && strumOn.i === i && strumOn.mode === mode;
  stopStrumPlay();
  if (again) return;
  const pattern = (song?.strum || []).filter((p) => p.strokes?.length)[i];
  if (!pattern) return;
  const on = { i, mode };
  strumOn = on;
  const row = document.querySelector(`#tx-strum [data-row="${i}"]`);
  const button = row?.querySelector(`[data-mode="${mode}"]`);
  const speed = row?.querySelector('.tx-strum-speed');
  if (button) button.textContent = 'Loading…';
  const bpm = pattern.bpm || tempo;
  const ok = await playStrum(pattern, {
    ...strumChord, tempo: bpm, slow: mode === 'slow',
    onSpeed: (v) => { if (speed && strumOn === on) speed.textContent = `${Math.round(bpm * v)} bpm · ${strumChord.chord}`; },
  });
  if (strumOn !== on) return;
  if (!ok) { stopStrumPlay(); return; }
  if (button) button.textContent = '■ Stop';
}

/* ---------- video: the song's recording, beside the sheet ---------- */

const videoId = () => (song?.recording?.kind === 'youtube' && /^[\w-]{11}$/.test(song.recording.id) ? song.recording.id : '');
function videoLabel(note = '') {
  const tile = $('tx-t-video');
  const open = !$('tx-vid').hidden;
  tile.setAttribute('aria-pressed', String(open));
  tile.title = note || (open ? 'Hide the video' : videoId() ? 'Play along: the song’s video, or a backing track from its chords' : 'Find the song’s video, or make a backing track from its chords');
}

function showVideo(on) {
  const id = videoId();
  if (on && !id) { findVideo(); return; }
  $('view-text').classList.toggle('has-vid', on); // docked beside the song (wide) or under it (narrow), never over the chords
  if (!on && timing) setTiming(false);
  if (on) vbar.open(id); else vbar.close();
  videoLabel();
  fit();
  prepFollow();
}

// No video from UG: the best match on YouTube, kept as the song's recording.
async function findVideo() {
  const s = song;
  const btn = $('tx-t-video');
  btn.disabled = true;
  videoLabel('Finding the video…');
  try {
    const list = await findRecording({ ...s, title: s.title.replace(/\s*\((chords|tabs?|chord chart)\)\s*$/i, '') });
    const r = list.find((x) => x.id);
    if (!r) throw new Error('none');
    const saved = await updateSong(s.id, { recording: { kind: 'youtube', id: r.id, title: r.title || '', author: r.author || '' } });
    if (song?.id !== s.id) return;
    song = saved;
    showVideo(true);
  } catch {
    if (song?.id === s.id) videoLabel('No video found');
    setTimeout(videoLabel, 3000);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- perform: just the song, big ---------- */

function setPerform(on) {
  performing = on;
  document.body.classList.toggle('performing', on);
  $('tx-perform').textContent = on ? 'Leave perform' : 'Perform';
  $('tx-leave').hidden = !on;
  menu(false);
  if (on) document.documentElement.requestFullscreen?.().catch(() => { /* not allowed here: still perform mode */ });
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  requestAnimationFrame(fit); // the bar's gone: more room
}

/* ---------- the ⋯ menu: everything that isn't a tool you reach for while playing ---------- */

function menu(on) {
  const box = $('tx-menu');
  if (box.hidden === !on) return;
  box.hidden = !on;
  $('tx-more').setAttribute('aria-expanded', String(on));
  if (on) box.style.top = `${$('tx-top').getBoundingClientRect().bottom + 4}px`;
}

function frame(now) {
  if (!scrolling) return;
  const dt = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;
  carry += dt * pxPerSecond($('tx-speed').value);
  const step = Math.floor(carry);
  if (step) {
    carry -= step;
    window.scrollBy(0, step);
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) setScrolling(false);
  }
  requestAnimationFrame(frame);
}

function setScrolling(on) {
  scrolling = on;
  lastFrame = 0;
  carry = 0;
  $('tx-t-scroll').setAttribute('aria-pressed', String(on));
  if (on) { menu(false); requestAnimationFrame(frame); }
}

/* ---------- the floating tools: quick start, video, zoom, notes, metronome, scroll ---------- */

const speedNow = () => clampSpeed($('tx-speed').value);
const drawSpeed = () => { $('tx-t-speed').textContent = String(speedNow()); };
const drawBpm = () => { $('tx-t-bpm').textContent = String(tempo); };

// the column folds to a handle; the choice is kept
let toolsFolded = false;
try { toolsFolded = localStorage.getItem('fretboard-tx-tools-fold') === '1'; } catch { /* ignore */ }
function paintToolsFold() {
  $('tx-tools').classList.toggle('folded', toolsFolded);
  const b = $('tx-t-fold');
  b.setAttribute('aria-expanded', String(!toolsFolded));
  b.setAttribute('aria-label', toolsFolded ? 'Show the tools' : 'Fold the tools');
  b.title = toolsFolded ? 'Show the tools' : 'Fold the tools away';
  layoutTools();
}

// room for the column beside the song, and the top of it just under the bar
function layoutTools() {
  const v = $('view-text');
  v.style.setProperty('--tools-w', `${$('tx-tools').offsetWidth + 12}px`);
  v.style.setProperty('--tx-top-h', `${$('tx-top').offsetHeight}px`);
}

async function bumpSpeed(d) {
  if (!song) return;
  $('tx-speed').value = clampSpeed(speedNow() + d);
  drawSpeed();
  song = await updateSong(song.id, { scrollSpeed: speedNow() });
}

function toggleClick() {
  if (clicking()) stopClick(); else startClick(tempo);
  $('tx-t-click').setAttribute('aria-pressed', String(clicking()));
}

// one tap: back to the top, a bar of count-in at the song's tempo, then the song scrolls (and the click goes on if it was on)
async function quickStart() {
  const tile = $('tx-t-quick');
  if (counting()) { cancelCount(); return; }
  setScrolling(false);
  hideNote();
  window.scrollTo(0, 0);
  const wasClicking = clicking();
  stopClick();
  tile.setAttribute('aria-pressed', 'true');
  const done = await countIn(tempo, 4, (n) => { $('tx-t-quick-txt').textContent = String(n); });
  tile.setAttribute('aria-pressed', 'false');
  $('tx-t-quick-txt').textContent = '';
  if (wasClicking) startClick(tempo);
  if (done && song) setScrolling(true);
  $('tx-t-click').setAttribute('aria-pressed', String(clicking()));
}

// a backing track from the sheet's chords (in the key it sounds in), opened in the player
async function openBacking() {
  if (!song) return;
  const move = (song.transpose || 0) + sheetCapo;
  const names = chordsOf(lastSections).map((c) => (move ? shiftChordName(c, move, false) : c));
  const chords = backingChords(names, shapesFor);
  if (!chords.length) return;
  const style = 'pop';
  const clean = song.title.replace(/\s*\((chords|tabs?|chord chart)\)\s*$/i, '');
  const title = `${clean} – backing (${STYLES[style].label})`;
  const data = backingTex({ title, chords, style, tempo, repeats: 1 });
  const old = (await listSongs()).find((x) => x.kind === 'tex' && x.title === title);
  const id = old ? old.id : await putSong({ kind: 'tex', title, artist: 'Backing track', data, added: Date.now() });
  if (old) await updateSong(id, { data });
  location.hash = `song/${id}`;
}

function pickVideo(on) {
  const box = $('tx-vidpick');
  box.hidden = !on;
  if (!on) return;
  const r = $('tx-t-video').getBoundingClientRect();
  box.style.top = `${r.top}px`;
  box.style.right = `${innerWidth - r.left + 6}px`;
  $('tx-pick-backing').disabled = !chordsOf(lastSections).length;
}

/* notes: tap a line (with ✎ on) to write on it or colour it; a note's words sit under its line */

let annotating = false;
let noteFor = null; // { k, label }
let noteColor = 'yellow';

function hint(text) {
  $('tx-hint').hidden = !text;
  if (text) $('tx-hint').textContent = text;
}

function setAnnotating(on) {
  if (on && timing) setTiming(false);
  annotating = on;
  document.body.classList.toggle('annotating', on);
  $('tx-t-notes').setAttribute('aria-pressed', String(on));
  hint(on ? 'Tap a line to write on it' : null);
  if (!on) hideNote();
}

/* ---------- the sheet follows the video: tap each line as it is sung, then the lit line and the scroll go with it ---------- */

// the times tapped for this song's video (a different video makes them meaningless)
const activeMarks = () => (song?.timing?.video && song.timing.video === videoId() ? song.timing.marks || [] : []);

function prepFollow() {
  if (!follower) return;
  const { chain } = chainOf(activeMarks(), units);
  follower.set({ chain, targets: displayTargets(units, items), last: units.length - 1 });
  const ready = chain.length > 1;
  follower.enable(followOn && !timing && ready && !$('tx-vid').hidden);
  $('tx-t-follow').setAttribute('aria-pressed', String(followOn));
  $('tx-t-follow').title = ready ? 'Follow the video: light the line being sung and scroll with it' : 'Follow the video (first tap the lines’ times with the stopwatch)';
  $('tx-timing-clear').hidden = !activeMarks().length;
  syncFollow();
}

function syncFollow(playing = vbar?.playing) {
  if (!follower?.active) return;
  if (playing) { setScrolling(false); follower.start(); } else { follower.stop(); follower.update(true); }
}

function setFollow(on) {
  followOn = on;
  try { localStorage.setItem('fretboard-tx-follow', on ? '1' : '0'); } catch { /* ignore */ }
  prepFollow();
}

function setTiming(on) {
  if (on && $('tx-vid').hidden) return; // it needs the video
  if (timing === on) return;
  timing = on;
  document.body.classList.toggle('timing', on);
  $('tx-t-sync').setAttribute('aria-pressed', String(on));
  if (on) { setAnnotating(false); hint('Tap each line as it is sung'); } else hint(null);
  if (song) render();
}

async function saveMarks(marks) {
  if (!song) return;
  const t = { video: videoId(), marks };
  const id = song.id;
  song = { ...song, timing: t }; // taps come fast: the next one has to see this one
  render();
  const saved = await updateSong(id, { timing: t });
  if (song?.id === id) song = { ...saved, timing: song.timing };
}

function markUnit(u) {
  const id = units[u]?.id;
  if (!id || !videoId()) return;
  saveMarks(setMark(activeMarks(), id, Math.max(0, vbar.now() - (vbar.playing ? TAP_LEAD : 0))));
  // keep the next line in sight
  const nx = $('tx-body').querySelector('.next');
  if (nx) {
    const r = nx.getBoundingClientRect();
    if (r.bottom > innerHeight - 90 || r.top < $('tx-top').offsetHeight + 20) nx.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

const removeMark = (u) => { const id = units[u]?.id; if (id) saveMarks(dropMark(activeMarks(), id)); };

function labelOf(el) {
  const copy = el.cloneNode(true);
  copy.querySelectorAll('.chord, .rep').forEach((c) => c.remove());
  const t = copy.textContent.replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 38).trim()}…` : t;
}

function paintColor(c) {
  noteColor = c;
  for (const b of $('tx-note-colors').children) b.classList.toggle('on', b.dataset.c === c);
}

function hideNote() {
  noteFor = null;
  $('tx-note').hidden = true;
}

function openNote(k, label, anchor) {
  if (!song) return;
  const cur = notesMap(song.annotations).get(k);
  noteFor = { k, label: label || cur?.label || '' };
  $('tx-note-for').textContent = noteFor.label ? `“${noteFor.label}”` : 'Note';
  $('tx-note-text').value = cur?.text || '';
  paintColor(cur?.color || noteColor);
  $('tx-note-del').hidden = !cur;
  const box = $('tx-note');
  box.hidden = false;
  const r = (anchor || $('tx-body')).getBoundingClientRect();
  const h = box.offsetHeight;
  const top = r.bottom + 8 + h > innerHeight - 8 ? Math.max(8, r.top - h - 8) : r.bottom + 8;
  box.style.top = `${top}px`;
  box.style.left = `${Math.max(8, Math.min(innerWidth - box.offsetWidth - 8, r.left))}px`;
  $('tx-note-text').focus({ preventScroll: true });
}

async function saveNote(remove = false) {
  if (!song || !noteFor) return;
  const { k, label } = noteFor;
  const list = remove ? dropNote(song.annotations, k) : setNote(song.annotations, { k, text: $('tx-note-text').value, color: noteColor, label });
  hideNote();
  song = await updateSong(song.id, { annotations: list });
  render();
}

function initTools() {
  const tap = (id, fn) => $(id).addEventListener('click', fn);
  paintToolsFold();
  tap('tx-t-fold', () => {
    toolsFolded = !toolsFolded;
    try { localStorage.setItem('fretboard-tx-tools-fold', toolsFolded ? '1' : '0'); } catch { /* ignore */ }
    paintToolsFold();
    fit();
  });
  tap('tx-t-quick', quickStart);
  tap('tx-t-video', () => {
    if (!$('tx-vid').hidden) { showVideo(false); return; }
    pickVideo($('tx-vidpick').hidden);
  });
  tap('tx-pick-video', () => { pickVideo(false); showVideo(true); });
  tap('tx-pick-backing', () => { pickVideo(false); openBacking(); });
  tap('tx-t-zin', () => sizeStep(1));
  tap('tx-t-zout', () => sizeStep(-1));
  tap('tx-t-notes', () => setAnnotating(!annotating));
  tap('tx-t-sync', () => setTiming(!timing));
  tap('tx-t-follow', () => setFollow(!followOn));
  tap('tx-timing-clear', () => saveMarks([]));
  tap('tx-t-click', toggleClick);
  tap('tx-t-scroll', () => setScrolling(!scrolling));
  tap('tx-t-fast', () => bumpSpeed(1));
  tap('tx-t-slow', () => bumpSpeed(-1));
  tap('tx-note-ok', () => saveNote());
  tap('tx-note-del', () => saveNote(true));
  tap('tx-note-close', hideNote);
  $('tx-note-colors').addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (b) paintColor(b.dataset.c); });
  $('tx-note-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNote(); }
    if (e.key === 'Escape') { e.stopPropagation(); hideNote(); }
  });
  document.addEventListener('pointerdown', (e) => { if (!$('tx-vidpick').hidden && !e.target.closest('#tx-vidpick, #tx-t-video')) pickVideo(false); });
  // capture: with ✎ on, a tap on a line is for writing on it, not for the chord pop-up under it
  $('tx-body').addEventListener('click', (e) => {
    if (timing) { // a tap gives the line the video's time; the time's badge takes it away
      const badge = e.target.closest('.tm');
      const unit = e.target.closest('[data-i]');
      if (badge || unit) { e.stopPropagation(); if (badge) removeMark(Number(badge.dataset.u)); else markUnit(Number(unit.dataset.i)); }
      return;
    }
    const callout = e.target.closest('.an');
    const line = e.target.closest('[data-k]');
    if (callout) {
      const n = notesMap(song?.annotations).get(callout.dataset.an);
      const owner = $('tx-body').querySelector(`[data-k="${callout.dataset.an}"]`);
      if (n) { e.stopPropagation(); openNote(n.k, n.label, owner || callout); }
    } else if (line && (annotating || (line.dataset.an && !e.target.closest('.chord')))) {
      e.stopPropagation();
      openNote(line.dataset.k, labelOf(line), line);
    }
  }, true);
}

export function openText(s) {
  song = s;
  $('tx-title').textContent = s.title.replace(/\s*\((chords|tabs?|chord chart)\)\s*$/i, '');
  $('tx-artist').textContent = s.artist || '';
  $('tx-speed').value = clampSpeed(s.scrollSpeed || 5);
  $('tx-time').textContent = '';
  const playable = asciiTabToAlphaTex(s.data);
  // the tempo you set, else the strumming pattern's bpm, else the tab's own "Tempo:" line
  tempo = s.tempo || s.strum?.find((p) => p.bpm)?.bpm || playable?.tempo || 100;
  $('tx-tempo').value = tempo;
  menu(false);
  stopClick();
  cancelCount();
  $('tx-t-click').setAttribute('aria-pressed', 'false');
  setAnnotating(false);
  pickVideo(false);
  drawSpeed();
  drawBpm();
  render();
  $('tx-play').disabled = !playable;
  $('tx-play').title = playable
    ? `Play ${playable.bars} bars as a score (rhythm is guessed from spacing)`
    : 'No tab lines found — chord sheets can’t be played';
  setScrolling(false);
  showVideo(false);
  window.scrollTo(0, 0);
  timer.begin(s);
  updateSong(s.id, { lastOpened: Date.now() });
}

export function closeText() {
  hidePop();
  menu(false);
  stopStrumPlay();
  stopClick();
  cancelCount();
  setAnnotating(false);
  setTiming(false);
  pickVideo(false);
  setScrolling(false);
  showVideo(false);
  if (performing) setPerform(false);
  timer.end();
}

export function initText({ onEdit }) {
  initShapes();
  initTools();
  follower = createFollower({ body: $('tx-body'), now: () => vbar.now(), canScroll: () => !scrolling });
  vbar = initVideoBar({ onFold: fit, onState: syncFollow, onSeek: (t) => follower.update(true, t) });
  $('tx-strum').addEventListener('click', (e) => {
    const b = e.target.closest('[data-strum]');
    if (b) toggleStrum(Number(b.dataset.strum), b.dataset.mode);
  });
  // the magnifier picks a size and keeps it; "Fit text to screen" (the ⋯ menu) goes back to the biggest that fits
  sizeStep = async (d) => {
    if (!song) return;
    const next = d > 0 ? SIZES.find((n) => n > shown.size) : [...SIZES].reverse().find((n) => n < shown.size);
    if (!next) return;
    shown = { ...shown, size: next }; // at once: a quick second tap steps on from here
    song = await updateSong(song.id, { textSize: next });
    fit();
  };
  $('tx-fit').addEventListener('click', async () => {
    if (!song) return;
    song = await updateSong(song.id, { textSize: null });
    menu(false);
    fit();
  });
  $('tx-fold').addEventListener('change', async (e) => {
    if (!song) return;
    song = await updateSong(song.id, { fold: e.target.checked });
    render();
  });
  // the capo: the shapes to play with it at this fret; the key the song sounds in stays
  const moveCapo = async (d) => {
    if (!song) return;
    const next = Math.max(0, Math.min(11, capo + d));
    song = await updateSong(song.id, { capo: next === sheetCapo ? null : next });
    render();
  };
  $('tx-capo-down').addEventListener('click', () => moveCapo(-1));
  $('tx-capo-up').addEventListener('click', () => moveCapo(1));
  $('tx-lib').addEventListener('click', () => document.getElementById('menu-btn').click());
  $('tx-more').addEventListener('click', () => menu($('tx-menu').hidden));
  $('tx-leave').addEventListener('click', () => setPerform(false));
  document.addEventListener('pointerdown', (e) => { if (!$('tx-menu').hidden && !e.target.closest('#tx-menu, #tx-more')) menu(false); });
  $('tx-menu').addEventListener('click', (e) => { if (e.target.closest('.tx-btns button, .tx-nav a')) menu(false); });
  $('tx-speed').addEventListener('change', (e) => { if (song) updateSong(song.id, { scrollSpeed: speedNow() }); drawSpeed(); });
  $('tx-edit').addEventListener('click', () => song && onEdit(song));
  $('tx-tempo').addEventListener('change', async (e) => {
    tempo = Math.max(30, Math.min(260, Number(e.target.value) || 100));
    setClickBpm(tempo);
    drawBpm();
    if (!song) return;
    song = await updateSong(song.id, { tempo });
    render();
  });
  const transpose = async (n) => {
    if (!song) return;
    const t = (song.transpose || 0) + n;
    song = await updateSong(song.id, { transpose: Math.abs(t) > 11 ? 0 : t });
    render();
  };
  $('tx-down').addEventListener('click', () => transpose(-1));
  $('tx-up').addEventListener('click', () => transpose(1));
  $('tx-vid-close').addEventListener('click', () => showVideo(false));
  $('tx-perform').addEventListener('click', () => setPerform(!performing));
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && performing) setPerform(false); });
  $('tx-chords').addEventListener('change', async (e) => {
    if (!song) return;
    song = await updateSong(song.id, { chordMode: e.target.value });
    render();
  });
  $('tx-key').addEventListener('change', async (e) => {
    if (!song) return;
    song = await updateSong(song.id, { key: e.target.value });
    render();
  });
  $('tx-play').addEventListener('click', () => { if (song) location.hash = `song/${song.id}/play`; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('tx-note').hidden) { hideNote(); return; }
    if (e.key === 'Escape' && timing) { setTiming(false); return; }
    if (e.key === 'Escape' && pop) { hidePop(); return; }
    if (e.key === 'Escape' && !$('tx-menu').hidden) { menu(false); return; }
    if (e.key === 'Escape' && performing) { setPerform(false); return; }
    if ($('view-text').hidden || e.target.closest('input, select, textarea, button, dialog')) return;
    if (e.code === 'Space') { e.preventDefault(); setScrolling(!scrolling); }
  });
}
