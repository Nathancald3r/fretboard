// Viewer for pasted plain-text tabs and chord sheets: highlighting, text size, auto-scroll.
import { updateSong } from './db.js';
import { createPracticeTimer, formatDuration } from './practice.js';
import { asciiTabToAlphaTex } from './asciitab.js';

const $ = (id) => document.getElementById(id);
const CHORD = /^\(?[A-G][#b]?(m|maj|min|dim|aug|sus|add|M)?\d*(sus\d|add\d+|b\d+|#\d+)*(\/[A-G][#b]?)?\)?$/;
const TAB_LINE = /^\s*[A-Ga-g]?[#b]?\s*[|:]?[-0-9|hpbrx/\\~^().<>*=sv ]*-{3,}[-0-9|hpbrx/\\~^().<>*=sv ]*$/;

let song = null;
let scrolling = false;
let lastFrame = 0;
let carry = 0;

const timer = createPracticeTimer({
  isActive: () => !$('view-text').hidden,
  onTick: (s) => { $('tx-time').textContent = 'Practiced ' + formatDuration(s); },
});

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Ultimate Guitar's raw format wraps chords and tabs in [ch]..[/ch] and [tab]..[/tab].
export const cleanTabText = (text) => text.replace(/\[\/?(ch|tab)\]/g, '').replace(/\r\n?/g, '\n');

function highlight(text) {
  return cleanTabText(text).split('\n').map((line) => {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) return `<span class="section">${escape(line)}</span>`;
    if (TAB_LINE.test(line)) return `<span class="tab-line">${escape(line)}</span>`;
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens.length && tokens.every((t) => CHORD.test(t))) {
      return escape(line).replace(/\S+/g, (t) => `<span class="chord">${t}</span>`);
    }
    return escape(line);
  }).join('\n');
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
  $('tx-body').innerHTML = highlight(s.data);
  $('tx-size').value = s.textSize || 15;
  $('tx-body').style.fontSize = $('tx-size').value + 'px';
  $('tx-speed').value = s.scrollSpeed || 5;
  $('tx-time').textContent = '';
  $('tx-tempo').value = s.tempo || 100;
  const playable = asciiTabToAlphaTex(s.data);
  $('tx-play').disabled = !playable;
  $('tx-play').title = playable
    ? `Play ${playable.bars} bars as a score (rhythm is guessed from spacing)`
    : 'No tab lines found — chord sheets can’t be played';
  setScrolling(false);
  window.scrollTo(0, 0);
  timer.begin(s);
  updateSong(s.id, { lastOpened: Date.now() });
}

export function closeText() {
  setScrolling(false);
  timer.end();
}

export function initText({ onEdit }) {
  $('tx-scroll').addEventListener('click', () => setScrolling(!scrolling));
  $('tx-size').addEventListener('input', (e) => {
    $('tx-body').style.fontSize = e.target.value + 'px';
    if (song) updateSong(song.id, { textSize: Number(e.target.value) });
  });
  $('tx-speed').addEventListener('change', (e) => { if (song) updateSong(song.id, { scrollSpeed: Number(e.target.value) }); });
  $('tx-edit').addEventListener('click', () => song && onEdit(song));
  $('tx-tempo').addEventListener('change', async (e) => {
    const tempo = Math.max(30, Math.min(260, Number(e.target.value) || 100));
    if (song) song = await updateSong(song.id, { tempo });
  });
  $('tx-play').addEventListener('click', () => { if (song) location.hash = `song/${song.id}/play`; });
  document.addEventListener('keydown', (e) => {
    if ($('view-text').hidden || e.target.closest('input, select, textarea, button, dialog')) return;
    if (e.code === 'Space') { e.preventDefault(); setScrolling(!scrolling); }
  });
}
