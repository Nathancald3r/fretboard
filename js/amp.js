// "Plug in" amp simulator: your electric guitar (through an audio interface) runs
// through a gate, drive, tone stack, generated speaker cabinet, delay and reverb, and
// plays alongside the song. Presets are stored in IndexedDB and can be attached to a song.
import { getValue, setValue, updateSong } from './db.js';
import {
  CHARACTERS, CABINETS, PARAMS, BUILT_IN_PRESETS, normalizeSettings,
  makeCurve, driveGains, makeCabinetIR, makeReverbIR, dbToGain,
} from './ampdsp.js';

const $ = (id) => document.getElementById(id);
const SMOOTH = 0.02;

let ctx = null;
let graph = null;
let stream = null;
let source = null; // MediaStreamAudioSourceNode or the demo riff's output
let demo = null;
let running = false;
let meterRaf = 0;

let userPresets = [];
let presetId = BUILT_IN_PRESETS[0].id;
let settings = normalizeSettings(BUILT_IN_PRESETS[0].settings);
let dirty = false;
let song = null;
let hooks = {};

const allPresets = () => [...BUILT_IN_PRESETS, ...userPresets];
const findPreset = (id) => allPresets().find((p) => p.id === id);

/* ---------- audio graph ---------- */

async function ensureGraph() {
  if (graph) return graph;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  const g = {};
  const node = (fn, props = {}) => Object.assign(fn(), props);
  const filter = (type, freq, q = 0.7) => {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    return f;
  };

  // Interfaces usually show up as stereo with the guitar on input 1 (left) only; pick one
  // channel (or both) and turn it into mono.
  g.splitter = ctx.createChannelSplitter(2);
  g.left = ctx.createGain();
  g.right = ctx.createGain();
  g.mono = node(() => ctx.createGain(), { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  g.splitter.connect(g.left, 0);
  g.splitter.connect(g.right, 1);
  g.left.connect(g.mono);
  g.right.connect(g.mono);

  g.input = ctx.createGain();
  g.meter = node(() => ctx.createAnalyser(), { fftSize: 1024 });
  g.mono.connect(g.input);
  g.input.connect(g.meter);

  try {
    await ctx.audioWorklet.addModule(new URL('./amp-gate.js', import.meta.url));
    g.gate = new AudioWorkletNode(ctx, 'fretboard-gate', { channelCount: 1, channelCountMode: 'explicit' });
  } catch {
    g.gate = ctx.createGain(); // no worklet support: no gate, everything else still works
  }

  g.preHP = filter('highpass', 80);
  g.preMid = filter('peaking', 720, 0.9);
  g.drive = ctx.createGain();
  g.shaper = node(() => ctx.createWaveShaper(), { oversample: '4x' });
  g.dcBlock = filter('highpass', 25);
  g.post = ctx.createGain();
  g.bass = filter('lowshelf', 120);
  g.mid = filter('peaking', 700, 0.8);
  g.treble = filter('highshelf', 3200);
  g.presence = filter('peaking', 5000, 0.9);
  g.cab = node(() => ctx.createConvolver(), { normalize: false });
  g.cabWet = ctx.createGain();
  g.cabDry = ctx.createGain();
  g.fx = ctx.createGain();

  g.input.connect(g.gate).connect(g.preHP).connect(g.preMid).connect(g.drive).connect(g.shaper)
    .connect(g.dcBlock).connect(g.post).connect(g.bass).connect(g.mid).connect(g.treble).connect(g.presence);
  g.presence.connect(g.cab).connect(g.cabWet).connect(g.fx);
  g.presence.connect(g.cabDry).connect(g.fx);

  g.master = ctx.createGain();
  g.fx.connect(g.master);
  // Delay with darker repeats, and a generated room reverb.
  g.delaySend = ctx.createGain();
  g.delay = ctx.createDelay(1.5);
  g.delayTone = filter('lowpass', 3000);
  g.feedback = ctx.createGain();
  g.fx.connect(g.delaySend).connect(g.delay).connect(g.delayTone).connect(g.feedback).connect(g.delay);
  g.delayTone.connect(g.master);
  g.reverbSend = ctx.createGain();
  g.reverb = node(() => ctx.createConvolver(), { normalize: false });
  const [l, r] = makeReverbIR(ctx.sampleRate);
  const rev = ctx.createBuffer(2, l.length, ctx.sampleRate);
  rev.copyToChannel(l, 0); rev.copyToChannel(r, 1);
  g.reverb.buffer = rev;
  g.fx.connect(g.reverbSend).connect(g.reverb).connect(g.master);

  // Safety limiter so a feedback squeal or a hot input can't blast your ears.
  g.limiter = ctx.createDynamicsCompressor();
  g.limiter.threshold.value = -3; g.limiter.knee.value = 0; g.limiter.ratio.value = 20;
  g.limiter.attack.value = 0.001; g.limiter.release.value = 0.1;
  g.out = ctx.createGain();
  g.master.connect(g.limiter).connect(g.out).connect(ctx.destination);

  g.cabCache = {};
  g.curveFor = null;
  graph = g;
  applySettings(true);
  applyChannel();
  return g;
}

function applySettings(immediate = false) {
  if (!graph) return;
  const g = graph;
  const s = settings;
  const t = ctx.currentTime;
  const set = (param, v) => (immediate ? (param.value = v) : param.setTargetAtTime(v, t, SMOOTH));
  const ch = CHARACTERS[s.character];

  set(g.input.gain, dbToGain(s.input));
  if (g.gate.parameters) set(g.gate.parameters.get('threshold'), s.gate);
  set(g.preHP.frequency, ch.preHP);
  set(g.preMid.gain, ch.preMid);
  if (g.curveFor !== s.character) { g.shaper.curve = makeCurve(s.character); g.curveFor = s.character; }
  const { pre, post } = driveGains(s.character, s.drive);
  set(g.drive.gain, pre);
  set(g.post.gain, post);
  set(g.bass.gain, s.bass);
  set(g.mid.gain, s.mid);
  set(g.treble.gain, s.treble);
  set(g.presence.gain, s.presence);

  if (s.cabinet !== 'off') {
    if (!g.cabCache[s.cabinet]) {
      const ir = makeCabinetIR(s.cabinet, ctx.sampleRate);
      const buf = ctx.createBuffer(1, ir.length, ctx.sampleRate);
      buf.copyToChannel(ir, 0);
      g.cabCache[s.cabinet] = buf;
    }
    if (g.cab.buffer !== g.cabCache[s.cabinet]) g.cab.buffer = g.cabCache[s.cabinet];
  }
  set(g.cabWet.gain, s.cabinet === 'off' ? 0 : 1);
  // Without a cabinet the raw clipper is harsh; tame it a little.
  set(g.cabDry.gain, s.cabinet === 'off' ? 0.5 : 0);

  set(g.delaySend.gain, s.delayMix);
  set(g.delay.delayTime, s.delayTime / 1000);
  set(g.feedback.gain, s.delayFeedback);
  set(g.reverbSend.gain, s.reverb * 0.8);
  set(g.master.gain, dbToGain(s.master));
}

function applyChannel() {
  if (!graph) return;
  const ch = $('amp-channel').value;
  graph.left.gain.value = ch === 'right' ? 0 : ch === 'mix' ? 0.5 : 1;
  graph.right.gain.value = ch === 'left' ? 0 : ch === 'mix' ? 0.5 : 1;
}

/* ---------- inputs ---------- */

function detachSource() {
  stopDemo();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  try { source?.disconnect(); } catch { /* already gone */ }
  source = null;
}

async function start() {
  const g = await ensureGraph();
  await ctx.resume();
  detachSource();
  const device = $('amp-device').value;
  if (device === 'demo') {
    source = startDemo();
  } else {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: device ? { exact: device } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        latency: 0, channelCount: { ideal: 2 },
      },
    });
    source = ctx.createMediaStreamSource(stream);
    listDevices(); // labels only become available after permission is granted
  }
  source.connect(g.splitter);
  running = true;
  showRunning();
  meterLoop();
  setTimeout(showLatency, 400); // outputLatency settles once audio is flowing
  showLatency();
}

