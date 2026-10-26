// Strum timing drill (#strum): a click plays a strum pattern, the mic hears your strums, and
// each one shows how many ms early or late it was. Rounds of a few bars; after a clean round
// the tempo can go up by itself.
import { PATTERNS, expectedStrums, barSeconds, createOnsetDetector, scoreStrums, verdict, loopbackLatency, nextBpm } from './strumcore.js';

const $ = (id) => document.getElementById(id);
const CAL_KEY = 'fretboard-strum-cal';
const BEST_KEY = 'fretboard-strum-best';
const SET_KEY = 'fretboard-strum-settings';
const LANE_MS = 120; // the lane shows ±120 ms

const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const save = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* fine */ } };

let ctx = null;
let stream = null;
let tap = null;
let round = null; // { pattern, bpm, start, end, expected, heard, clicks, mode }
let detector = null;
let timer = null;
let nextTimer = null;

const pattern = () => PATTERNS.find((p) => p.id === $('st-pattern').value) || PATTERNS[0];
const bpm = () => Math.max(40, Math.min(220, Number($('st-bpm').value) || 70));
const cal = () => load(CAL_KEY, { latency: 0, clickDb: -120 });

function setBpm(v) {
  $('st-bpm').value = Math.max(40, Math.min(220, Math.round(v)));
  keepSettings();
}

function keepSettings() {
  save(SET_KEY, { pattern: $('st-pattern').value, bpm: bpm(), click: $('st-click').value, bars: $('st-bars').value, auto: $('st-auto').checked });
}

/* ---------- audio ---------- */

async function openMic() {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0, channelCount: { ideal: 1 } },
    video: false,
  });
  await ctx.audioWorklet.addModule(new URL('./strum-tap.js', import.meta.url));
  tap = new AudioWorkletNode(ctx, 'fretboard-strum-tap');
  const silent = ctx.createGain();
  silent.gain.value = 0;
  ctx.createMediaStreamSource(stream).connect(tap).connect(silent).connect(ctx.destination);
  tap.port.onmessage = ({ data }) => {
    for (let i = 0; i < data.db.length; i++) {
      const t = data.t0 + i * data.hop;
      if (onLevel) onLevel(data.db[i], t);
      const hit = detector?.push(data.db[i], t);
      if (hit !== null && hit !== undefined && onStrum) onStrum(hit);
    }
  };
}

let onStrum = null;
let onLevel = null;

function closeMic() {
  clearInterval(timer);
  clearTimeout(nextTimer);
  timer = null;
  onStrum = onLevel = null;
  stream?.getTracks().forEach((t) => t.stop());
  ctx?.close().catch(() => {});
  ctx = stream = tap = detector = null;
}

function click(time, kind, volume = 0.35) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = kind === 'accent' ? 1760 : kind === 'beat' ? 1100 : 800;
  const peak = (kind === 'sub' ? 0.5 : 1) * volume;
  gain.gain.setValueAtTime(peak, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
  osc.connect(gain).connect(ctx.destination);
  osc.start(time);
  osc.stop(time + 0.05);
}

/* ---------- a round ---------- */

async function start() {
  if (round) return stop();
  $('st-start').disabled = true;
  try {
    await openMic();
  } catch (err) {
    $('st-status').textContent = 'The microphone could not start. Allow it for this site, then try again.';
    $('st-start').disabled = false;
    closeMic();
    return;
  }
  $('st-start').disabled = false;
  begin();
}

function begin() {
  const p = pattern();
  const tempo = bpm();
  const bars = Number($('st-bars').value) || 8;
  const mode = $('st-click').value; // beats | strums | countin
  const beatSec = 60 / tempo;
  const t0 = ctx.currentTime + 0.25;
  const start = t0 + barSeconds(p, tempo); // one bar count-in
  const clicks = [];
  for (let b = 0; b < p.beats; b++) { click(t0 + b * beatSec, b === 0 ? 'accent' : 'beat'); clicks.push(t0 + b * beatSec); }
  const expected = expectedStrums(p, tempo, start, bars);
  if (mode === 'beats') {
    for (let bar = 0; bar < bars; bar++) for (let b = 0; b < p.beats; b++) click(start + (bar * p.beats + b) * beatSec, b === 0 ? 'accent' : 'beat');
  } else if (mode === 'strums') {
    for (const e of expected) click(e.t, e.slot === 0 ? 'accent' : e.slot % p.sub === 0 ? 'beat' : 'sub');
  }
  const { latency, clickDb } = cal();
  detector = createOnsetDetector({ hop: 64 / ctx.sampleRate, minDb: clickDb > -120 ? clickDb + 6 : -70 });
  round = { pattern: p, bpm: tempo, start, end: start + bars * barSeconds(p, tempo), expected, heard: [], latency, offsets: [] };
  onStrum = (t) => {
    if (!round || t < round.start - 0.15) return;
    round.heard.push(t);
    const sc = scoreStrums(round.expected.filter((e) => e.t < t + 0.2), round.heard, { latency: round.latency });
    const last = sc.strums.filter((s) => s.offset !== null).pop();
    drawLane(sc);
    if (last) $('st-now').textContent = last.offset === 0 ? 'on the beat' : `${Math.abs(last.offset)} ms ${last.offset > 0 ? 'late' : 'early'}`;
  };
  onLevel = null;
  $('st-start').textContent = 'Stop';
  $('st-status').textContent = `Count-in… then ${bars} bars at ${tempo} BPM.`;
  $('st-now').textContent = '';
  drawLane({ strums: [] });
  timer = setInterval(() => tick(), 30);
}

