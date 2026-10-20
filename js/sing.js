// Singing mode: sing the vocal track along with the song through a microphone. The sung
// pitch is detected live (YIN, in singcore.js) and compared with the note written at that
// moment; the play bar shows on / flat / sharp and a short pitch trace, and every song or
// loop ends with a score (share of note time sung within ±50 cents).
import {
  TOLERANCE, detectPitch, hzToMidi, midiToHz, midiName, judge, noteAt, createScorer, describe,
} from './singcore.js';

const $ = (id) => document.getElementById(id);

let hooks = {};
let ctx = null;
let analyser = null;
let stream = null;
let source = null;
let demo = null; // { osc, gain } — the test voice that sings the melody
let tap = null; // AudioWorkletNode posting mic frames (or null: poll the analyser)
let poll = 0;
let running = false;
let raf = 0;

const scorer = createScorer();
const results = []; // last few finished songs/loops
const trace = []; // recent { t, cents, status } for the lane in the play bar
const recent = []; // last few raw detections, for a median

// Where the song is. alphaTab reports the tick in small, uneven steps (several per audio
// block), so the tempo in ticks per ms is measured over a quarter second or more.
const pos = { tick: 0, at: 0, rate: 1.6, advancedAt: 0, anchorTick: 0, anchorAt: 0 };
let lastAnalysis = 0;
let live = { note: null, sung: null, cents: null, status: null, peak: 0 };

/* ---------- position from the player ---------- */

export function singPosition(e) {
  const now = performance.now();
  const tick = e.currentTick;
  const expected = Math.max(0, now - pos.at) * pos.rate;
  const jumped = tick < pos.tick || tick - pos.tick > expected * 3 + 960;
  if (tick > pos.tick && !jumped) pos.advancedAt = now;
  const span = now - pos.anchorAt;
  if (jumped || span > 2000) {
    pos.anchorTick = tick;
    pos.anchorAt = now;
  } else if (span >= 250) {
    const r = (tick - pos.anchorTick) / span;
    if (r > 0) pos.rate += (r - pos.rate) * 0.5; // follows tempo and speed changes
    pos.anchorTick = tick;
    pos.anchorAt = now;
  }
  pos.tick = tick;
  pos.at = now;
}

function estimatedTick(now) {
  // Count-in or paused: the position isn't moving, so nothing is being sung against.
  if (now - pos.advancedAt > 300) return null;
  return pos.tick + Math.min(now - pos.at, 200) * pos.rate;
}

// How long the voice takes to reach the analysis: the song's output latency (you sing to
// what you hear), the mic input latency and half the analysis window.
function latencyMs() {
  if (demo) return 0;
  const input = stream?.getAudioTracks()[0]?.getSettings?.().latency || 0;
  return (ctx.baseLatency || 0) * 1000 + input * 1000 + (2048 / ctx.sampleRate) * 500 + 40;
}

/* ---------- microphone ---------- */

function detach() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  try { source?.disconnect(); } catch { /* gone */ }
  source = null;
  if (demo) {
    try { demo.osc.stop(); demo.gain.disconnect(); } catch { /* gone */ }
    demo = null;
  }
}

async function start() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    // The analyser has to be pulled by the destination to run; send it there silently.
    const silent = ctx.createGain();
    silent.gain.value = 0;
    analyser.connect(silent).connect(ctx.destination);
    try {
      await ctx.audioWorklet.addModule(new URL('./sing-tap.js', import.meta.url));
      tap = new AudioWorkletNode(ctx, 'fretboard-sing-tap', { channelCount: 1, channelCountMode: 'explicit' });
      tap.port.onmessage = (e) => { if (running) analyze(e.data, performance.now()); };
      tap.connect(silent);
    } catch {
      tap = null; // no worklet support: poll the analyser instead
    }
  }
  await ctx.resume();
  detach();
  const device = $('sg-device').value;
  if (device === 'demo') {
    // Test voice: a triangle wave that sings the written melody (to try singing mode
    // without a microphone). It is quietly audible too.
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const out = ctx.createGain();
    out.gain.value = 0.25;
    osc.connect(gain);
    gain.connect(analyser);
    if (tap) gain.connect(tap);
    gain.connect(out).connect(ctx.destination);
    osc.start();
    demo = { osc, gain, detune: 0 };
    source = gain;
  } else {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: device ? { exact: device } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        latency: 0, channelCount: { ideal: 1 },
      },
      video: false,
    });
    source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    if (tap) source.connect(tap);
    listDevices(); // labels appear once access is granted
  }
  running = true;
  lastAnalysis = performance.now();
  showRunning();
  clearInterval(poll);
  if (!tap) poll = setInterval(() => { analyser.getFloatTimeDomainData(buf); analyze(buf, performance.now()); }, 21);
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(draw);
}

function stop() {
  running = false;
  detach();
  cancelAnimationFrame(raf);
  clearInterval(poll);
  ctx?.suspend();
  showRunning();
}