function stop() {
  running = false;
  detachSource();
  cancelAnimationFrame(meterRaf);
  ctx?.suspend();
  showRunning();
}

async function listDevices() {
  const select = $('amp-device');
  const keep = select.value;
  let inputs = [];
  try { inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch { /* no permission API */ }
  select.innerHTML = '';
  select.add(new Option('Default input', ''));
  inputs.filter((d) => d.deviceId && d.deviceId !== 'default').forEach((d, i) => select.add(new Option(d.label || `Input ${i + 1}`, d.deviceId)));
  select.add(new Option('Demo riff (no guitar — preview tones)', 'demo'));
  const saved = keep || localStorage.getItem('fretboard-amp-device') || '';
  select.value = [...select.options].some((o) => o.value === saved) ? saved : '';
}

// A synthesized "DI guitar" riff so tones can be heard without a guitar plugged in.
const RIFF = [[40, 1], [40, 0.5], [40, 0.5], [43, 1], [45, 1], [40, 0.5], [40, 0.5], [47, 0.5], [45, 0.5], [43, 1], [40, 1]];

function startDemo() {
  const out = ctx.createGain();
  out.gain.value = 0.5;
  const beat = 60 / 120;
  let next = ctx.currentTime + 0.1;
  let step = 0;
  const pluck = (midi, when, len) => {
    const f = 440 * 2 ** ((midi - 69) / 12);
    const env = ctx.createGain();
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(4000, when);
    tone.frequency.exponentialRampToValueAtTime(600, when + len);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(0.6, when + 0.004);
    env.gain.exponentialRampToValueAtTime(0.02, when + len);
    env.gain.linearRampToValueAtTime(0, when + len + 0.03);
    tone.connect(env).connect(out);
    for (const m of [1, 1.4983]) { // root + fifth: a power chord
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f * m;
      o.connect(tone);
      o.start(when);
      o.stop(when + len + 0.05);
    }
  };
  const tick = () => {
    while (next < ctx.currentTime + 0.3) {
      const [midi, beats] = RIFF[step % RIFF.length];
      pluck(midi, next, beats * beat * 0.92);
      next += beats * beat;
      step++;
    }
  };
  tick();
  demo = { timer: setInterval(tick, 100), out };
  return out;
}

function stopDemo() {
  if (!demo) return;
  clearInterval(demo.timer);
  demo.out.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
  const { out } = demo;
  setTimeout(() => out.disconnect(), 200);
  demo = null;
}

/* ---------- readouts ---------- */

function showLatency() {
  if (!ctx || !running) { $('amp-latency').textContent = ''; return; }
  const inputLatency = stream?.getAudioTracks()[0]?.getSettings?.().latency || 0;
  const out = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
  const total = Math.round((out + inputLatency) * 1000);
  $('amp-latency').textContent = `Latency ≈ ${total} ms (output ${Math.round(out * 1000)} ms${inputLatency ? `, input ${Math.round(inputLatency * 1000)} ms` : ''})`
    + (total > 25 ? ' — high; an audio interface with ASIO/low-latency drivers helps' : '');
}

function meterLoop() {
  const buf = new Float32Array(graph.meter.fftSize);
  let hold = 0;
  const draw = () => {
    if (!running) return;
    graph.meter.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    const db = peak > 0 ? 20 * Math.log10(peak) : -100;
    hold = Math.max(db, hold - 0.6);
    const pct = Math.max(0, Math.min(100, ((hold + 60) / 60) * 100));
    const bar = $('amp-meter-bar');
    bar.style.width = pct + '%';
    bar.className = 'amp-meter-bar' + (hold > -1 ? ' clip' : hold > -12 ? ' hot' : '');
    $('amp-meter-db').textContent = hold <= -60 ? '—' : `${Math.round(hold)} dB` + (hold > -1 ? ' clipping: lower Input' : '');
    meterRaf = requestAnimationFrame(draw);
  };
  draw();
}

function showRunning() {
  $('amp-go').textContent = running ? 'Turn amp off' : 'Turn amp on';
  $('amp-go').classList.toggle('danger', running);
  $('amp-state').textContent = running ? (demo ? 'On · demo riff' : 'On') : '';
  $('amp-top').hidden = !running;
  document.querySelector('[data-sheet-btn=amp]')?.classList.toggle('live', running);
  if (!running) {
    $('amp-meter-bar').style.width = '0';
    $('amp-meter-db').textContent = '—';
    showLatency();
  }
}

/* ---------- presets ---------- */

function renderPresets() {
  const select = $('amp-preset');
  select.innerHTML = '';
  const group = (label, list) => {
    if (!list.length) return;
    const og = document.createElement('optgroup');
    og.label = label;
    list.forEach((p) => og.append(new Option(p.name, p.id)));
    select.append(og);
  };
  group('Built-in tones', BUILT_IN_PRESETS);
  group('Your tones', userPresets);
  select.value = presetId;
  const p = findPreset(presetId);
  $('amp-dirty').textContent = dirty ? 'edited' : '';
  $('amp-save').disabled = !p || p.builtIn || !dirty;
  $('amp-rename').disabled = !p || p.builtIn;
  $('amp-delete').disabled = !p || p.builtIn;
  renderSongLink();
}

function renderSongLink() {
  const box = $('amp-song');
  box.disabled = !song;
  box.checked = !!song && song.ampPreset === presetId;
  $('amp-song-label').textContent = song ? `Load this tone when “${song.title}” opens` : 'Load this tone with the song';
}

function renderControls() {
  $('amp-character').value = settings.character;
  $('amp-cabinet').value = settings.cabinet;
  for (const p of PARAMS) {
    $('amp-' + p.key).value = settings[p.key];
    $('amp-' + p.key + '-val').textContent = formatValue(p, settings[p.key]);
  }
}

function formatValue(p, v) {
  if (p.key === 'gate' && v <= -96) return 'off';
  if (p.unit === 'dB') return `${v > 0 ? '+' : ''}${v} dB`;
  if (p.unit === '%') return Math.round(v * 100) + '%';
  if (p.unit === 'ms') return v + ' ms';
  return Number(v).toFixed(1);
}

function loadPreset(id) {
  const p = findPreset(id);
  if (!p) return false;
  presetId = id;
  settings = normalizeSettings(p.settings);
  dirty = false;
  applySettings();
  renderControls();
  renderPresets();
  saveState();
  return true;
}

let saveTimer = 0;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => setValue('ampState', { presetId, settings, dirty }).catch(() => {}), 400);
}
const saveUserPresets = () => setValue('ampPresets', userPresets);

