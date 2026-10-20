// Practice mode: play the shown track (guitar, bass, keys…) along with the song through a
// microphone or an audio interface, and every note or chord is judged as you go: hit,
// wrong or missed. Single notes are checked by pitch (YIN), chords by which of the 12 notes
// sound (a chroma profile of the spectrum); see judgecore.js. Each song or loop ends with a
// score: the share of notes and chords hit.
import { detectPitch, hzToMidi, midiToHz, midiName } from './singcore.js';
import { matchFrame, chromaFromSpectrum, createJudge, describeJudge, targetLabel } from './judgecore.js';

const $ = (id) => document.getElementById(id);

let hooks = {};
let ctx = null;
let analyser = null;
let stream = null;
let source = null;
let demo = null; // { voices: [{ osc, gain }], out } — the test player that plays the part
let running = false;
let poll = 0;
let targets = [];

const judge = createJudge();
const results = []; // last few finished songs/loops
const recent = []; // last verdicts, newest last: { verdict, label }
let time = null; // Float32Array for the waveform
let spec = null; // Float32Array for the spectrum
let heardText = '';
let peak = 0;

// Where the song is, measured from alphaTab's position reports (as in singing mode).
const pos = { tick: 0, at: 0, rate: 1.6, advancedAt: 0, anchorTick: 0, anchorAt: 0 };

export function judgePosition(e) {
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
    if (r > 0) pos.rate += (r - pos.rate) * 0.5;
    pos.anchorTick = tick;
    pos.anchorAt = now;
  }
  pos.tick = tick;
  pos.at = now;
}

function estimatedTick(now) {
  if (now - pos.advancedAt > 300) return null; // paused or counting in
  return pos.tick + Math.min(now - pos.at, 200) * pos.rate;
}

// You play to what you hear: the song's output latency, the input latency and half the
// analysis window pass before your note reaches the analysis.
function latencyMs() {
  if (demo) return 0;
  const input = stream?.getAudioTracks()[0]?.getSettings?.().latency || 0;
  return (ctx.baseLatency || 0) * 1000 + input * 1000 + (2048 / ctx.sampleRate) * 500 + 40;
}

/* ---------- input ---------- */

function detach() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  try { source?.disconnect(); } catch { /* gone */ }
  source = null;
  if (demo) {
    for (const v of demo.voices) try { v.osc.stop(); } catch { /* gone */ }
    try { demo.out.disconnect(); } catch { /* gone */ }
    demo = null;
  }
}

async function start() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0;
    const silent = ctx.createGain();
    silent.gain.value = 0;
    analyser.connect(silent).connect(ctx.destination); // keeps the analyser running
    time = new Float32Array(analyser.fftSize);
    spec = new Float32Array(analyser.frequencyBinCount);
  }
  await ctx.resume();
  detach();
  const device = $('pj-device').value;
  if (device === 'demo') {
    // Test player: plays the written notes (to try practice mode without an instrument).
    const out = ctx.createGain();
    out.gain.value = 0.15;
    out.connect(ctx.destination);
    const voices = [];
    for (let i = 0; i < 6; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(analyser);
      gain.connect(out);
      osc.start();
      voices.push({ osc, gain });
    }
    demo = { voices, out, wrong: 0 };
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
    listDevices();
  }
  running = true;
  judge.reset();
  refreshTargets();
  showRunning();
  clearInterval(poll);
  poll = setInterval(step, 20);
}

function stop() {
  running = false;
  clearInterval(poll);
  detach();
  ctx?.suspend();
  showRunning();
}

