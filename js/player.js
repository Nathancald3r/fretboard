// Guitar Pro / MusicXML / alphaTex player built on alphaTab:
// playback, speed, A–B looping (drag-select bars), count-in, click, track mute/solo
// and an automatic speed trainer.
import { updateSong } from './db.js';
import { createPracticeTimer, formatClock } from './practice.js';
import { asciiTabToAlphaTex } from './asciitab.js';

const $ = (id) => document.getElementById(id);
const AT = window.alphaTab;
const VENDOR = new URL('../vendor/alphatab/', import.meta.url).href;
const PLAYING = 1;

let api = null;
let song = null;
let score = null;
let baseTempo = 120;
let readyForPlayback = false;

const trainer = { on: false, loops: 0, start: 60, target: 100, step: 5, every: 2 };

const timer = createPracticeTimer({ isActive: () => api?.playerState === PLAYING });

function ensureApi() {
  if (api) return api;
  api = new AT.AlphaTabApi($('alphatab'), {
    core: { fontDirectory: VENDOR + 'font/', scriptFile: VENDOR + 'alphaTab.js' },
    display: { layoutMode: AT.LayoutMode.Page, staveProfile: AT.StaveProfile.Tab, scale: 1 },
    player: {
      playerMode: AT.PlayerMode.EnabledSynthesizer,
      soundFont: VENDOR + 'soundfont/sonivox.sf2',
      scrollElement: $('score-scroll'),
      enableCursor: true,
      enableUserInteraction: true,
      scrollOffsetY: -40,
    },
  });

  api.scoreLoaded.on((s) => {
    score = s;
    baseTempo = s.masterBars[0]?.tempoAutomations?.[0]?.value || 120;
    $('pl-title').textContent = s.title || song?.title || 'Untitled';
    $('pl-artist').textContent = s.artist || song?.artist || '';
    buildTrackControls();
    updateBpm();
  });
  api.renderStarted.on(() => { $('pl-loading').hidden = false; });
  api.renderFinished.on(() => { $('pl-loading').hidden = true; });
  api.error.on((e) => {
    $('pl-loading').hidden = false;
    $('pl-loading').textContent = 'Could not load this file: ' + (e?.message || e);
  });
  api.playerReady.on(() => {
    readyForPlayback = true;
    setPlayButton();
  });
  api.soundFontLoad.on((e) => {
    if (!readyForPlayback) $('pl-play').textContent = `Sound ${Math.round((e.loaded / e.total) * 100)}%`;
  });
  api.playerStateChanged.on(setPlayButton);
  api.playerPositionChanged.on(onPosition);
  // While looping, alphaTab reports "finished" each time it wraps back to the start.
  api.playerFinished.on(() => { if (api.isLooping) onLoopCompleted(); });  api.playbackRangeChanged?.on(() => {
    // A new selection restarts the trainer's loop count.
    trainer.loops = 0;
    updateTrainerStatus();
  });
  return api;
}

function setPlayButton() {
  const btn = $('pl-play');
  btn.disabled = !readyForPlayback;
  if (!readyForPlayback) return;
  btn.textContent = api.playerState === PLAYING ? 'Pause' : 'Play';
}

function onPosition(e) {
  $('pl-time').textContent = `${formatClock(e.currentTime)} / ${formatClock(e.endTime)}`;
}

function onLoopCompleted() {
  if (!trainer.on) return;
  trainer.loops++;
  if (trainer.loops % trainer.every === 0) {
    const current = Math.round(api.playbackSpeed * 100);
    const next = Math.min(trainer.target, current + trainer.step);
    setSpeed(next);
    if (next >= trainer.target) {
      trainer.on = false;
      $('tr-go').textContent = 'Start trainer';
      updateTrainerStatus(`Reached ${trainer.target}% — nice work!`);
      return;
    }
  }
  updateTrainerStatus();
}

function updateTrainerStatus(message) {
  const el = $('tr-status');
  if (message) { el.textContent = '· ' + message; return; }
  if (!trainer.on) { el.textContent = ''; return; }
  const toNext = trainer.every - (trainer.loops % trainer.every);
  el.textContent = `· running at ${Math.round(api.playbackSpeed * 100)}%, loop ${trainer.loops}, speeds up in ${toNext}`;
}

function setSpeed(percent, save = true) {
  percent = Math.max(25, Math.min(150, Math.round(percent)));
  if (api) api.playbackSpeed = percent / 100;
  $('pl-speed').value = percent;
  $('pl-speed-val').textContent = percent + '%';
  timer.noteSpeed(percent);
  updateBpm();
  if (save && song) updateSong(song.id, { speed: percent });
}

function updateBpm() {
  const pct = Number($('pl-speed').value);
  $('pl-bpm').textContent = score ? `≈ ${Math.round((baseTempo * pct) / 100)} BPM` : '';
}

function buildTrackControls() {
  const select = $('pl-track');
  select.innerHTML = '';
  score.tracks.forEach((t, i) => select.add(new Option(t.name || `Track ${i + 1}`, i)));
  const saved = song?.trackIndex ?? defaultTrackIndex();
  select.value = Math.min(saved, score.tracks.length - 1);
  if (Number(select.value) !== 0) api.renderTracks([score.tracks[select.value]]);

  const list = $('mixer-list');
  list.innerHTML = '';
  score.tracks.forEach((track, i) => {
    const row = document.createElement('div');
    row.className = 'mixer-row';
    row.innerHTML = `<span class="name"></span>
      <button class="small ghost" data-act="mute">Mute</button>
      <button class="small ghost" data-act="solo">Solo</button>`;
    row.querySelector('.name').textContent = track.name || `Track ${i + 1}`;
    row.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      const on = !btn.classList.contains('on');
      btn.classList.toggle('on', on);
      if (btn.dataset.act === 'mute') api.changeTrackMute([track], on);
      else api.changeTrackSolo([track], on);
    });
    list.append(row);
  });
}

