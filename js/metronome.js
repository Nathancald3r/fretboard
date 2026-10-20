// Standalone metronome with sample-accurate Web Audio scheduling, tap tempo
// and an optional "speed builder" that nudges the tempo up every few bars.

const $ = (id) => document.getElementById(id);
const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;

let ctx = null;
let running = false;
let timerId = null;
let nextTime = 0;
let pulse = 0; // counts subdivisions since start
let barsDone = 0;
let taps = [];

const state = () => ({
  bpm: Number($('mt-bpm').value),
  beats: Number($('mt-beats').value),
  sub: Number($('mt-sub').value),
  accent: $('mt-accent').checked,
});

function click(time, kind) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = kind === 'accent' ? 1760 : kind === 'beat' ? 1100 : 760;
  const peak = kind === 'sub' ? 0.25 : 0.6;
  gain.gain.setValueAtTime(peak, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
  osc.connect(gain).connect(ctx.destination);
  osc.start(time);
  osc.stop(time + 0.06);
}

function schedule() {
  const s = state();
  while (nextTime < ctx.currentTime + LOOKAHEAD_S) {
    const pulsesPerBar = s.beats * s.sub;
    const inBar = pulse % pulsesPerBar;
    const isBeat = inBar % s.sub === 0;
    const beat = Math.floor(inBar / s.sub);
    click(nextTime, isBeat && beat === 0 && s.accent ? 'accent' : isBeat ? 'beat' : 'sub');
    if (isBeat) flashDot(beat, nextTime);
    pulse++;
    if (pulse % pulsesPerBar === 0) onBarDone();
    nextTime += 60 / state().bpm / s.sub;
  }
}

function onBarDone() {
  barsDone++;
  if (!$('mt-inc-on').checked) return;
  const every = Math.max(1, Number($('mt-inc-bars').value));
  if (barsDone % every !== 0) return;
  const max = Number($('mt-inc-max').value);
  const bpm = Number($('mt-bpm').value);
  if (bpm < max) setBpm(Math.min(max, bpm + Number($('mt-inc').value)));
}

function flashDot(beat, time) {
  const delay = Math.max(0, (time - ctx.currentTime) * 1000);
  setTimeout(() => {
    document.querySelectorAll('#mt-dots .dot').forEach((d, i) => d.classList.toggle('hit', i === beat));
  }, delay);
}

function renderDots() {
  const { beats, accent } = state();
  $('mt-dots').innerHTML = Array.from({ length: beats }, (_, i) =>
    `<div class="dot${i === 0 && accent ? ' accent' : ''}"></div>`).join('');
}

function setBpm(bpm) {
  bpm = Math.max(30, Math.min(260, Math.round(bpm)));
  $('mt-bpm').value = bpm;
  $('mt-bpm-val').textContent = bpm;
  localStorageSet('mt-bpm', bpm);
}

function start() {
  ctx ??= new AudioContext();
  ctx.resume();
  running = true;
  pulse = 0;
  barsDone = 0;
  nextTime = ctx.currentTime + 0.06;
  timerId = setInterval(schedule, TICK_MS);
  $('mt-go').textContent = 'Stop';
}

export function stopMetronome() {
  running = false;
  clearInterval(timerId);
  $('mt-go').textContent = 'Start';
  document.querySelectorAll('#mt-dots .dot').forEach((d) => d.classList.remove('hit'));
}

function tap() {
  const now = performance.now();
  taps = taps.filter((t) => now - t < 2500);
  taps.push(now);
  if (taps.length < 2) return;
  const gaps = taps.slice(1).map((t, i) => t - taps[i]);
  setBpm(60000 / (gaps.reduce((a, b) => a + b) / gaps.length));
}

function localStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

export function initMetronome() {
  try { setBpm(Number(localStorage.getItem('mt-bpm')) || 100); } catch { setBpm(100); }
  renderDots();
  $('mt-bpm').addEventListener('input', (e) => setBpm(Number(e.target.value)));
  document.querySelectorAll('[data-bpm]').forEach((b) =>
    b.addEventListener('click', () => setBpm(Number($('mt-bpm').value) + Number(b.dataset.bpm))));
  $('mt-beats').addEventListener('change', renderDots);
  $('mt-accent').addEventListener('change', renderDots);
  $('mt-go').addEventListener('click', () => (running ? stopMetronome() : start()));
  $('mt-tap').addEventListener('click', tap);
}
