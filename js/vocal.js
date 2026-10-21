// Vocal training: hear a note from the key you chose, sing it back, hold it in tune to score a hit.
import { detectPitch, hzToMidi, midiToHz, midiName, judge } from './singcore.js';
import { SCALES, NOTES } from './theory.js';

const $ = (id) => document.getElementById(id);
const LOW = 52; // E3
const HIGH = 72; // C5
const HOLD_MS = 700;

let ctx = null;
let stream = null;
let analyser = null;
let buf = null;
let timer = null;
let target = null;
let inTuneSince = 0;
let hits = 0;
let tries = 0;
let advanceAt = 0;

const audio = () => { ctx ??= new AudioContext(); ctx.resume(); return ctx; };

function scaleNotes() {
  const root = Number($('vt-root').value);
  const steps = SCALES[$('vt-scale').value] || SCALES.Major || [0, 2, 4, 5, 7, 9, 11];
  const out = [];
  for (let m = LOW; m <= HIGH; m++) if (steps.includes(((m - root) % 12 + 12) % 12)) out.push(m);
  return out;
}

function playTarget() {
  if (target == null) return;
  const c = audio();
  const t = c.currentTime;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.3, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
  g.connect(c.destination);
  const o = c.createOscillator();
  o.type = 'triangle';
  o.frequency.value = midiToHz(target);
  o.connect(g);
  o.start(t);
  o.stop(t + 1.7);
}

function nextNote() {
  const notes = scaleNotes();
  let m;
  do { m = notes[Math.floor(Math.random() * notes.length)]; } while (notes.length > 1 && m === target);
  target = m;
  inTuneSince = 0;
  tries++;
  $('vt-target').textContent = midiName(target);
  $('vt-sung').textContent = '–';
  $('vt-meter').style.setProperty('--c', '0');
  playTarget();
  render();
}

function render() {
  $('vt-score').textContent = tries ? `${hits} in tune · ${tries} asked` : '';
}

function tick() {
  analyser.getFloatTimeDomainData(buf);
  const p = detectPitch(buf, ctx.sampleRate, { minHz: 70, maxHz: 900 });
  const now = performance.now();
  if (advanceAt && now > advanceAt) { advanceAt = 0; nextNote(); return; }
  if (!p || p.clarity < 0.7 || advanceAt) { inTuneSince = 0; return; }
  const sung = hzToMidi(p.hz);
  const j = judge(sung, target);
  $('vt-sung').textContent = `${midiName(sung)} · ${j.cents > 0 ? '+' : ''}${Math.round(j.cents)} cents ${j.status === 'in' ? '✓' : j.status}`;
  $('vt-meter').style.setProperty('--c', String(Math.max(-1, Math.min(1, j.cents / 100))));
  $('vt-meter').dataset.status = j.status;
  if (j.status !== 'in') { inTuneSince = 0; return; }
  inTuneSince ||= now;
  if (now - inTuneSince >= HOLD_MS) {
    hits++;
    $('vt-sung').textContent = 'Got it ✓';
    advanceAt = now + 900;
    render();
  }
}

async function start() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (err) {
    $('vt-sung').textContent = 'Microphone blocked or unavailable: ' + err.message;
    return;
  }
  const c = audio();
  analyser = c.createAnalyser();
  analyser.fftSize = 4096;
  buf = new Float32Array(analyser.fftSize);
  c.createMediaStreamSource(stream).connect(analyser);
  hits = 0;
  tries = 0;
  advanceAt = 0;
  timer = setInterval(tick, 50);
  $('vt-go').textContent = 'Stop';
  nextNote();
}

export function stopVocal() {
  clearInterval(timer);
  timer = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  target = null;
  $('vt-go').textContent = 'Start (uses mic)';
}

export function initVocal() {
  $('vt-root').innerHTML = NOTES.map((n, i) => `<option value="${i}">${n}</option>`).join('');
  $('vt-scale').innerHTML = Object.keys(SCALES).map((n) => `<option>${n}</option>`).join('');
  $('vt-go').addEventListener('click', () => (stream ? stopVocal() : start()));
  $('vt-hear').addEventListener('click', () => { if (target != null) playTarget(); else { target = scaleNotes()[0]; playTarget(); target = null; } });
  $('vt-skip').addEventListener('click', () => { if (stream) { advanceAt = 0; nextNote(); } });
}