// Small in-panel dialog for naming and confirming (the app's own dialog is for songs).
function askName({ title, value = '', ok = 'Save', confirmOnly = false }) {
  const dialog = $('amp-dialog');
  $('amp-dialog-title').textContent = title;
  $('amp-dialog-name').hidden = confirmOnly;
  $('amp-dialog-name').value = value;
  $('amp-dialog-ok').textContent = ok;
  $('amp-dialog-ok').classList.toggle('danger', confirmOnly);
  dialog.returnValue = '';
  dialog.showModal();
  (confirmOnly ? $('amp-dialog-ok') : $('amp-dialog-name')).focus();
  return new Promise((resolve) => dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'ok') resolve(null);
    else resolve(confirmOnly ? true : $('amp-dialog-name').value.trim() || null);
  }, { once: true }));
}

async function saveAs() {
  const base = findPreset(presetId)?.name || 'My tone';
  const name = await askName({ title: 'Save tone as', value: dirty ? `${base} (mine)` : base });
  if (!name) return;
  const p = { id: 'u:' + Date.now().toString(36), name, settings: { ...settings } };
  userPresets.push(p);
  await saveUserPresets();
  presetId = p.id;
  dirty = false;
  renderPresets();
  saveState();
}

async function overwrite() {
  const p = findPreset(presetId);
  if (!p || p.builtIn) return;
  p.settings = { ...settings };
  await saveUserPresets();
  dirty = false;
  renderPresets();
  saveState();
}