async function listDevices() {
  const select = $('sg-device');
  const keep = select.value;
  let inputs = [];
  try { inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch { /* no permission API */ }
  select.innerHTML = '';
  select.add(new Option('Default microphone', ''));
  inputs.filter((d) => d.deviceId && d.deviceId !== 'default').forEach((d, i) => select.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
  select.add(new Option('Test voice (sings the melody, no mic)', 'demo'));
  let saved = keep;
  try { saved = keep || localStorage.getItem('fretboard-sing-device') || ''; } catch { /* ignore */ }
  select.value = [...select.options].some((o) => o.value === saved) ? saved : '';
}

/* ---------- the live loop ---------- */

const buf = new Float32Array(2048);

// One analysis step (~every 21 ms): what is sung, what is written, and the score.
function analyze(frame, now) {
  const dt = Math.min(100, now - lastAnalysis);
  lastAnalysis = now;

  const est = hooks.isPlaying?.() ? estimatedTick(now) : null;
  const tick = est === null ? null : est - latencyMs() * pos.rate;
  const note = tick === null ? null : noteAt(hooks.getMelody?.() || [], tick);

  if (demo) {
    const target = note ? midiToHz(note.midi) * 2 ** (demo.detune / 1200) : null;
    if (target) demo.osc.frequency.setTargetAtTime(target, ctx.currentTime, 0.01);
    demo.gain.gain.setTargetAtTime(target ? 0.4 : 0, ctx.currentTime, 0.015);
  }

  let peak = 0;
  for (let i = 0; i < frame.length; i++) peak = Math.max(peak, Math.abs(frame[i]));
  const p = detectPitch(frame, ctx.sampleRate);
  recent.push(p ? hzToMidi(p.hz) : null);
  if (recent.length > 3) recent.shift();
  const voiced = recent.filter((x) => x !== null).sort((a, b) => a - b);
  const sung = voiced.length >= 2 ? voiced[voiced.length >> 1] : null;

  let status = null;
  let cents = null;
  if (note) {
    scorer.add({
      note, sung, dt,
      sinceOnsetMs: (tick - note.start) / pos.rate,
      noteMs: (note.end - note.start) / pos.rate,
    });
    if (sung !== null) ({ cents, status } = judge(sung, note.midi));
    else status = 'silent';
  }
  trace.push({ t: now, cents, status, note: !!note });
  while (trace.length && now - trace[0].t > 4000) trace.shift();
  live = { note, sung, cents, status, peak: Math.max(peak, live.peak * 0.9) };
}

function draw() {
  if (!running) return;
  raf = requestAnimationFrame(draw);
  showLive(live);
}

/* ---------- readouts ---------- */

const STATUS_TEXT = { in: 'On pitch', flat: 'Flat', sharp: 'Sharp', silent: 'Sing!' };

function showLive({ note, sung, cents, status, peak }) {
  $('sg-note').textContent = note ? midiName(note.midi) : '–';
  const state = $('sg-state');
  const text = status && status !== 'silent' && cents !== null
    ? (status === 'in' ? STATUS_TEXT.in : `${STATUS_TEXT[status]} ${Math.abs(Math.round(cents))}¢`)
    : note ? STATUS_TEXT.silent : '';
  if (state.textContent !== text) state.textContent = text;
  $('sg-live').dataset.status = note ? status || 'silent' : '';
  drawLane();

  // Sheet: input level and the pitch heard.
  const db = peak > 0 ? 20 * Math.log10(peak) : -100;
  $('sg-meter-bar').style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + '%';
  $('sg-heard').textContent = sung !== null ? `Hearing ${midiName(sung)} (${Math.round(midiToHz(sung))} Hz)` : 'Hearing: —';
  const s = scorer.summary();
  $('sg-running').textContent = s.notes ? `So far: ${s.score}% in tune` : '';
}

function drawLane() {
  const canvas = $('sg-lane');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const range = 150; // cents from the middle to the top/bottom edge
  const y = (c) => h / 2 - (Math.max(-range, Math.min(range, c)) / range) * (h / 2 - 2);
  // The in-tune band and the target line.
  g.fillStyle = 'rgba(92, 201, 138, 0.16)';
  g.fillRect(0, y(TOLERANCE), w, y(-TOLERANCE) - y(TOLERANCE));
  g.fillStyle = 'rgba(154, 160, 171, 0.5)';
  g.fillRect(0, Math.round(h / 2), w, 1);
  const now = performance.now();
  const colors = { in: '#5cc98a', flat: '#f2a541', sharp: '#e86a5a' };
  for (const p of trace) {
    if (!p.note) continue;
    const x = w - ((now - p.t) / 4000) * w;
    if (p.cents === null) {
      g.fillStyle = 'rgba(154, 160, 171, 0.35)';
      g.fillRect(x, h / 2 - 1, 2, 2);
    } else {
      g.fillStyle = colors[p.status] || '#9aa0ab';
      g.fillRect(x - 1, y(p.cents) - 1.5, 3, 3);
    }
  }
}

function showRunning() {
  $('sg-go').textContent = running ? 'Stop singing mode' : 'Start singing mode';
  $('sg-go').classList.toggle('danger', running);
  $('sg-live').hidden = !running;
  $('sg-state-pill').textContent = running ? (demo ? 'On · test voice' : 'On') : '';
  document.querySelector('[data-sheet-btn=sing]')?.classList.toggle('live', running);
  if (!running) {
    $('sg-meter-bar').style.width = '0';
    $('sg-heard').textContent = 'Hearing: —';
  }
  hooks.vocalMuteChanged?.();
}

function showTrack() {
  const info = hooks.trackInfo?.() || {};
  const notes = (hooks.getMelody?.() || []).length;
  let text;
  if (!info.name) text = 'Open a song to sing along.';
  else if (!notes) text = `“${info.name}” has no notes to sing. Pick the vocal track in the track list.`;
  else if (info.vocal) text = `Singing along with “${info.name}” (${notes} notes).`;
  else text = `“${info.name}” doesn’t look like a vocal track; you can still sing its melody, or pick the vocal track in the track list.`;
  $('sg-track').textContent = text;
  const other = info.vocal ? -1 : hooks.findVocalTrack?.() ?? -1;
  $('sg-pick').hidden = other < 0;
  $('sg-pick').dataset.track = other;
}

function showResults() {
  const box = $('sg-result');
  if (!results.length) { box.hidden = true; return; }
  box.hidden = false;
  const [last] = results;
  $('sg-score').textContent = last.score + '%';
  $('sg-score-label').textContent = last.kind === 'loop' ? 'last loop in tune' : 'of the song in tune';
  $('sg-breakdown').textContent = describe(last);
  $('sg-history').textContent = results.length > 1 ? 'Before: ' + results.slice(1).map((r) => r.score + '%').join(', ') : '';
}

// A song or a loop ended (or playback was stopped): keep its score and start a new one.
function finish(kind) {
  const s = scorer.summary();
  scorer.reset();
  if (s.seconds < 1.5) return; // nothing much was sung against
  results.unshift({ ...s, kind });
  results.length = Math.min(results.length, 6);
  showResults();
  $('sg-last').textContent = `${s.score}%`;
  $('sg-last').hidden = false;
  if (kind === 'song') hooks.showSheet?.('sing');
}

/* ---------- public (called by the player) ---------- */

export function singFinished(looping) {
  if (running) finish(looping ? 'loop' : 'song');
}

export function singStopped() {
  if (running) finish('song');
}

export function singSongChanged() {
  scorer.reset();
  results.length = 0;
  $('sg-last').hidden = true;
  showResults();
  showTrack();
}

export const singWantsVocalMuted = () => running && $('sg-mute').checked;

export function initSing(playerHooks = {}) {
  hooks = playerHooks;
  $('sg-device').add(new Option('Default microphone', ''));
  let listed = false;
  document.querySelector('[data-sheet-btn=sing]').addEventListener('click', () => {
    showTrack();
    if (listed) return;
    listed = true;
    listDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
  });
  $('sg-go').addEventListener('click', async () => {
    if (running) { stop(); return; }
    $('sg-error').textContent = '';
    try {
      await start();
    } catch (e) {
      running = false;
      showRunning();
      $('sg-error').textContent = e?.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow it in the address bar, then try again.'
        : 'Could not start the microphone: ' + (e?.message || e);
    }
  });
  $('sg-device').addEventListener('change', () => {
    try { localStorage.setItem('fretboard-sing-device', $('sg-device').value); } catch { /* ignore */ }
    if (running) start().catch((e) => { $('sg-error').textContent = 'Could not switch input: ' + (e?.message || e); });
  });
  const mute = $('sg-mute');
  try { mute.checked = localStorage.getItem('fretboard-sing-mute') === '1'; } catch { /* ignore */ }
  mute.addEventListener('change', () => {
    try { localStorage.setItem('fretboard-sing-mute', mute.checked ? '1' : '0'); } catch { /* ignore */ }
    hooks.vocalMuteChanged?.();
  });
  $('sg-pick').addEventListener('click', () => hooks.selectTrack?.(Number($('sg-pick').dataset.track)));
  $('sg-reset').addEventListener('click', () => { results.length = 0; scorer.reset(); $('sg-last').hidden = true; showResults(); });
  $('sg-live').addEventListener('click', () => document.querySelector('[data-sheet-btn=sing]').click());
}

export const singTrackChanged = () => { scorer.reset(); showTrack(); };

// Debug/verification hook (browser console): window.fretboardSing.
window.fretboardSing = {
  get ctx() { return ctx; }, get running() { return running; }, get results() { return results; },
  get pos() { return pos; }, summary: () => scorer.summary(), start, stop,
  setTestDetune(c) { if (demo) demo.detune = c; },
};
