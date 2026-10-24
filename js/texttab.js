// Viewer for pasted plain-text tabs and chord sheets: highlighting, text size, auto-scroll,
// transpose, the strumming pattern, the song's video, and Perform (just the song, big).
import { updateSong } from './db.js';
import { createPracticeTimer, formatDuration } from './practice.js';
import { asciiTabToAlphaTex } from './asciitab.js';
import { shapesKey, keyLabel, toNashville, toRoman, pitchClass, noteName } from './theory.js';
import { shiftChordName } from './transpose.js';
import { findRecording } from './ytsearch.js';
import { playStrum, stopStrum } from './strumplay.js';

const $ = (id) => document.getElementById(id);
const CHORD = /^\(?[A-G][#b]?(m|maj|min|dim|aug|sus|add|M)?\d*(sus\d?|add\d+|b\d+|#\d+|\((?:no|add)?\d+\))*(\/[A-G][#b]?)?\)?$/; // G7sus, F2(no3) too
const TAB_LINE = /^\s*[A-Ga-g]?[#b]?\s*[|:]?[-0-9|hpbrx/\\~^().<>*=sv ]*-{3,}[-0-9|hpbrx/\\~^().<>*=sv ]*$/;

let song = null;
let scrolling = false;
let performing = false;
let tempo = 100;
let lastFrame = 0;
let carry = 0;

const timer = createPracticeTimer({
  isActive: () => !$('view-text').hidden,
  onTick: (s) => { $('tx-time').textContent = 'Practiced ' + formatDuration(s); },
});

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Ultimate Guitar's raw format wraps chords and tabs in [ch]..[/ch] and [tab]..[/tab].
export const cleanTabText = (text) => text.replace(/\[\/?(ch|tab)\]/g, '').replace(/\r\n?/g, '\n');

// Also on a chord line: repeats and bar marks ("G  C/G  (x2)", "| G | D |", "N.C.").
const EXTRA = /^(\(?x\d+\)?|\(?\d+x\)?|\|+|-+|N\.?C\.?)$/i;
const chordTokens = (line) => {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  return tokens.some((t) => CHORD.test(t)) && tokens.every((t) => CHORD.test(t) || EXTRA.test(t)) ? tokens : null;
};

function songChords(text) {
  return cleanTabText(text).split('\n').flatMap((line) =>
    TAB_LINE.test(line) ? [] : (chordTokens(line) || []).filter((t) => CHORD.test(t)).map((t) => t.replace(/[()]/g, '')));
}

// Rewrites a chord line, keeping each chord at its original column where possible
// so chords stay above the right lyric.
function chordLine(line, rename) {
  let html = '';
  let col = 0;
  for (const m of line.matchAll(/\S+/g)) {
    const chord = CHORD.test(m[0]);
    const shown = rename && chord ? m[0].replace(/[^()]+/, rename) : m[0];
    const gap = Math.max(col ? 1 : 0, m.index - col);
    html += ' '.repeat(gap) + (chord ? `<span class="chord" title="${escape(m[0])}">${escape(shown)}</span>` : escape(shown));
    col += gap + shown.length;
  }
  return html;
}

// rename: optional, a chord name -> the name to show (Nashville numbers, or moved to another key)
export function highlight(text, rename) {
  return cleanTabText(text).split('\n').map((line) => {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) return `<span class="section">${escape(line)}</span>`;
    if (TAB_LINE.test(line)) return `<span class="tab-line">${escape(line)}</span>`;
    if (chordTokens(line)) return chordLine(line, rename);
    return escape(line);
  }).join('\n');
}

// The UG helper's text files start with "Song - Artist", "Chords · Key: Bb · Capo: 3rd fret · Tuning: …"
// and "From: <url>". Those lines become the facts over the sheet; body is the sheet without them (null: not one).
export function sheetHead(text) {
  const lines = cleanTabText(text).split('\n');
  const from = /^From:\s*(https?:\S+)/.exec(lines[2] || '');
  const head = lines.slice(0, from ? 3 : 4).join('\n');
  return {
    key: /\bKey:\s*([A-G][#b]?m?)(?![\w#])/.exec(head)?.[1] || '',
    capo: Number(/\bCapo:\s*(\d+)/.exec(head)?.[1]) || 0,
    tuning: (/\bTuning:\s*([^·\n]+)/.exec(head)?.[1] || '').trim(),
    url: from?.[1] || '',
    body: from ? lines.slice(3).join('\n').replace(/^\n+/, '') : null,
  };
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

function render() {
  const head = sheetHead(song.data);
  // a combined song shows each tab in turn, under its instrument's name
  const text = [head.body ?? song.data, ...(song.parts || []).map((p) => `[${p.name} tab]\n${p.data}`)].join('\n\n');
  // the shapes' key: the page's Key: minus its capo, guessed from the chords only with no key line
  const detected = shapesKey(head.key, head.capo, songChords(text));
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
  keySelect.disabled = !numbers;
  // transpose: the chords as written (shapes) move; the key it sounds in is the page's, else the shapes' plus the capo
  const shift = song.transpose || 0;
  const shapes = moveKey(detected, shift);
  const sounds = moveKey(keyOf(head.key) || moveKey(detected, head.capo), shift);
  const rename = numbers && key ? (c) => numbers(c, key)
    : shift ? (c) => shiftChordName(c, shift, shapes ? flatKey(shapes) : false) : null;
  $('tx-body').innerHTML = highlight(text, rename);
  $('tx-shift').textContent = `Tr. ${shift > 0 ? '+' : ''}${shift}`;
  const facts = [
    sounds && `Key <b>${keyName(sounds)}</b>`,
    head.capo && `Capo <b>${head.capo}</b>${shapes ? ` · ${keyName(shapes)} shapes` : ''}`,
    `<b>${tempo}</b> bpm`,
    head.tuning && !/^E A D G B E$/.test(head.tuning) && `Tuning <b>${escape(head.tuning)}</b>`,
    // which key the numbers count from (the shapes as played, transposed too)
    numbers && key && `${song.chordMode === 'roman' ? 'Roman' : 'Nashville'} in <b>${keyName(moveKey(key, shift))}</b>`,
  ].filter(Boolean).map((f) => `<span class="chip">${f}</span>`);
  if (head.url) facts.push(`<a class="chip tx-more" href="${escape(head.url)}" target="_blank" rel="noopener">UG page</a>`);
  $('tx-facts').innerHTML = facts.join('');
  const strum = (song.strum || []).filter((p) => p.strokes?.length);
  $('tx-strum').hidden = !strum.length;
  $('tx-strum').innerHTML = strum.map(strumHtml).join('');
  // the strum is heard on the song's first chord, as the shapes are played (capo and transpose too)
  const first = songChords(text)[0];
  strumChord = { chord: first ? (shift ? shiftChordName(first, shift, shapes ? flatKey(shapes) : false) : first) : 'G', capo: head.capo || 0 };
  stopStrumPlay();
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
function videoLabel() {
  $('tx-video').textContent = !$('tx-vid').hidden ? 'Hide video' : videoId() ? '▶ Video' : 'Find video';
}

function showVideo(on) {
  const id = videoId();
  if (on && !id) { findVideo(); return; }
  $('tx-vid').hidden = !on;
  $('tx-vid-frame').innerHTML = on
    ? `<iframe src="https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1" title="Video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`
    : '';
  videoLabel();
}

// No video from UG: the best match on YouTube, kept as the song's recording.
async function findVideo() {
  const s = song;
  const btn = $('tx-video');
  btn.disabled = true;
  btn.textContent = 'Finding video…';
  try {
    const list = await findRecording({ ...s, title: s.title.replace(/\s*\((chords|tabs?|chord chart)\)\s*$/i, '') });
    const r = list.find((x) => x.id);
    if (!r) throw new Error('none');
    const saved = await updateSong(s.id, { recording: { kind: 'youtube', id: r.id, title: r.title || '', author: r.author || '' } });
    if (song?.id !== s.id) return;
    song = saved;
    showVideo(true);
  } catch {
    if (song?.id === s.id) btn.textContent = 'No video found';
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
  if (on) document.documentElement.requestFullscreen?.().catch(() => { /* not allowed here: still perform mode */ });
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function frame(now) {
  if (!scrolling) return;
  const dt = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;
  carry += dt * Number($('tx-speed').value) * 6; // px per second
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
  $('tx-scroll').textContent = on ? 'Stop scrolling' : 'Auto-scroll';
  if (on) requestAnimationFrame(frame);
}

export function openText(s) {
  song = s;
  $('tx-title').textContent = s.title;
  $('tx-artist').textContent = s.artist || '';
  $('tx-size').value = s.textSize || 15;
  $('tx-body').style.fontSize = $('tx-size').value + 'px';
  $('tx-speed').value = s.scrollSpeed || 5;
  $('tx-time').textContent = '';
  const playable = asciiTabToAlphaTex(s.data);
  // the tempo you set, else the strumming pattern's bpm, else the tab's own "Tempo:" line
  tempo = s.tempo || s.strum?.find((p) => p.bpm)?.bpm || playable?.tempo || 100;
  $('tx-tempo').value = tempo;
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
  stopStrumPlay();
  setScrolling(false);
  showVideo(false);
  if (performing) setPerform(false);
  timer.end();
}

export function initText({ onEdit }) {
  $('tx-strum').addEventListener('click', (e) => {
    const b = e.target.closest('[data-strum]');
    if (b) toggleStrum(Number(b.dataset.strum), b.dataset.mode);
  });
  $('tx-scroll').addEventListener('click', () => setScrolling(!scrolling));
  $('tx-size').addEventListener('input', (e) => {
    $('tx-body').style.fontSize = e.target.value + 'px';
    if (song) updateSong(song.id, { textSize: Number(e.target.value) });
  });
  $('tx-speed').addEventListener('change', (e) => { if (song) updateSong(song.id, { scrollSpeed: Number(e.target.value) }); });
  $('tx-edit').addEventListener('click', () => song && onEdit(song));
  $('tx-tempo').addEventListener('change', async (e) => {
    tempo = Math.max(30, Math.min(260, Number(e.target.value) || 100));
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
  $('tx-video').addEventListener('click', () => showVideo($('tx-vid').hidden));
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
    if (e.key === 'Escape' && performing) { setPerform(false); return; }
    if ($('view-text').hidden || e.target.closest('input, select, textarea, button, dialog')) return;
    if (e.code === 'Space') { e.preventDefault(); setScrolling(!scrolling); }
  });
}