async function rename() {
  const p = findPreset(presetId);
  if (!p || p.builtIn) return;
  const name = await askName({ title: 'Rename tone', value: p.name, ok: 'Rename' });
  if (!name) return;
  p.name = name;
  await saveUserPresets();
  renderPresets();
}

async function remove() {
  const p = findPreset(presetId);
  if (!p || p.builtIn) return;
  if (!(await askName({ title: `Delete “${p.name}”?`, ok: 'Delete', confirmOnly: true }))) return;
  userPresets = userPresets.filter((x) => x !== p);
  await saveUserPresets();
  // Keep the sound as it is, just no longer tied to a saved preset.
  presetId = BUILT_IN_PRESETS[0].id;
  dirty = true;
  renderPresets();
  saveState();
}

async function toggleSongLink(on) {
  if (!song) return;
  song.ampPreset = on ? presetId : null;
  await updateSong(song.id, { ampPreset: song.ampPreset });
  renderSongLink();
}

/* ---------- public ---------- */

// Called by the player when a song opens: load the tone attached to it, if any.
export function ampSongOpened(s) {
  song = s;
  if (s?.ampPreset && s.ampPreset !== presetId) loadPreset(s.ampPreset);
  renderSongLink();
}

export const isAmpRunning = () => running;
export const stopAmp = () => { if (running) stop(); };