// Prefer the first guitar-looking track (skip drums, bass, vocals) when nothing is saved.
function defaultTrackIndex() {
  const i = score.tracks.findIndex((t) => {
    const name = (t.name || '').toLowerCase();
    const isDrums = t.staves?.[0]?.isPercussion;
    return !isDrums && !/bass|drum|vocal|voice|percussion/.test(name);
  });
  return Math.max(0, i);
}

export async function openPlayer(s) {
  song = s;
  score = null;
  readyForPlayback = readyForPlayback && !!api;
  $('pl-title').textContent = s.title;
  $('pl-artist').textContent = s.artist || '';
  $('pl-loading').textContent = 'Loading score…';
  $('pl-loading').hidden = false;
  stopTrainer();
  ensureApi();
  api.stop();
  api.playbackRange = null;
  $('pl-loop').checked = false;
  api.isLooping = false;
  timer.begin(s);
  setSpeed(s.speed || 100, false);
  $('pl-from-text').hidden = s.kind !== 'text';
  $('pl-text-link').href = `#song/${s.id}`;
  if (s.kind === 'text') {
    const converted = asciiTabToAlphaTex(s.data, { title: s.title, artist: s.artist, tempo: s.tempo || 100 });
    if (!converted) {
      $('pl-loading').textContent = 'No tab lines found in this text (chord sheets can’t be played).';
      return;
    }
    api.tex(converted.tex);
  } else if (s.kind === 'tex') api.tex(s.data);
  else api.load(new Uint8Array(s.data));
  updateSong(s.id, { lastOpened: Date.now() });
}

export function closePlayer() {
  if (!api) return;
  api.pause();
  stopTrainer();
  timer.end();
}

function stopTrainer() {
  trainer.on = false;
  $('tr-go').textContent = 'Start trainer';
  updateTrainerStatus();
}

function togglePlay() {
  if (api && readyForPlayback) api.playPause();
}

function setLoop(on) {
  $('pl-loop').checked = on;
  if (api) api.isLooping = on;
}

function clearSelection() {
  if (!api) return;
  api.playbackRange = null;
  api.clearPlaybackRangeHighlight?.();
}

function rerender() {
  api.settings.display.layoutMode = AT.LayoutMode[$('pl-layout').value];
  api.settings.display.staveProfile = { tab: AT.StaveProfile.Tab, default: AT.StaveProfile.Default, score: AT.StaveProfile.Score }[$('pl-stave').value];
  api.settings.display.scale = Number($('pl-zoom').value);
  api.updateSettings();
  api.render();
}

export function initPlayer() {
  $('pl-play').addEventListener('click', togglePlay);
  $('pl-stop').addEventListener('click', () => api?.stop());
  $('pl-speed').addEventListener('input', (e) => setSpeed(Number(e.target.value)));
  $('pl-slower').addEventListener('click', () => setSpeed(Number($('pl-speed').value) - 5));
  $('pl-faster').addEventListener('click', () => setSpeed(Number($('pl-speed').value) + 5));
  $('pl-loop').addEventListener('change', (e) => setLoop(e.target.checked));
  $('pl-clear-sel').addEventListener('click', clearSelection);
  $('pl-countin').addEventListener('change', (e) => { if (api) api.countInVolume = e.target.checked ? 1 : 0; });
  $('pl-metro').addEventListener('change', (e) => { if (api) api.metronomeVolume = e.target.checked ? 1 : 0; });
  $('pl-track').addEventListener('change', (e) => {
    const i = Number(e.target.value);
    api.renderTracks([score.tracks[i]]);
    if (song) updateSong(song.id, { trackIndex: i });
  });
  ['pl-layout', 'pl-stave', 'pl-zoom'].forEach((id) => $(id).addEventListener('change', () => api && rerender()));

  $('tr-go').addEventListener('click', () => {
    if (trainer.on) { stopTrainer(); return; }
    const num = (id) => Number($(id).value);
    Object.assign(trainer, { on: true, loops: 0, start: num('tr-start'), target: num('tr-target'), step: num('tr-step'), every: Math.max(1, num('tr-every')) });
    if (trainer.target < trainer.start) [trainer.start, trainer.target] = [trainer.target, trainer.start];
    setSpeed(trainer.start);
    setLoop(true);
    $('tr-go').textContent = 'Stop trainer';
    updateTrainerStatus();
    if (api.playerState !== PLAYING) api.play();
  });

  document.addEventListener('keydown', (e) => {
    if ($('view-player').hidden || e.target.closest('input, select, textarea, button')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === '[') setSpeed(Number($('pl-speed').value) - 5);
    else if (e.key === ']') setSpeed(Number($('pl-speed').value) + 5);
    else if (e.key.toLowerCase() === 'l') setLoop(!$('pl-loop').checked);
    else if (e.key === 'Escape') clearSelection();
  });
}