function tick() {
  if (!round || !ctx) return;
  const now = ctx.currentTime;
  const p = round.pattern;
  const slotSec = 60 / round.bpm / p.sub;
  const n = Math.floor((now - round.start) / slotSec);
  document.querySelectorAll('#st-slots .slot').forEach((el, i) => el.classList.toggle('now', n >= 0 && n % p.slots.length === i));
  if (now >= round.start && $('st-status').textContent.startsWith('Count-in')) $('st-status').textContent = `Strum along. ${round.bpm} BPM.`;
  if (now > round.end + 0.3) finish();
}

function finish() {
  clearInterval(timer);
  timer = null;
  const r = round;
  round = null;
  onStrum = null;
  $('st-start').textContent = 'Start';
  const sc = scoreStrums(r.expected, r.heard, { latency: r.latency });
  drawLane(sc);
  showResult(sc, r);
  const best = load(BEST_KEY, {});
  const mine = best[r.pattern.id];
  if (sc.onTime >= 85 && (!mine || r.bpm > mine.bpm)) { best[r.pattern.id] = { bpm: r.bpm, onTime: sc.onTime, at: Date.now() }; save(BEST_KEY, best); }
  showBest();
  if ($('st-auto').checked) {
    const next = nextBpm(r.bpm, sc.onTime);
    if (next !== r.bpm) setBpm(next);
    $('st-status').textContent = `Next round at ${bpm()} BPM in 3 s. Press Stop to rest.`;
    $('st-start').textContent = 'Stop';
    nextTimer = setTimeout(() => { if (ctx) begin(); }, 3000);
  } else {
    $('st-status').textContent = 'Round done. Press Start for another.';
    closeMic();
  }
}

function stop() {
  round = null;
  closeMic();
  $('st-start').textContent = 'Start';
  $('st-status').textContent = 'Stopped.';
  document.querySelectorAll('#st-slots .slot').forEach((el) => el.classList.remove('now'));
}

/** Leaving the page: mic and clicks off. */
export function stopStrum() {
  if (ctx) stop();
}

/* ---------- drawing ---------- */

function drawSlots() {
  const p = pattern();
  $('st-slots').innerHTML = [...p.slots].map((s, i) => {
    const beat = i % p.sub === 0 ? `<small>${i / p.sub + 1}</small>` : `<small>${p.sub === 2 ? '&' : p.sub === 4 ? ['', 'e', '&', 'a'][i % 4] : ''}</small>`;
    return `<div class="slot${s === '-' ? ' rest' : ''}" data-i="${i}"><b>${s === 'D' ? '↓' : s === 'U' ? '↑' : '·'}</b>${beat}</div>`;
  }).join('');
}

const tone = (o) => (o === null ? 'miss' : Math.abs(o) <= 30 ? 'good' : Math.abs(o) <= 60 ? 'ok' : 'off');

function drawLane(sc) {
  const lane = $('st-lane');
  const done = sc.strums.slice(-24);
  lane.innerHTML = '<i class="zone"></i><i class="mid"></i>' + done.filter((s) => s.offset !== null).map((s, k, all) => {
    const x = 50 + (Math.max(-LANE_MS, Math.min(LANE_MS, s.offset)) / LANE_MS) * 50;
    const age = (all.length - 1 - k) / Math.max(1, all.length);
    return `<i class="dot ${tone(s.offset)}" style="left:${x}%;opacity:${(1 - age * 0.8).toFixed(2)}"></i>`;
  }).join('');
  // colour each slot by its latest result
  const p = pattern();
  const lastBySlot = {};
  for (const s of sc.strums) if (s.offset !== null || s.t < (ctx?.currentTime ?? 0) - 0.2) lastBySlot[s.slot] = s.offset;
  document.querySelectorAll('#st-slots .slot').forEach((el, i) => {
    el.classList.remove('good', 'ok', 'off', 'miss');
    if (p.slots[i] !== '-' && i in lastBySlot) el.classList.add(tone(lastBySlot[i]));
  });
}