function buildControls() {
  const character = $('amp-character');
  Object.entries(CHARACTERS).forEach(([k, c]) => character.add(new Option(c.label, k)));
  const cabinet = $('amp-cabinet');
  Object.entries(CABINETS).forEach(([k, c]) => cabinet.add(new Option(c.label, k)));
  const knobs = $('amp-knobs');
  for (const p of PARAMS) {
    const label = document.createElement('label');
    label.className = 'amp-knob';
    if (p.title) label.title = p.title;
    label.innerHTML = `<span class="amp-knob-name"></span><input type="range"><span class="amp-knob-val mono"></span>`;
    label.querySelector('.amp-knob-name').textContent = p.label;
    const input = label.querySelector('input');
    Object.assign(input, { id: 'amp-' + p.key, min: p.min, max: p.max, step: p.step });
    label.querySelector('.amp-knob-val').id = `amp-${p.key}-val`;
    knobs.append(label);
  }
  const edited = () => {
    dirty = true;
    applySettings();
    renderControls();
    renderPresets();
    saveState();
  };
  knobs.addEventListener('input', (e) => {
    const p = PARAMS.find((x) => 'amp-' + x.key === e.target.id);
    if (!p) return;
    settings[p.key] = Number(e.target.value);
    edited();
  });
  character.addEventListener('change', () => { settings.character = character.value; edited(); });
  cabinet.addEventListener('change', () => { settings.cabinet = cabinet.value; edited(); });
}

export async function initAmp(playerHooks = {}) {
  hooks = playerHooks;
  buildControls();
  $('amp-channel').value = localStorage.getItem('fretboard-amp-channel') || 'left';

  try {
    userPresets = (await getValue('ampPresets')) || [];
    const state = await getValue('ampState');
    if (state && findPreset(state.presetId)) presetId = state.presetId;
    if (state?.settings) settings = normalizeSettings(state.settings);
    else settings = normalizeSettings(findPreset(presetId).settings);
    dirty = !!state?.dirty;
  } catch { /* storage unavailable: built-ins only */ }
  renderControls();
  renderPresets();
  // Only look at audio devices once the Amp panel is opened, not on every page load.
  $('amp-device').add(new Option('Default input', ''));
  let listed = false;
  document.querySelector('[data-sheet-btn=amp]').addEventListener('click', () => {
    if (listed) return;
    listed = true;
    listDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
  });

  $('amp-go').addEventListener('click', async () => {
    if (running) { stop(); return; }
    $('amp-error').textContent = '';
    try {
      await start();
    } catch (e) {
      running = false;
      showRunning();
      $('amp-error').textContent = e?.name === 'NotAllowedError'
        ? 'Microphone/input access was blocked. Allow it in the address bar, then try again.'
        : 'Could not start the amp: ' + (e?.message || e);
    }
  });
  $('amp-device').addEventListener('change', () => {
    try { localStorage.setItem('fretboard-amp-device', $('amp-device').value); } catch { /* ignore */ }
    if (running) start().catch((e) => { $('amp-error').textContent = 'Could not switch input: ' + (e?.message || e); });
  });
  $('amp-channel').addEventListener('change', () => {
    try { localStorage.setItem('fretboard-amp-channel', $('amp-channel').value); } catch { /* ignore */ }
    applyChannel();
  });
  $('amp-top').addEventListener('click', stop);
  $('amp-preset').addEventListener('change', (e) => loadPreset(e.target.value));
  $('amp-saveas').addEventListener('click', saveAs);
  $('amp-save').addEventListener('click', overwrite);
  $('amp-rename').addEventListener('click', rename);
  $('amp-delete').addEventListener('click', remove);
  $('amp-song').addEventListener('change', (e) => toggleSongLink(e.target.checked));

  // Play-along: mute the tab's own guitar part and set the song's volume.
  const mute = $('amp-mute-track');
  mute.checked = localStorage.getItem('fretboard-amp-mute') === '1';
  mute.addEventListener('change', () => {
    try { localStorage.setItem('fretboard-amp-mute', mute.checked ? '1' : '0'); } catch { /* ignore */ }
    hooks.setGuitarMuted?.(mute.checked);
  });
  const vol = $('amp-song-vol');
  vol.value = localStorage.getItem('fretboard-amp-songvol') || '100';
  const showVol = () => { $('amp-song-vol-val').textContent = vol.value + '%'; };
  showVol();
  vol.addEventListener('input', () => {
    showVol();
    try { localStorage.setItem('fretboard-amp-songvol', vol.value); } catch { /* ignore */ }
    hooks.setSongVolume?.(Number(vol.value) / 100);
  });
}

// For the player: current play-along choices (applied when a song or track loads).
export const playAlongState = () => ({
  muteGuitar: $('amp-mute-track').checked,
  songVolume: Number($('amp-song-vol').value) / 100,
});

// Debug/verification hook (browser console): window.fretboardAmp.
window.fretboardAmp = { get ctx() { return ctx; }, get graph() { return graph; }, get settings() { return settings; }, loadPreset, start, stop };