async function listDevices() {
  const select = $('pj-device');
  const keep = select.value;
  let inputs = [];
  try { inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch { /* no permission API */ }
  select.innerHTML = '';
  select.add(new Option('Default input', ''));
  inputs.filter((d) => d.deviceId && d.deviceId !== 'default').forEach((d, i) => select.add(new Option(d.label || `Input ${i + 1}`, d.deviceId)));
  select.add(new Option('Test player (plays the part, no instrument)', 'demo'));
  let saved = keep;
  try { saved = keep || localStorage.getItem('fretboard-judge-device') || ''; } catch { /* ignore */ }
  select.value = [...select.options].some((o) => o.value === saved) ? saved : '';
}

/* ---------- the live loop ---------- */

// The written moment sounding at a tick (for the test player).
function eventAt(tick) {
  let lo = 0, hi = targets.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (targets[mid].start <= tick) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const ev = targets[found];
  return ev && tick < ev.end ? ev : null;
}

function playDemo(tick) {
  const ev = tick === null ? null : eventAt(tick);
  const shift = demo.wrong ? demo.wrong : 0; // setTestWrong(n): play n semitones off
  demo.voices.forEach((v, i) => {
    const midi = ev?.midis[i];
    if (midi != null) v.osc.frequency.setTargetAtTime(midiToHz(midi + shift), ctx.currentTime, 0.005);
    v.gain.gain.setTargetAtTime(midi != null ? 0.5 / Math.max(1, ev.midis.length) : 0, ctx.currentTime, 0.01);
  });
}

function step() {
  if (!running) return;
  const now = performance.now();
  const playing = !!hooks.isPlaying?.();
  const est = playing ? estimatedTick(now) : null;
  if (demo) playDemo(est);
  const tick = est === null ? null : est - latencyMs() * pos.rate;

  analyser.getFloatTimeDomainData(time);
  analyser.getFloatFrequencyData(spec);
  // Low parts (bass) need a longer window to find their pitch.
  const low = targets.length && targets.some((ev) => ev.midis[0] < 45);
  const frame = time.subarray(time.length - (low ? 4096 : 2048));
  let sum = 0;
  let p = 0;
  for (let i = 0; i < frame.length; i++) { sum += frame[i] * frame[i]; p = Math.max(p, Math.abs(frame[i])); }
  const rms = Math.sqrt(sum / frame.length);
  peak = Math.max(p, peak * 0.9);
  const loud = rms > Number($('pj-gate').value || 0.006);
  const pitch = loud ? detectPitch(frame, ctx.sampleRate, { minHz: low ? 38 : 70, maxHz: 1400 }) : null;
  const midi = pitch && pitch.clarity > 0.75 ? hzToMidi(pitch.hz) : null;
  const ch = loud ? chromaFromSpectrum(spec, ctx.sampleRate) : null;
  const heard = { loud, midi, chroma: ch?.chroma || null };
  const several = ch && ch.chroma.filter((v) => v >= Math.max(...ch.chroma) * 0.35).length > 1;
  heardText = !loud ? '' : midi !== null && !several ? midiName(midi) : ch ? topNotes(ch.chroma) : '';

  if (tick !== null && targets.length) {
    const done = judge.frame(tick, 1 / pos.rate, (ev) => matchFrame(heard, ev));
    for (const d of done) recent.push({ verdict: d.verdict, label: targetLabel(d.ev) });
    while (recent.length > 16) recent.shift();
  }
  showLive(tick);
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function topNotes(chroma) {
  const max = Math.max(...chroma);
  return chroma.map((v, i) => [v, i]).filter(([v]) => v >= max * 0.35).sort((a, b) => b[0] - a[0]).slice(0, 4).map(([, i]) => NAMES[i]).join(' ');
}

/* ---------- readouts ---------- */

const VERDICT_TEXT = { hit: '✓ Hit', wrong: '✗ Wrong', missed: '○ Missed' };

function showLive(tick) {
  const ev = tick === null ? null : judge.current();
  $('pj-target').textContent = ev ? targetLabel(ev) : '–';
  const last = recent[recent.length - 1];
  const verdict = $('pj-verdict');
  const text = last ? VERDICT_TEXT[last.verdict] + (last.verdict === 'hit' ? '' : ` ${last.label}`) : tick === null ? 'Press Play' : 'Play!';
  if (verdict.textContent !== text) verdict.textContent = text;
  $('pj-live').dataset.verdict = last?.verdict || '';
  const s = judge.summary();
  $('pj-streak').textContent = s.streak > 2 ? `${s.streak} in a row` : '';
  $('pj-streak').hidden = s.streak <= 2;
  const dots = recent.slice(-10).map((r) => r.verdict[0]).join('');
  if ($('pj-dots').dataset.v !== dots) {
    $('pj-dots').dataset.v = dots;
    $('pj-dots').innerHTML = recent.slice(-10).map((r) => `<i class="${r.verdict}" title="${r.label}: ${r.verdict}"></i>`).join('');
  }
  // Sheet: input level, what's heard, the running score.
  const db = peak > 0 ? 20 * Math.log10(peak) : -100;
  $('pj-meter-bar').style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + '%';
  $('pj-heard').textContent = heardText ? `Hearing ${heardText}` : 'Hearing: —';
  $('pj-running').textContent = s.total ? `So far: ${s.hit}/${s.total} hit (${s.score}%)` : '';
}

function showRunning() {
  $('pj-go').textContent = running ? 'Stop practice mode' : 'Start practice mode';
  $('pj-go').classList.toggle('danger', running);
  $('pj-live').hidden = !running;
  $('pj-state-pill').textContent = running ? (demo ? 'On · test player' : 'On') : '';
  document.querySelector('[data-sheet-btn=judge]')?.classList.toggle('live', running);
  if (!running) {
    $('pj-meter-bar').style.width = '0';
    $('pj-heard').textContent = 'Hearing: —';
    recent.length = 0;
  }
  hooks.trackMuteChanged?.();
}

function refreshTargets() {
  targets = hooks.getTargets?.() || [];
  judge.setEvents(targets);
}

function showTrack() {
  refreshTargets();
  const info = hooks.trackInfo?.() || {};
  let text;
  if (!info.name) text = 'Open a song to practise it.';
  else if (info.drums) text = `“${info.name}” is a drum track; practice mode judges pitched parts. Pick another track in the track list.`;
  else if (!targets.length) text = `“${info.name}” has no notes to play.`;
  else text = `Judging “${info.name}”: ${targets.length} notes and chords. Pick another track in the track list to practise that part.`;
  $('pj-track').textContent = text;
}

function showResults() {
  const box = $('pj-result');
  if (!results.length) { box.hidden = true; return; }
  box.hidden = false;
  const [last] = results;
  $('pj-score').textContent = last.score + '%';
  $('pj-score-label').textContent = last.kind === 'loop' ? 'of the last loop hit' : 'of the song hit';
  $('pj-breakdown').textContent = describeJudge(last);
  $('pj-history').textContent = results.length > 1 ? 'Before: ' + results.slice(1).map((r) => r.score + '%').join(', ') : '';
}

function finish(kind) {
  judge.flush();
  const s = judge.summary();
  judge.reset();
  if (s.total < 3) return; // hardly anything was played against
  results.unshift({ ...s, kind });
  results.length = Math.min(results.length, 6);
  showResults();
  if (kind === 'song') hooks.showSheet?.('judge');
}

/* ---------- public (called by the player) ---------- */

export function judgeFinished(looping) { if (running) finish(looping ? 'loop' : 'song'); }
export function judgeStopped() { if (running) finish('song'); }
export function judgeSongChanged() {
  judge.reset();
  results.length = 0;
  recent.length = 0;
  showResults();
  showTrack();
}
export const judgeTrackChanged = () => { judge.reset(); recent.length = 0; showTrack(); };
export const judgeWantsTrackMuted = () => running && $('pj-mute').checked;

export function initJudge(playerHooks = {}) {
  hooks = playerHooks;
  $('pj-device').add(new Option('Default input', ''));
  let listed = false;
  document.querySelector('[data-sheet-btn=judge]').addEventListener('click', () => {
    showTrack();
    if (listed) return;
    listed = true;
    listDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
  });
  $('pj-go').addEventListener('click', async () => {
    if (running) { stop(); return; }
    $('pj-error').textContent = '';
    try {
      await start();
    } catch (e) {
      running = false;
      showRunning();
      $('pj-error').textContent = e?.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow it in the address bar, then try again.'
        : 'Could not start the input: ' + (e?.message || e);
    }
  });
  $('pj-device').addEventListener('change', () => {
    try { localStorage.setItem('fretboard-judge-device', $('pj-device').value); } catch { /* ignore */ }
    if (running) start().catch((e) => { $('pj-error').textContent = 'Could not switch input: ' + (e?.message || e); });
  });
  const mute = $('pj-mute');
  try { mute.checked = localStorage.getItem('fretboard-judge-mute') !== '0'; } catch { /* ignore */ }
  mute.addEventListener('change', () => {
    try { localStorage.setItem('fretboard-judge-mute', mute.checked ? '1' : '0'); } catch { /* ignore */ }
    hooks.trackMuteChanged?.();
  });
  const gate = $('pj-gate');
  try { gate.value = localStorage.getItem('fretboard-judge-gate') || gate.value; } catch { /* ignore */ }
  gate.addEventListener('change', () => { try { localStorage.setItem('fretboard-judge-gate', gate.value); } catch { /* ignore */ } });
  $('pj-reset').addEventListener('click', () => { results.length = 0; judge.reset(); showResults(); });
  $('pj-live').addEventListener('click', () => document.querySelector('[data-sheet-btn=judge]').click());
}

// Debug/verification hook (browser console): window.fretboardJudge.
window.fretboardJudge = {
  get running() { return running; }, get results() { return results; }, get recent() { return recent; },
  get targets() { return targets; }, summary: () => judge.summary(), start, stop,
  setTestWrong(n) { if (demo) demo.wrong = n; },
};