function showResult(sc, r) {
  const lean = sc.mean === 0 ? 'right on the beat' : `${Math.abs(sc.mean)} ms ${sc.mean > 0 ? 'late' : 'early'} on average`;
  $('st-result').hidden = false;
  $('st-result').innerHTML = `<div class="stats">
      <div><b>${sc.onTime}%</b><span>within ±30 ms</span></div>
      <div><b>${sc.spread} ms</b><span>spread (lower is steadier)</span></div>
      <div><b>${sc.missed}</b><span>missed</span></div>
      <div><b>${sc.extras}</b><span>extra</span></div>
    </div>
    <p><b>${verdict(sc)}</b> You were ${lean} at ${r.bpm} BPM.</p>`;
}

function showBest() {
  const best = load(BEST_KEY, {});
  const mine = best[pattern().id];
  $('st-best').textContent = mine ? `Your best clean round on this pattern: ${mine.bpm} BPM.` : 'No clean round yet on this pattern (85% within ±30 ms).';
}

function showCal() {
  const c = load(CAL_KEY, null);
  $('st-latency').value = c ? Math.round(c.latency * 1000) : 0;
  $('st-cal-status').textContent = c ? `Delay ${Math.round(c.latency * 1000)} ms${c.clickDb > -120 ? ', click level measured' : ''}.` : 'Not set up yet. Strums will read late until it is.';
}

/* ---------- setup: how late the mic hears things ---------- */

async function calibrate(headphones) {
  if (round) stop();
  try { await openMic(); } catch {
    $('st-cal-status').textContent = 'The microphone could not start.';
    closeMic();
    return;
  }
  const beat = 60 / 90;
  const t0 = ctx.currentTime + 0.4;
  const clicks = Array.from({ length: 8 }, (_, i) => t0 + (i + (headphones ? 4 : 0)) * beat);
  if (headphones) for (let i = 0; i < 4; i++) click(t0 + i * beat, 'beat'); // count-in
  clicks.forEach((t) => click(t, 'beat'));
  const heard = [];
  let loud = -120;
  detector = createOnsetDetector({ hop: 64 / ctx.sampleRate, minDb: -120 });
  onStrum = (t) => heard.push(t);
  onLevel = (db, t) => { if (t > t0 && clicks.some((c) => t - c >= 0 && t - c < 0.3)) loud = Math.max(loud, db); };
  $('st-cal-status').textContent = headphones ? 'Strum muted strings on each click, after the 4 count-in clicks…' : 'Listening to the click… stay quiet.';
  await new Promise((done) => setTimeout(done, (clicks.at(-1) - ctx.currentTime + 0.6) * 1000));
  const lag = loopbackLatency(clicks, heard);
  closeMic();
  if (lag === null) {
    $('st-cal-status').textContent = headphones ? 'Not enough strums heard. Try again, a bit louder.' : 'The mic didn’t hear the click (headphones on?). Use the headphones setup instead.';
    return;
  }
  save(CAL_KEY, { latency: lag, clickDb: headphones ? -120 : loud });
  showCal();
}

/* ---------- page ---------- */

export function initStrum() {
  if (!$('st-pattern')) return;
  $('st-pattern').innerHTML = PATTERNS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  const s = load(SET_KEY, {});
  if (s.pattern) $('st-pattern').value = s.pattern;
  if (s.bpm) $('st-bpm').value = s.bpm;
  if (s.click) $('st-click').value = s.click;
  if (s.bars) $('st-bars').value = s.bars;
  $('st-auto').checked = !!s.auto;
  drawSlots();
  showBest();
  showCal();
  $('st-pattern').addEventListener('change', () => { drawSlots(); showBest(); keepSettings(); });
  ['st-bpm', 'st-click', 'st-bars', 'st-auto'].forEach((id) => $(id).addEventListener('change', keepSettings));
  document.querySelectorAll('[data-st-bpm]').forEach((b) => b.addEventListener('click', () => setBpm(bpm() + Number(b.dataset.stBpm))));
  $('st-start').addEventListener('click', start);
  $('st-cal-speaker').addEventListener('click', () => calibrate(false));
  $('st-cal-phones').addEventListener('click', () => calibrate(true));
  $('st-latency').addEventListener('change', () => {
    const c = load(CAL_KEY, { latency: 0, clickDb: -120 });
    save(CAL_KEY, { ...c, latency: Math.max(0, Number($('st-latency').value) || 0) / 1000 });
    showCal();
  });
}
