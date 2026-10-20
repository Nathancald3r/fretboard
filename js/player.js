// Guitar Pro / MusicXML / alphaTex player built on alphaTab:
// playback, tempo, A–B looping (drag-select bars), count-in, click track, a track mixer
// (show / mute / solo / volume), play-along with the recording and a speed trainer.
import { updateSong, getValue, setValue } from './db.js';
import { TONES, installTone, getTone, setTone } from './tone.js';
import { createPracticeTimer, formatClock } from './practice.js';
import { asciiTabToAlphaTex } from './asciitab.js';
import { noteName, keyLabel } from './theory.js';
import { initAmp, ampSongOpened, playAlongState } from './amp.js';
import { scoreHasChords, guessChords, injectChords, fileChords } from './chords.js';
import { initSing, singPosition, singFinished, singStopped, singSongChanged, singTrackChanged, singWantsVocalMuted } from './sing.js';
import { buildMelody } from './singcore.js';
import { initJudge, judgePosition, judgeFinished, judgeStopped, judgeSongChanged, judgeTrackChanged, judgeWantsTrackMuted } from './judge.js';
import { buildTargets } from './judgecore.js';
import { installPlayhead } from './playhead.js';
import {
  CLICK_SOUNDS, COUNT_SOUNDS, SUBDIVISIONS, COUNT_LENGTHS, loadClickSettings, saveClickSettings, sanitize,
  usesClassicCountIn, usesClassicClick, clickEvents, runCountIn, previewSound,
} from './click.js';
import { initPlayAlong, playAlongSongOpened, playAlongScoreReady, playerStateChanged as playAlongState2, recordingOn, tapSync, toggleRecording } from './playalong.js';
import { setlistContext, leaveSetlist } from './drawer.js';
import { transposeScore, shiftChordName } from './transpose.js';
import { lyricsTrack, buildLyrics, lineAt } from './lyrics.js';
import { initFretView, setNeck, showNotes } from './fretview.js';
import { initModes, isLive, liveAutoPlay, LIVE_GAP_MS } from './livemode.js';

const $ = (id) => document.getElementById(id);
const AT = window.alphaTab;
const VENDOR = new URL('../vendor/alphatab/', import.meta.url).href;
const PLAYING = 1;
const MIN_SPEED = 10;
const MAX_SPEED = 200;

let api = null;
let song = null;
let score = null;
let baseTempo = 120;
let readyForPlayback = false;
let trackIndex = 0;

const trainer = { on: false, loops: 0, start: 60, target: 100, step: 5, every: 2 };

// A soundfont the user loaded (better instrument samples) replaces the small built-in one.
let customSoundFont = null; // { name, data: ArrayBuffer }
const customSoundFontReady = getValue('soundFont').then((sf) => { customSoundFont = sf || null; }).catch(() => {});

const timer = createPracticeTimer({ isActive: () => api?.playerState === PLAYING });

let click = loadClickSettings();

function ensureApi() {
  if (api) return api;
  installTone();
  api = new AT.AlphaTabApi($('alphatab'), {
    core: { fontDirectory: VENDOR + 'font/', scriptFile: VENDOR + 'alphaTab.js' },
    display: { layoutMode: AT.LayoutMode.Page, staveProfile: AT.StaveProfile.Tab, scale: 1 },
    player: {
      playerMode: AT.PlayerMode.EnabledSynthesizer,
      soundFont: customSoundFont ? undefined : VENDOR + 'soundfont/sonivox.sf2',
      scrollElement: $('score-scroll'),
      enableCursor: true,
      enableUserInteraction: true,
      scrollOffsetY: -40,
    },
  });

  if (customSoundFont) api.loadSoundFont(customSoundFont.data, false);
  installPlayhead(api);
  applyClickVolume();

  api.scoreLoaded.on((s) => {
    score = s;
    baseTempo = s.masterBars[0]?.tempoAutomations?.[0]?.value || s.tempo || 120;
    $('pl-title').textContent = s.title || song?.title || 'Untitled';
    $('pl-artist').textContent = s.artist || song?.artist || '';
    buildTrackControls();
    updateBpm();
    buildSections();
    showNeck();
    resetLyrics();
  });
  api.renderStarted.on(() => { $('pl-loading').hidden = false; });
  api.renderFinished.on(() => { $('pl-loading').hidden = true; });
  api.error.on((e) => {
    $('pl-loading').hidden = false;
    $('pl-loading').textContent = 'Could not load this file: ' + (e?.message || e);
  });
  api.playerReady.on(() => {
    readyForPlayback = true;
    api.masterVolume = playAlongState().songVolume;
    setPlayButton();
  });
  api.soundFontLoad.on((e) => {
    if (!readyForPlayback) $('pl-play').title = `Loading sounds ${Math.round((e.loaded / e.total) * 100)}%`;
  });
  // The click is written into the song's MIDI on a channel of its own.
  api.midiLoad.on(addClickTrack);
  // alphaTab 1.8.4's worker player has a self-recursive loadedMidiInfo getter, which
  // midiLoaded.on() reads (patched in scripts/vendor.mjs; the try is a safety net).
  try {
    api.midiLoaded.on(() => {
      applyMix();
      applyClickVolume();
      playAlongScoreReady();
      if (restoreTick !== null) { api.tickPosition = restoreTick; restoreTick = null; }
      if (playOnLoad) { playOnLoad = false; setTimeout(startPlayback, 150); }
      // Live: the song was opened by the last one ending, so start it after a short gap.
      if (pendingAutoPlay) {
        pendingAutoPlay = false;
        const id = song?.id;
        setTimeout(() => { if (isLive() && song?.id === id && api.playerState !== PLAYING) startPlayback(); }, LIVE_GAP_MS);
      }
    });
  } catch { /* see above */ }
  api.playerStateChanged.on((e) => {
    setPlayButton();
    if (e?.stopped) { singStopped(); judgeStopped(); }
    playAlongState2(e.state === PLAYING);
    if (e.state === PLAYING) measureLag.start();
  });
  api.playerPositionChanged.on(onPosition);
  api.playedBeatChanged.on(onBeat);
  // While looping, alphaTab reports "finished" each time it wraps back to the start.
  api.playerFinished.on(() => {
    singFinished(api.isLooping);
    judgeFinished(api.isLooping);
    if (api.isLooping) onLoopCompleted();
    else if (isLive()) liveNextSong();
    else if (!recordingOn()) nextInSetlistHint();
  });
  api.playbackRangeChanged?.on(() => {
    // A new selection restarts the trainer's loop count.
    trainer.loops = 0;
    updateTrainerStatus();
  });
  // Clicking the tab while it plays: jump there with a count-in (if it's on).
  api.beatMouseDown.on(() => {
    clickResume = api.playerState === PLAYING && countInOn() ? 'pending' : null;
    if (clickResume) api.pause();
  });
  api.beatMouseUp.on((beat) => {
    if (clickResume !== 'pending') return;
    clickResume = null;
    const range = api.playbackRange;
    const tick = range ? range.startTick : api.tickCache?.getBeatStart(beat) ?? api.tickPosition;
    moveTo(tick, true);
  });
  return api;
}
let clickResume = null;

function setPlayButton() {
  const btn = $('pl-play');
  btn.disabled = !readyForPlayback;
  const playing = api?.playerState === PLAYING || counting;
  btn.classList.toggle('playing', playing);
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  btn.title = playing ? 'Pause (Space)' : 'Play (Space)';
  if (!readyForPlayback) btn.title = 'Loading sounds…';
}

let endTime = 0;
let seeking = false;

function onPosition(e) {
  endTime = e.endTime;
  $('pl-time').textContent = `${formatClock(e.currentTime)} / ${formatClock(e.endTime)}`;
  if (!seeking) $('pl-seek').value = e.endTime ? Math.round((e.currentTime / e.endTime) * 1000) : 0;
  showChordAt(e.currentTick);
  showTempoAt(e.currentTick);
  showSectionAt(e.currentTick);
  showLyricsAt(e.currentTick);
  measureLag.position(e.currentTime);
  singPosition(e);
  judgePosition(e);
}

/* ---------- count-in ---------- */

// How long alphaTab takes from play() to sound, measured on every start (seconds).
// Used to start the song early by that much so it lands right after the count-in.
const measureLag = {
  key: () => 'fretboard-lag-' + (recordingOn() ? 'media' : 'synth'),
  value() {
    try { return Number(localStorage.getItem(this.key())) || (recordingOn() ? 0.15 : 0.12); } catch { return 0.12; }
  },
  calledAt: 0,
  from: 0,
  armed: false,
  // Called right before api.play().
  arm() { this.calledAt = performance.now(); this.from = api.timePosition; this.armed = 'wait'; },
  start() { if (this.armed === 'wait') this.armed = true; },
  position(ms) {
    if (this.armed !== true) return;
    const played = (ms - this.from) / (api.playbackSpeed || 1);
    if (played < 30) return;
    this.armed = false;
    if (played > 1500) return;
    const lag = (performance.now() - played - this.calledAt) / 1000;
    if (lag < 0 || lag > 1) return;
    const old = this.value();
    try { localStorage.setItem(this.key(), (old * 0.6 + lag * 0.4).toFixed(3)); } catch { /* ignore */ }
  },
};

let counting = null; // cancel function while a count-in runs

const countInOn = () => $('pl-countin').classList.contains('on');

function currentBarLookup() {
  const bars = playedBars();
  return bars[currentBarIndex()] || bars[0];
}

// Starts playback from the current position, with the count-in if it's on.
function startPlayback() {
  if (!api || !readyForPlayback || counting) return;
  if (!countInOn() || usesClassicCountIn(click)) {
    api.countInVolume = countInOn() && !recordingOn() ? click.countVolume : 0;
    api.play();
    return;
  }
  api.countInVolume = 0;
  const bar = currentBarLookup();
  const mb = bar?.masterBar;
  const den = mb?.timeSignatureDenominator || 4;
  const num = mb?.timeSignatureNumerator || 4;
  const tempo = bar?.tempo || baseTempo;
  const beatSeconds = (60 / (tempo * api.playbackSpeed)) * (4 / den);
  showCount('');
  counting = runCountIn({
    settings: click, num, den, beatSeconds, lag: measureLag.value(),
    onBeat: showCount,
    start: () => {
      counting = null;
      measureLag.arm();
      api.play();
      setTimeout(() => showCount(null), 150);
    },
  });
  setPlayButton();
}

function cancelCountIn() {
  if (!counting) return false;
  counting();
  counting = null;
  showCount(null);
  setPlayButton();
  return true;
}

function showCount(n) {
  const el = $('count-overlay');
  el.hidden = n === null;
  if (n !== null) {
    el.textContent = n || '';
    el.classList.remove('pop');
    void el.offsetWidth;
    if (n) el.classList.add('pop');
  }
}

/* ---------- click track ---------- */

let clickChannel = -1;
const clickTrack = () => ({ playbackInfo: { primaryChannel: clickChannel, secondaryChannel: clickChannel } });
const clickOn = () => $('pl-metro').classList.contains('on');

function addClickTrack(midiFile) {
  clickChannel = -1;
  const sound = CLICK_SOUNDS[click.sound];
  if (!clickOn() || !sound || sound.program < 0 || !api.tickCache) return;
  let maxChannel = 0;
  for (const t of midiFile.tracks) for (const e of t.events) if (typeof e.channel === 'number') maxChannel = Math.max(maxChannel, e.channel);
  // Not maxChannel + 1: alphaTab puts its own metronome there (one past the file's last
  // channel), and its metronome code resets that channel's volume and instrument.
  let ch = maxChannel + 2;
  if (ch === 9) ch = 10; // channel 10 (index 9) is the drum kit
  const bars = api.tickCache.masterBars.map((b) => ({ start: b.start, end: b.end, num: b.masterBar.timeSignatureNumerator, den: b.masterBar.timeSignatureDenominator }));
  const M = AT.midi;
  const mine = [new M.ProgramChangeEvent(0, 0, ch, sound.program), new M.ControlChangeEvent(0, 0, ch, 7, 127), new M.ControlChangeEvent(0, 0, ch, 10, 64)];
  const velocity = [127, 96, 64];
  const length = sound.short ? 60 : 240;
  for (const ev of clickEvents(bars, click)) {
    const key = sound.keys[ev.level];
    mine.push(new M.NoteOnEvent(0, ev.tick, ch, key, velocity[ev.level]));
    mine.push(new M.NoteOffEvent(0, ev.tick + length, ch, key, 0));
  }
  if (midiFile.tracks.length === 1) {
    const events = midiFile.tracks[0].events;
    events.push(...mine);
    events.sort((a, b) => a.tick - b.tick); // stable: keeps the order of same-tick events
  } else {
    mine.forEach((e) => midiFile.addEvent(e));
  }
  clickChannel = ch;
}

// The click button: the click lives in the MIDI only while it's on, so switching it adds
// or removes it there (classic metronome: alphaTab's own, by volume).
function toggleClick() {
  toggleButton('pl-metro', !clickOn());
  applyClickVolume();
  const sound = CLICK_SOUNDS[click.sound];
  const inMidi = clickChannel >= 0;
  if (sound && sound.program >= 0 && inMidi !== clickOn()) rebuildClick();
}

function applyClickVolume() {
  if (!api) return;
  const on = clickOn();
  api.metronomeVolume = on && usesClassicClick(click) ? click.volume : 0;
  if (clickChannel >= 0) api.changeTrackVolume([clickTrack()], on ? click.volume : 0);
}

// Sound or rhythm changed: the click lives in the MIDI, so regenerate it (keeping the
// position and whether it was playing).
async function rebuildClick() {
  if (!api || !score || !readyForPlayback) return;
  const playing = api.playerState === PLAYING;
  const tick = api.tickPosition;
  if (playing) { api.pause(); await waitForPause(); }
  api.loadMidiForScore();
  api.tickPosition = tick;
  if (playing) api.play();
}

function initClickSheet() {
  const fill = (id, entries) => {
    const s = $(id);
    s.innerHTML = '';
    const list = Object.entries(entries);
    if (list.every(([k]) => !Number.isNaN(Number(k)))) list.sort((a, b) => a[0] - b[0]);
    list.forEach(([k, v]) => s.add(new Option(v.label || v, k)));
  };
  fill('ck-sound', CLICK_SOUNDS);
  fill('ck-sub', SUBDIVISIONS);
  fill('ci-sound', COUNT_SOUNDS);
  fill('ci-bars', COUNT_LENGTHS);
  fill('ci-sub', SUBDIVISIONS);
  const show = () => {
    $('ck-sound').value = click.sound;
    $('ck-sub').value = click.sub;
    $('ck-sub').disabled = usesClassicClick(click);
    $('ck-accent').checked = click.accent;
    $('ck-vol').value = Math.round(click.volume * 100);
    $('ck-vol-val').textContent = $('ck-vol').value + '%';
    $('ci-sound').value = click.countSound;
    $('ci-bars').value = click.countBars;
    $('ci-sub').value = click.countSub;
    $('ci-bars').disabled = $('ci-sub').disabled = usesClassicCountIn(click);
    $('ci-vol').value = Math.round(click.countVolume * 100);
    $('ci-vol-val').textContent = $('ci-vol').value + '%';
  };
  const change = (patch, rebuild) => {
    click = sanitize({ ...click, ...patch });
    saveClickSettings(click);
    show();
    applyClickVolume();
    if (rebuild) rebuildClick();
  };
  $('ck-sound').addEventListener('change', (e) => change({ sound: e.target.value }, true));
  $('ck-sub').addEventListener('change', (e) => change({ sub: Number(e.target.value) }, true));
  $('ck-accent').addEventListener('change', (e) => change({ accent: e.target.checked }, true));
  $('ck-vol').addEventListener('input', (e) => change({ volume: e.target.value / 100 }));
  $('ci-sound').addEventListener('change', (e) => change({ countSound: e.target.value }));
  $('ci-bars').addEventListener('change', (e) => change({ countBars: Number(e.target.value) }));
  $('ci-sub').addEventListener('change', (e) => change({ countSub: Number(e.target.value) }));
  $('ci-vol').addEventListener('input', (e) => change({ countVolume: e.target.value / 100 }));
  $('ci-preview').addEventListener('click', () => previewSound(click.countSound, click.countVolume));
  show();
}

function toggleButton(id, on) {
  const b = $(id);
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('fretboard-' + id, on ? '1' : '0'); } catch { /* ignore */ }
}

/* ---------- chords ---------- */

// Per master bar: { all: [{ offset, name }] } from the file, or guessed from the notes.
let chordBars = null;
let chordSource = 'none'; // 'file' | 'guess' | 'none'
let chordTimeline = { bars: null, list: [] };

function prepareChords(sc) {
  chordBars = null;
  chordSource = 'none';
  try {
    if (scoreHasChords(sc)) {
      chordSource = 'file';
      chordBars = fileChords(sc, trackIndex);
    } else {
      const guessed = guessChords(sc);
      const capo = sc.tracks[trackIndex]?.staves[0]?.capo || 0;
      if (capo) for (const b of guessed) for (const c of b.all) c.name = shiftChordName(c.name, -capo, shiftFlats);
      if (guessed.some((b) => b.all.length)) {
        injectChords(sc, guessed, AT.model.Chord);
        chordSource = 'guess';
        chordBars = guessed;
      }
    }
  } catch (err) {
    console.warn('Chord detection failed', err);
  }
  chordTimeline = { bars: null, list: [] };
  showChordSettings();
}

const chordsOn = () => $('pl-chords').checked;

function showChordSettings() {
  $('pl-chords-src').textContent = {
    file: 'Chord names come from the file.',
    guess: 'This file has no chord names, so they are guessed from the notes of all tracks. Treat them as a hint.',
    none: 'No chords found in this song.',
  }[chordSource];
  $('pl-chord').hidden = !chordsOn() || chordSource === 'none';
}

function applyChordVisibility() {
  const on = chordsOn();
  api.settings.notation.elements.set(AT.NotationElement.EffectChordNames, on);
  api.settings.notation.elements.set(AT.NotationElement.ChordDiagrams, on);
  // alphaTab draws a section's name on the same line as the bar's first chord, covering it.
  // With chords shown, the section chips above the tab name the sections instead.
  api.settings.notation.elements.set(AT.NotationElement.EffectMarker, !on);
}

// Chords in playback order (repeats included) with their absolute ticks.
function chordList() {
  const bars = playedBars();
  if (chordTimeline.bars !== bars) {
    const list = [];
    for (const b of bars) {
      for (const c of chordBars?.[b.masterBar.index]?.all || []) list.push({ tick: b.start + c.offset, name: c.name });
    }
    chordTimeline = { bars, list };
  }
  return chordTimeline.list;
}

function showChordAt(tick) {
  if ($('pl-chord').hidden) return;
  const list = chordList();
  let i = -1;
  for (let j = 0; j < list.length && list[j].tick <= tick; j++) i = j;
  const now = list[i]?.name || '–';
  const next = list.slice(i + 1).find((c) => c.name !== now)?.name || '';
  if ($('pl-chord-now').textContent !== now) $('pl-chord-now').textContent = now;
  if ($('pl-chord-next').textContent !== next) $('pl-chord-next').textContent = next;
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
  document.querySelector('[data-sheet-btn=speed]').classList.toggle('live', trainer.on);
  if (message) { el.textContent = message; return; }
  if (!trainer.on) { el.textContent = ''; return; }
  const toNext = trainer.every - (trainer.loops % trainer.every);
  el.textContent = `Trainer: loop ${trainer.loops}, faster in ${toNext}`;
}

/* ---------- tempo ---------- */

let speedPct = 100;

function setSpeed(percent, save = true) {
  // Tenths of a percent, so a typed BPM comes out exact.
  percent = Math.max(MIN_SPEED, Math.min(MAX_SPEED, Math.round(percent * 10) / 10));
  speedPct = percent;
  if (api) api.playbackSpeed = percent / 100;
  $('pl-speed').value = Math.min(150, percent);
  timer.noteSpeed(Math.round(percent));
  updateBpm();
  if (save && song) updateSong(song.id, { speed: percent });
}

// Tempo as BPM: the speed field shows and takes the song's tempo in BPM at this speed.
function setBpm(bpm) {
  setSpeed((bpm / baseTempo) * 100);
}

function updateBpm() {
  const bpm = Math.round((baseTempo * speedPct) / 100);
  if (document.activeElement !== $('pl-bpm-input')) $('pl-bpm-input').value = bpm;
  const pct = Math.round(speedPct);
  $('pl-speed-val').textContent = speedPct === 100 ? `original speed (${Math.round(baseTempo)} BPM)` : `${pct}% of ${Math.round(baseTempo)} BPM`;
  $('pl-speed-pct').textContent = pct + '%';
  $('pl-speed-pct').classList.toggle('changed', speedPct !== 100);
  document.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === speedPct));
  if (document.activeElement !== $('pl-speed-slide')) $('pl-speed-slide').value = Math.min(100, speedPct);
}

// The speed slider clicks to these.
const SPEED_STOPS = [10, 25, 50, 75, 100];
function slideSpeed(v) {
  const stop = SPEED_STOPS.find((s) => Math.abs(s - v) <= 3);
  if (stop !== undefined && stop !== v) $('pl-speed-slide').value = stop;
  setSpeed(stop ?? v);
}

// Tap tempo: the average gap between the last few taps.
let tapTimes = [];
function tapTempo() {
  const now = performance.now();
  tapTimes = tapTimes.filter((t) => now - t < 2500).concat(now).slice(-6);
  const b = $('pl-tap');
  b.classList.remove('flash');
  void b.offsetWidth;
  b.classList.add('flash');
  if (tapTimes.length < 2) { b.textContent = 'Tap…'; return; }
  const gap = (tapTimes[tapTimes.length - 1] - tapTimes[0]) / (tapTimes.length - 1);
  b.textContent = 'Tap';
  setBpm(Math.round(60000 / gap));
}

// Songs that change tempo: show the tempo where the cursor is.
let shownTempo = 0;
function showTempoAt(tick) {
  const bars = playedBars();
  const bar = bars.find((b) => tick >= b.start && tick < b.end);
  const t = bar?.tempo;
  if (!t || t === shownTempo) return;
  shownTempo = t;
  $('pl-tempo-now').textContent = Math.abs(t - baseTempo) > 0.5 ? `here ${Math.round((t * speedPct) / 100)}` : '';
}

/* ---------- tracks ---------- */

const hasTab = (track) => track.staves.some((st) => st.showTablature && st.tuning.length > 0);
const isDrums = (track) => track.staves.some((st) => st.isPercussion);

// What the track is, from its MIDI instrument, for tracks the file leaves unnamed.
function instrumentOf(track) {
  const program = track.playbackInfo?.program ?? -1;
  if (isDrums(track)) return 'Drums';
  if (program >= 24 && program <= 31) return 'Guitar';
  if (program >= 32 && program <= 39) return 'Bass';
  if (program <= 7) return 'Piano';
  if (isVocal(track)) return 'Vocals';
  return '';
}

const ICONS = { Guitar: '🎸', Bass: '🎸', Drums: '🥁', Piano: '🎹', Vocals: '🎤' };
const iconOf = (track) => ICONS[instrumentOf(track)] || '🎵';

function trackLabel(track, i) {
  if (track.name?.trim()) return track.name.trim();
  const kind = instrumentOf(track);
  return `Track ${i + 1}${kind ? ' · ' + kind : ''}`;
}

// The mixer: per track mute / solo / volume (remembered per song). Solo is done by muting
// the other tracks, so the click and count-in always stay audible.
let mix = [];

function defaultMix(sc) {
  return sc.tracks.map(() => ({ mute: false, solo: false, volume: 1 }));
}

function loadMix(sc, saved) {
  mix = defaultMix(sc);
  if (Array.isArray(saved) && saved.length === sc.tracks.length) {
    saved.forEach((m, i) => Object.assign(mix[i], { mute: !!m.mute, solo: !!m.solo, volume: Number.isFinite(m.volume) ? m.volume : 1 }));
  }
  // Files can be saved with tracks muted or soloed (a soloed track silences every other
  // one). Start from what the mixer shows instead.
  for (const t of sc.tracks) { t.playbackInfo.isMute = false; t.playbackInfo.isSolo = false; }
}

function saveMix() {
  if (song) updateSong(song.id, { mix: mix.map((m) => ({ ...m })) });
}

// Muted for you to play or sing it (amp play-along, singing mode).
const playAlongMuted = (i) => i === trackIndex && (playAlongState().muteGuitar || singWantsVocalMuted() || judgeWantsTrackMuted());

function isAudible(i) {
  const anySolo = mix.some((m) => m.solo);
  return !mix[i].mute && !(anySolo && !mix[i].solo) && !playAlongMuted(i);
}

function applyMix() {
  if (!api || !score) return;
  score.tracks.forEach((t, i) => {
    if (!mix[i]) return;
    api.changeTrackMute([t], !isAudible(i));
    api.changeTrackVolume([t], mix[i].volume);
  });
  showMix();
}

function buildTrackControls() {
  if (mix.length !== score.tracks.length) loadMix(score, song?.mix);
  const list = $('mixer-list');
  list.innerHTML = '';
  score.tracks.forEach((track, i) => {
    const row = document.createElement('div');
    row.className = 'mixer-row';
    row.dataset.i = i;
    row.innerHTML = `<button class="track-name" data-act="show" title="Show this track in the tab"><span class="ticon"></span><span class="tname"></span><small></small></button>
      <input type="range" min="0" max="150" step="1" data-act="volume" title="Volume" aria-label="Volume">
      <button class="ms" data-act="mute" title="Mute">M</button>
      <button class="ms solo" data-act="solo" title="Solo">S</button>`;
    row.querySelector('.ticon').textContent = iconOf(track);
    row.querySelector('.tname').textContent = trackLabel(track, i);
    row.querySelector('small').textContent = hasTab(track) ? '' : 'notation';
    list.append(row);
  });
  applyMix();
}

function showMix() {
  const rows = $('mixer-list').children;
  const anySolo = mix.some((m) => m.solo);
  mix.forEach((m, i) => {
    const row = rows[i];
    if (!row) return;
    row.classList.toggle('current', i === trackIndex);
    row.classList.toggle('silent', !isAudible(i));
    row.querySelector('[data-act=mute]').classList.toggle('on', m.mute || playAlongMuted(i));
    row.querySelector('[data-act=solo]').classList.toggle('on', m.solo);
    const vol = row.querySelector('[data-act=volume]');
    if (document.activeElement !== vol) vol.value = Math.round(m.volume * 100);
    row.title = playAlongMuted(i) ? 'Muted so you can play / sing this part (Amp or Sing panel)' : (anySolo && !m.solo ? 'Silent: another track is solo' : '');
  });
  // The play bar's track button and its quick mute / solo.
  const t = score?.tracks[trackIndex];
  if (!t) return;
  $('pl-track-icon').textContent = iconOf(t);
  $('pl-track-name').textContent = trackLabel(t, trackIndex);
  $('pl-mute').classList.toggle('on', mix[trackIndex].mute || playAlongMuted(trackIndex));
  $('pl-solo').classList.toggle('on', mix[trackIndex].solo);
  $('pl-track-btn').classList.toggle('silent', !isAudible(trackIndex));
  $('pl-mixer-note').textContent = mix.some((m) => m.mute || m.solo || m.volume !== 1) ? '' : 'Click a name to show that track. M = mute, S = solo (you can solo several).';
  $('pl-mix-reset').hidden = !mix.some((m) => m.mute || m.solo || m.volume !== 1);
}

function setMute(i, on = !mix[i].mute) {
  // Unmuting a track that's muted for play-along (Amp or Sing) turns that off instead.
  if (playAlongMuted(i) && !mix[i].mute) {
    for (const id of ['amp-mute-track', 'sg-mute', 'pj-mute']) {
      const box = $(id);
      if (box.checked) { box.checked = false; box.dispatchEvent(new Event('change')); }
    }
    applyMix();
    return;
  }
  mix[i].mute = on;
  applyMix();
  saveMix();
}

function setSolo(i, on = !mix[i].solo) {
  mix[i].solo = on;
  if (on) mix[i].mute = false;
  applyMix();
  saveMix();
}

function onMixerInput(e) {
  const row = e.target.closest('.mixer-row');
  if (!row) return;
  const i = Number(row.dataset.i);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (e.type === 'input' && act === 'volume') {
    mix[i].volume = e.target.value / 100;
    api?.changeTrackVolume([score.tracks[i]], mix[i].volume);
    return;
  }
  if (e.type === 'change' && act === 'volume') { saveMix(); e.target.blur(); return; }
  if (e.type !== 'click') return;
  if (act === 'show') selectTrack(i);
  else if (act === 'mute') setMute(i);
  else if (act === 'solo') setSolo(i);
}

function applyGuitarMute() {
  applyMix();
}

/* ---------- singing mode ---------- */

function isVocal(track) {
  return /vocal|voice|vox|sing|choir|lyric/i.test(track?.name || '')
    || [52, 53, 54, 85].includes(track?.playbackInfo?.program); // choir, voice oohs, synth voice, lead voice
}

// The shown track's melody in playback order (repeats included), cached per score/track/bars.
let melodyCache = { score: null, track: -1, bars: null, list: [] };
function currentMelody() {
  const bars = playedBars();
  const c = melodyCache;
  if (c.score !== score || c.track !== trackIndex || c.bars !== bars) {
    melodyCache = { score, track: trackIndex, bars, list: score && bars.length ? buildMelody(score, trackIndex, bars) : [] };
  }
  return melodyCache.list;
}

function selectTrack(i) {
  if (!score?.tracks[i] || !api) return;
  trackIndex = i;
  if (song) updateSong(song.id, { trackIndex });
  if (song?.capo != null) { song.trackIndex = i; reloadScore(); return; }
  applyStaveProfile();
  showNeck();
  if (chordSource === 'file') { chordBars = fileChords(score, trackIndex); chordTimeline = { bars: null, list: [] }; }
  api.renderTracks([score.tracks[trackIndex]]);
  applyMix();
  singTrackChanged();
  judgeTrackChanged();
}

// Every note and chord of the shown track in playback order, for practice mode.
let targetCache = { score: null, track: -1, bars: null, list: [] };
function currentTargets() {
  const bars = playedBars();
  const c = targetCache;
  if (c.score !== score || c.track !== trackIndex || c.bars !== bars) {
    const track = score?.tracks[trackIndex];
    targetCache = { score, track: trackIndex, bars, list: track && !isDrums(track) && bars.length ? buildTargets(score, trackIndex, bars) : [] };
  }
  return targetCache.list;
}

// Prefer a guitar track that has tab; skip vocals, bass and drums. Used when nothing is saved.
function defaultTrackIndex(sc) {
  const playable = (t) => hasTab(t) && !isDrums(t) && instrumentOf(t) !== 'Bass'
    && !/bass|drum|vocal|voice|sing|percussion/i.test(t.name || '');
  for (const ok of [(t) => playable(t) && instrumentOf(t) === 'Guitar', playable, hasTab]) {
    const i = sc.tracks.findIndex(ok);
    if (i !== -1) return i;
  }
  return 0;
}

// "Tab only" on a track without tablature (vocals, drums, piano) has nothing to draw and
// makes alphaTab fail, so such tracks fall back to standard notation.
function applyStaveProfile() {
  const track = score?.tracks[trackIndex];
  const wanted = $('pl-stave').value;
  const noTab = track && !hasTab(track);
  $('pl-notab').hidden = !noTab;
  const profile = noTab ? 'score' : wanted;
  api.settings.display.staveProfile = { tab: AT.StaveProfile.Tab, default: AT.StaveProfile.Default, score: AT.StaveProfile.Score }[profile];
  // Tab only: draw the rhythm (stems and beams) under the tab, like Songsterr.
  api.settings.notation.rhythmMode = profile === 'tab' ? AT.TabRhythmMode.ShowWithBars : AT.TabRhythmMode.Automatic;
  api.updateSettings();
  showTrackInfo();
}

// "Tuning: E A D G B E · Key: E · Capo: none" for the current track.
function showTrackInfo() {
  const staff = score?.tracks[trackIndex]?.staves[0];
  const parts = [];
  if (staff && staff.tuning.length && !staff.isPercussion) {
    parts.push('Tuning: ' + [...staff.tuning].reverse().map((m) => noteName(m % 12, true)).join(' '));
  }
  if (songKey()) parts.push('Key: ' + keyLabel(songKey()));
  if (staff && !staff.isPercussion) parts.push('Capo: ' + (staff.capo ? `fret ${staff.capo}` : 'none'));
  const semis = song?.transpose || 0;
  if (semis) parts.push(`Transposed ${semis > 0 ? '+' : '−'}${Math.abs(semis)}`);
  $('pl-info').textContent = parts.join(' · ');
  showShift();
}

// The key of the song as shown (after transposing): { tonic, minor } or null.
function songKey() {
  const bar = score?.masterBars[0];
  if (!bar || typeof bar.keySignature !== 'number') return null;
  const major = ((bar.keySignature * 7) % 12 + 12) % 12;
  const minor = bar.keySignatureType === 1;
  return { tonic: minor ? (major + 9) % 12 : major, minor };
}

function readScore(s) {
  if (s.kind === 'text' || s.kind === 'tex') {
    let tex = s.data;
    if (s.kind === 'text') {
      const converted = asciiTabToAlphaTex(s.data, { title: s.title, artist: s.artist, tempo: s.tempo || 100 });
      if (!converted) throw new Error('No tab lines found in this text (chord sheets can’t be played).');
      tex = converted.tex;
    }
    const importer = new AT.importer.AlphaTexImporter();
    importer.initFromString(tex, api.settings);
    return importer.readScore();
  }
  return AT.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(s.data), api.settings);
}

/* ---------- setlists ---------- */

function showSetlist() {
  const ctx = song && setlistContext(song.id);
  $('pl-setlist').hidden = !ctx;
  if (!ctx) return;
  $('pl-setlist-name').textContent = `${ctx.name} · ${ctx.index + 1}/${ctx.count}`;
  $('pl-prev-song').disabled = ctx.prevId === null;
  $('pl-next-song').disabled = ctx.nextId === null;
  $('pl-prev-song').dataset.id = ctx.prevId ?? '';
  $('pl-next-song').dataset.id = ctx.nextId ?? '';
}

// Live: at the end of a song, go on to the next one in the setlist.
let pendingAutoPlay = false;
let playOnLoad = false; // a recording was just picked: play it once its MIDI is loaded
function liveNextSong() {
  const ctx = song && setlistContext(song.id);
  if (ctx?.nextId == null) return;
  pendingAutoPlay = liveAutoPlay();
  location.hash = `song/${ctx.nextId}`;
}

function goSetlist(step) {
  const ctx = song && setlistContext(song.id);
  const id = ctx && (step > 0 ? ctx.nextId : ctx.prevId);
  if (id != null) location.hash = `song/${id}`;
}

function enterLive() {
  stopTrainer();
  setLoop(false);
  clearSelection();
  closeSheets();
  if (song) setSpeed(100, false);
}

function leaveLive() {
  pendingAutoPlay = false;
  if (song) setSpeed(song.speed || 100, false);
}

function nextInSetlistHint() {
  const ctx = song && setlistContext(song.id);
  if (ctx?.nextId != null) $('pl-next-song').classList.add('pulse');
}

/* ---------- opening a song ---------- */

export async function openPlayer(s) {
  song = s;
  score = null;
  mix = [];
  cancelCountIn();
  readyForPlayback = readyForPlayback && !!api;
  $('pl-title').textContent = s.title;
  $('pl-artist').textContent = s.artist || '';
  $('pl-loading').textContent = 'Loading score…';
  $('pl-loading').hidden = false;
  $('pl-next-song').classList.remove('pulse');
  stopTrainer();
  await customSoundFontReady;
  ensureApi();
  await playAlongSongOpened(s);
  api.stop();
  api.playbackRange = null;
  setLoop(false);
  timer.begin(s);
  if (!isLive()) pendingAutoPlay = false;
  setSpeed(isLive() ? 100 : s.speed || 100, false);
  $('pl-from-text').hidden = s.kind !== 'text';
  $('pl-text-link').href = `#song/${s.id}`;
  updateSong(s.id, { lastOpened: Date.now() });
  ampSongOpened(s);
  showSetlist();
  let parsed;
  try {
    parsed = readScore(s);
  } catch (e) {
    $('pl-loading').textContent = /tab lines/.test(e?.message) ? e.message : 'Could not load this file: ' + (e?.message || e);
    return;
  }
  const saved = s.trackIndex;
  trackIndex = saved >= 0 && saved < parsed.tracks.length ? saved : defaultTrackIndex(parsed);
  loadMix(parsed, s.mix);
  showParsed(parsed);
}

// Transpose / capo, then chords, then draw. Shared by opening a song and re-reading it.
function showParsed(parsed) {
  fileCapo = parsed.tracks[trackIndex]?.staves[0]?.capo || 0;
  shiftFlats = transposeScore(parsed, { semitones: song.transpose || 0, capo: song.capo ?? null, capoTrack: trackIndex }).flats;
  score = parsed;
  prepareChords(parsed);
  singSongChanged();
  judgeSongChanged();
  applyChordVisibility();
  applyStaveProfile();
  api.renderScore(parsed, [trackIndex]);
}

/* ---------- transpose and capo ---------- */

let fileCapo = 0; // the capo the file has on the shown track
let shiftFlats = false;
let restoreTick = null; // where to put the cursor once a re-read score is ready

// Reads the song again with the current transpose / capo, keeping the position.
function reloadScore() {
  if (!song || !api) return;
  cancelCountIn();
  api.pause();
  restoreTick = api.tickPosition;
  clearSelection();
  let parsed;
  try { parsed = readScore(song); } catch { return; }
  if (trackIndex >= parsed.tracks.length) trackIndex = 0;
  showParsed(parsed);
}

const canCapo = () => { const st = score?.tracks[trackIndex]?.staves[0]; return !!st && st.tuning.length > 0 && !st.isPercussion; };

function showShift() {
  const semis = song?.transpose || 0;
  const capo = song?.capo ?? fileCapo;
  $('tp-val').textContent = semis > 0 ? '+' + semis : semis < 0 ? '−' + -semis : '0';
  $('capo-val').textContent = canCapo() ? String(capo) : '–';
  for (const id of ['capo-down', 'capo-up']) $(id).disabled = !canCapo();
  $('tp-down').disabled = semis <= -11;
  $('tp-up').disabled = semis >= 11;
  $('capo-down').disabled ||= capo <= 0;
  $('capo-up').disabled ||= capo >= 12;
  $('tp-reset').hidden = !semis && (song?.capo == null || song.capo === fileCapo);
  const notes = [];
  if (song?.capo != null && song.capo !== fileCapo) notes.push(`File: capo ${fileCapo || 'none'}`);
  if (semis && recordingOn()) notes.push('The recording keeps its pitch');
  $('tp-note').textContent = notes.join(' · ');
}

function setShift(changes) {
  if (!song || !score) return;
  Object.assign(song, changes);
  if (song.capo === fileCapo) song.capo = null; // the file's own capo
  updateSong(song.id, { transpose: song.transpose || 0, capo: song.capo ?? null });
  reloadScore();
}

/* ---------- sections ---------- */

let sections = []; // [{ index (master bar), end (master bar after it), el }]
let shownSection = null;

function buildSections() {
  const nav = $('pl-sections');
  nav.textContent = '';
  sections = [];
  shownSection = null;
  const bars = score?.masterBars || [];
  bars.forEach((mb) => {
    if (!mb.section) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'section-chip';
    b.textContent = (mb.section.text || mb.section.marker || '').trim() || `Bar ${mb.index + 1}`;
    b.dataset.bar = mb.index;
    nav.append(b);
    sections.push({ index: mb.index, end: bars.length, el: b });
  });
  sections.forEach((sec, i) => { if (sections[i + 1]) sec.end = sections[i + 1].index; });
  nav.hidden = sections.length < 2;
}

const sectionOf = (masterIndex) => sections.findLast((sec) => sec.index <= masterIndex) || null;

function showSectionAt(tick) {
  if (!sections.length) return;
  const bar = playedBars().find((b) => tick >= b.start && tick < b.end);
  const sec = bar ? sectionOf(bar.masterBar.index) : null;
  if (sec === shownSection) return;
  shownSection?.el.classList.remove('now');
  sec?.el.classList.add('now');
  sec?.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  shownSection = sec;
}

// The played bars of a section, searching from the current position (repeats play a section
// more than once): the next time it comes, else the first.
function sectionBars(sec) {
  const bars = playedBars();
  const from = Math.max(0, currentBarIndex());
  let k = bars.findIndex((b, j) => j >= from && b.masterBar.index === sec.index);
  if (k === -1) k = bars.findIndex((b) => b.masterBar.index === sec.index);
  if (k === -1) return null;
  let last = k;
  while (bars[last + 1] && bars[last + 1].masterBar.index > sec.index && bars[last + 1].masterBar.index < sec.end) last++;
  return { first: bars[k], last: bars[last] };
}

function jumpToSection(sec) {
  if (!readyForPlayback) return;
  const range = sectionBars(sec);
  if (!range) return;
  moveTo(range.first.start);
  scrollBarToTop(range.first.masterBar.index);
}

// Brings the line of the tab holding a bar to the top of the score view. alphaTab only
// scrolls when the cursor would leave the view, so a jumped-to section could stay low.
function scrollBarToTop(masterIndex) {
  const go = () => {
    const systems = api?.renderer?.boundsLookup?.staffSystems;
    const sys = systems?.find((s) => s.bars.some((b) => b.index === masterIndex));
    if (!sys) return;
    const box = $('score-scroll');
    const offset = $('alphatab').getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    const bounds = sys.realBounds || sys.visualBounds;
    box.scrollTo({ top: Math.max(0, offset + bounds.y - 12), behavior: 'smooth' });
  };
  // After alphaTab has moved the cursor (and done any scrolling of its own).
  setTimeout(go, 60);
}

function loopSection(sec) {
  if (!readyForPlayback) return;
  const range = sectionBars(sec);
  if (!range) return;
  const staff = score.tracks[trackIndex].staves[0];
  const startBeat = staff.bars[range.first.masterBar.index]?.voices[0]?.beats[0];
  const endBeat = staff.bars[range.last.masterBar.index]?.voices[0]?.beats.at(-1);
  if (startBeat && endBeat && api.highlightPlaybackRange) {
    api.highlightPlaybackRange(startBeat, endBeat);
    api.applyPlaybackRangeFromHighlight?.();
  }
  api.playbackRange = { startTick: range.first.start, endTick: range.last.end };
  sections.forEach((x) => x.el.classList.toggle('looped', x === sec));
  setLoop(true);
  moveTo(range.first.start);
  scrollBarToTop(range.first.masterBar.index);
}

/* ---------- fretboard ---------- */

const fretboardOn = () => $('pl-fretboard').checked;

function showNeck() {
  const staff = score?.tracks[trackIndex]?.staves[0];
  const ok = fretboardOn() && staff && staff.tuning.length > 0 && !staff.isPercussion;
  $('pl-fretview').hidden = !ok;
  if (!ok) { setNeck(null); return; }
  let high = 0;
  for (const bar of staff.bars) for (const v of bar.voices) for (const b of v.beats) for (const n of b.notes) if (n.fret > high) high = n.fret;
  const capo = staff.capo || 0;
  const strings = staff.tuning.length;
  setNeck({
    strings,
    frets: high + capo > 15 ? Math.min(24, Math.max(19, high + capo + 1)) : 15,
    names: [...staff.tuning].reverse().map((m) => noteName(m % 12, shiftFlats)),
    capo,
  });
  showNotes([], []);
}

const fretNotes = (beat) => (beat?.notes || []).filter((n) => n.fret >= 0 && n.string >= 1).map((n) => ({ string: n.string, fret: n.fret }));

function onBeat(beat) {
  if (!beat || $('pl-fretview').hidden) return;
  if (beat.voice?.bar?.staff?.track?.index !== trackIndex) return;
  let next = beat.nextBeat;
  while (next && !next.notes.length && next.nextBeat) next = next.nextBeat;
  showNotes(fretNotes(beat), fretNotes(next));
}

/* ---------- lyrics ---------- */

let lyrics = { score: null, bars: null, track: -1, lines: [] };
let shownLine = -2;

function resetLyrics() {
  lyrics = { score: null, bars: null, track: -1, lines: [] };
  shownLine = -2;
  const track = score ? lyricsTrack(score) : -1;
  const on = $('pl-lyrics-on').checked;
  $('pl-lyrics').hidden = !on || track === -1;
  $('pl-lyrics-note').textContent = !score ? '' : track === -1 ? 'This song has no lyrics.' : `From ${trackLabel(score.tracks[track], track)}.`;
  $('ly-now').textContent = '';
  $('ly-next').textContent = '';
}

function lyricLines() {
  const bars = playedBars();
  if (lyrics.score !== score || lyrics.bars !== bars) {
    const track = lyricsTrack(score);
    lyrics = {
      score, bars, track,
      lines: track === -1 || !bars.length ? [] : buildLyrics(score, track, bars.map((b) => ({ start: b.start, masterIndex: b.masterBar.index }))),
    };
    shownLine = -2;
  }
  return lyrics.lines;
}

function lineHtml(target, line) {
  target.textContent = '';
  for (const w of line?.words || []) {
    const span = document.createElement('span');
    span.textContent = w.text + (w.joined ? '' : ' ');
    target.append(span);
  }
}

function showLyricsAt(tick) {
  if ($('pl-lyrics').hidden || !score) return;
  const lines = lyricLines();
  if (!lines.length) return;
  const i = lineAt(lines, tick);
  if (i !== shownLine) {
    lineHtml($('ly-now'), lines[i]);
    lineHtml($('ly-next'), lines[i + 1]);
    shownLine = i;
  }
  const spans = $('ly-now').children;
  lines[i].words.forEach((w, k) => spans[k]?.classList.toggle('sung', tick >= w.tick));
}

export function closePlayer() {
  if (!api) return;
  cancelCountIn();
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
  if (!api || !readyForPlayback) return;
  if (cancelCountIn()) return;
  if (api.playerState === PLAYING) api.pause();
  else startPlayback();
}

/* ---------- moving around ---------- */

// Bars in playback order (repeats included), each with its start/end in MIDI ticks.
const playedBars = () => api?.tickCache?.masterBars || [];

function currentBarIndex() {
  const tick = currentTick();
  const bars = playedBars();
  let i = bars.findIndex((b) => tick >= b.start && tick < b.end);
  if (i === -1) i = tick >= (bars.at(-1)?.end ?? 0) ? bars.length - 1 : 0;
  return i;
}

// While playing with count-in on, a jump pauses, moves, and plays again so the count-in
// is heard at the new spot. Pausing is asynchronous in alphaTab (it reports the paused
// position afterwards), so the move waits for the pause; quick repeated presses only
// update the target.
let restartTarget = null;

function waitForPause() {
  return new Promise((resolve) => {
    if (api.playerState !== PLAYING) { setTimeout(resolve, 30); return; }
    const done = () => { clearTimeout(timeout); off(); resolve(); };
    const handler = (e) => { if (e.state !== PLAYING) done(); };
    const unsubscribe = api.playerStateChanged.on(handler);
    const off = () => (typeof unsubscribe === 'function' ? unsubscribe() : api.playerStateChanged.off(handler));
    const timeout = setTimeout(done, 600);
  });
}

// resume: play from there afterwards (for clicks in the tab, which pause first).
async function moveTo(tick, resume = false) {
  const playing = api.playerState === PLAYING || resume || !!counting;
  if (!(playing && countInOn()) && restartTarget === null) {
    cancelCountIn();
    api.tickPosition = tick;
    api.scrollToCursor?.();
    if (resume) api.play();
    return;
  }
  const busy = restartTarget !== null;
  restartTarget = tick;
  if (busy) return;
  cancelCountIn();
  api.pause();
  await waitForPause();
  api.tickPosition = restartTarget;
  restartTarget = null;
  api.scrollToCursor?.();
  startPlayback();
}

// Position the next jump is relative to (the pending target during a restart).
const currentTick = () => restartTarget ?? api.tickPosition;

function seekToBar(index) {
  const bars = playedBars();
  if (!readyForPlayback || !bars.length) return;
  moveTo(bars[Math.max(0, Math.min(bars.length - 1, index))].start);
}

function stepBars(delta) {
  if (!playedBars().length) return;
  const i = currentBarIndex();
  // Going back from partway through a bar first returns to that bar's start (like a CD player).
  const atBarStart = currentTick() - playedBars()[i].start < 120;
  seekToBar(delta < 0 && !atBarStart ? i : i + delta);
}

// ↑ / ↓: the first bar of the previous / next line of the tab.
function stepLines(delta) {
  const bars = playedBars();
  const systems = api?.renderer?.boundsLookup?.staffSystems;
  if (!bars.length) return;
  const i = currentBarIndex();
  const mbIndex = bars[i].masterBar.index;
  const sysIndex = systems?.findIndex((s) => s.bars.some((b) => b.index === mbIndex)) ?? -1;
  if (sysIndex === -1) { stepBars(delta * 4); return; }
  const target = systems[sysIndex + delta];
  if (delta < 0 && !target) { seekToBar(0); return; }
  if (!target) { seekToBar(bars.length - 1); return; }
  // Going up from partway through a line first returns to that line's start.
  const lineStart = systems[sysIndex].bars[0].index;
  if (delta < 0) {
    const startOfThis = findPlayed(lineStart, i, -1);
    if (startOfThis !== -1 && startOfThis < i) { seekToBar(startOfThis); return; }
  }
  const first = target.bars[0].index;
  const j = findPlayed(first, i, delta);
  seekToBar(j === -1 ? i + delta * target.bars.length : j);
}

// The played bar for a master bar, searching from `from` in direction `dir` (repeats
// make one master bar appear several times).
function findPlayed(masterIndex, from, dir) {
  const bars = playedBars();
  for (let k = from; k >= 0 && k < bars.length; k += dir) if (bars[k].masterBar.index === masterIndex) return k;
  return bars.findIndex((b) => b.masterBar.index === masterIndex);
}

function backToStart() {
  if (!readyForPlayback) return;
  moveTo(api.playbackRange ? api.playbackRange.startTick : 0);
}

function setLoop(on) {
  toggleButton('pl-loop', on);
  if (api) api.isLooping = on;
}

function clearSelection() {
  if (!api) return;
  api.playbackRange = null;
  api.clearPlaybackRangeHighlight?.();
  sections.forEach((sec) => sec.el.classList.remove('looped'));
}

function rerender() {
  api.settings.display.layoutMode = AT.LayoutMode[$('pl-layout').value];
  api.settings.display.scale = Number($('pl-zoom').value);
  applyStaveProfile();
  api.render();
}

/* ---------- sound ---------- */

function showSoundFontName() {
  $('pl-sf-name').textContent = customSoundFont
    ? `Using “${customSoundFont.name}” (${Math.round(customSoundFont.data.byteLength / 1048576)} MB)`
    : 'Using the small built-in sound set (Sonivox, 1 MB)';
  $('pl-sf-reset').hidden = !customSoundFont;
}

async function useSoundFont(sf) {
  customSoundFont = sf;
  await setValue('soundFont', sf || undefined);
  showSoundFontName();
  if (!api) return;
  readyForPlayback = false;
  setPlayButton();
  api.resetSoundFonts();
  if (sf) api.loadSoundFont(sf.data, false);
  else api.loadSoundFont(VENDOR + 'soundfont/sonivox.sf2', false);
}

function initSound() {
  const tone = $('pl-tone');
  Object.entries(TONES).forEach(([key, t]) => tone.add(new Option(t.label, key)));
  tone.value = getTone();
  tone.addEventListener('change', () => setTone(tone.value));
  customSoundFontReady.then(showSoundFontName);
  $('pl-sf-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/\.sf[23]$/i.test(file.name)) { $('pl-sf-name').textContent = 'That isn’t a .sf2 or .sf3 soundfont file.'; return; }
    $('pl-sf-name').textContent = `Loading ${file.name}…`;
    await useSoundFont({ name: file.name, data: await file.arrayBuffer() });
  });
  $('pl-sf-reset').addEventListener('click', () => useSoundFont(null));
}

// Back from the recording to the synth: alphaTab builds a new synth, which needs the
// user's soundfont again.
function playModeChanged(recording) {
  readyForPlayback = recording;
  setPlayButton();
  if (!recording && customSoundFont) api.loadSoundFont(customSoundFont.data, false);
  if (!recording) api.masterVolume = playAlongState().songVolume;
  api.playbackSpeed = speedPct / 100;
  $('pl-recording-badge').hidden = !recording;
  $('pl-metro').disabled = recording;
  $('pl-metro').title = recording ? 'The click plays with the synth only' : 'Click track (B). Sound, volume and rhythm: ⚙';
}

/* ---------- bottom bar and its sheets ---------- */

function openSheet(name) {
  const opening = name && document.querySelector(`.sheet[data-sheet="${name}"]`).hidden;
  document.querySelectorAll('.sheet').forEach((el) => { el.hidden = !(opening && el.dataset.sheet === name); });
  document.querySelectorAll('[data-sheet-btn]').forEach((b) => b.classList.toggle('on', opening && b.dataset.sheetBtn === name));
}

// Returns true if a sheet was open.
function closeSheets() {
  const open = document.querySelector('.sheet:not([hidden])');
  if (open) openSheet(null);
  return !!open;
}

/* ---------- keeping the play bar on screen ---------- */

// How much of the bottom of the page the Windows taskbar covers, in CSS pixels. The
// window can reach under the taskbar (or the taskbar is set to auto-hide and pops up
// over the bottom edge as soon as the mouse goes there to click a button).
function taskbarOverlap() {
  const s = window.screen;
  // Phones and tablets have no taskbar; their home bar is handled by safe-area-inset-bottom.
  if (!s || !s.height || window.self !== window.top || matchMedia('(pointer: coarse)').matches) return 0;
  const pageBottom = window.screenY + window.outerHeight; // on screen, in screen pixels
  const workBottom = (s.availTop || 0) + s.availHeight;
  // Maximized windows hang a few invisible border pixels off the screen; ignore those.
  const covered = pageBottom - workBottom > 10 ? pageBottom - workBottom : 0;
  // Nothing reserved at the bottom (auto-hide taskbar) and the page reaches the screen
  // edge: keep a taskbar's height free so it doesn't cover the buttons.
  const autoHide = workBottom >= s.height - 1 && pageBottom >= s.height - 2 ? 48 : 0;
  // (Screen pixels; with the browser zoomed in this keeps a little more room than needed.)
  return Math.round(Math.min(120, Math.max(covered, autoHide)));
}

function initFit() {
  const root = document.documentElement.style;
  const lift = $('pl-lift');
  try { lift.value = localStorage.getItem('fretboard-lift') || 'auto'; } catch { /* ignore */ }
  if (!lift.value) lift.value = 'auto';
  let last = '';
  const fit = () => {
    const vv = window.visualViewport;
    // The part of the page actually visible (phones shrink it for toolbars and keyboards).
    const vh = vv ? vv.height : window.innerHeight;
    const hidden = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    const auto = lift.value === 'auto';
    const px = auto ? taskbarOverlap() : Number(lift.value) || 0;
    const key = `${vh}|${hidden}|${px}`;
    if (key === last) return;
    last = key;
    root.setProperty('--vvh', vh + 'px');
    root.setProperty('--vv-bottom', hidden + 'px');
    root.setProperty('--lift', px + 'px');
    $('pl-lift-note').textContent = auto ? (px ? `Keeping ${px}px free for the taskbar.` : 'Nothing is covering the bottom of this window.') : '';
  };
  lift.addEventListener('change', () => {
    try { localStorage.setItem('fretboard-lift', lift.value); } catch { /* ignore */ }
    fit();
  });
  window.addEventListener('resize', fit);
  window.addEventListener('focus', fit);
  window.visualViewport?.addEventListener('resize', fit);
  window.visualViewport?.addEventListener('scroll', fit);
  // Moving the window to another screen fires no event; check now and then.
  setInterval(fit, 1500);
  fit();
}

function initDock() {
  document.querySelectorAll('[data-sheet-btn]').forEach((b) => b.addEventListener('click', () => { openSheet(b.dataset.sheetBtn); b.blur(); }));
  document.querySelectorAll('.sheet [data-close]').forEach((b) => b.addEventListener('click', () => openSheet(null)));
  // The score fills the space between the top bar and the play bar.
  const root = document.documentElement.style;
  const measure = () => {
    root.setProperty('--dock-h', document.querySelector('.playbar').offsetHeight + 'px');
    root.setProperty('--top-h', document.querySelector('.topbar').offsetHeight + 'px');
  };
  new ResizeObserver(measure).observe(document.querySelector('.playbar'));
  new ResizeObserver(measure).observe(document.querySelector('.topbar'));
  initFit();

  const seek = $('pl-seek');
  seek.addEventListener('input', () => {
    seeking = true;
    if (endTime) $('pl-time').textContent = `${formatClock((seek.value / 1000) * endTime)} / ${formatClock(endTime)}`;
  });
  seek.addEventListener('change', () => {
    seeking = false;
    seek.blur();
    if (!api || !readyForPlayback || !endTime) return;
    // Time → the bar it falls in, so a jump while playing counts in from a bar start.
    const ms = (seek.value / 1000) * endTime;
    const bars = playedBars();
    const tickOf = (api.tickCache && bars.length) ? timeToBar(ms) : null;
    if (tickOf === null) api.timePosition = ms;
    else moveTo(tickOf);
  });

  const chords = $('pl-chords');
  chords.checked = localStorage.getItem('fretboard-chords') !== '0';
  chords.addEventListener('change', () => {
    try { localStorage.setItem('fretboard-chords', chords.checked ? '1' : '0'); } catch { /* ignore */ }
    showChordSettings();
    if (api && score) { applyChordVisibility(); api.updateSettings(); api.render(); }
  });
}

// The start tick of the bar playing at a time (ms), from the bars' share of the song.
function timeToBar(ms) {
  const bars = playedBars();
  const total = bars.at(-1).end;
  const tick = (ms / endTime) * total;
  const bar = bars.find((b) => tick >= b.start && tick < b.end) || bars.at(-1);
  return bar.start;
}

// Debug/verification hook (browser console): window.fretboardPlayer.
window.fretboardPlayer = { get api() { return api; }, get mix() { return mix; }, get click() { return click; }, get clickChannel() { return clickChannel; } };

export function initPlayer() {
  initDock();
  initSound();
  initClickSheet();
  initAmp({
    setGuitarMuted: applyGuitarMute,
    setSongVolume: (v) => { if (api) api.masterVolume = v; },
  });
  initSing({
    isPlaying: () => api?.playerState === PLAYING,
    getMelody: currentMelody,
    trackInfo: () => (score ? { name: trackLabel(score.tracks[trackIndex], trackIndex), vocal: isVocal(score.tracks[trackIndex]) } : {}),
    findVocalTrack: () => (score ? score.tracks.findIndex(isVocal) : -1),
    selectTrack,
    songKey,
    transpose: () => song?.transpose || 0,
    setTranspose: (n) => setShift({ transpose: Math.max(-11, Math.min(11, n)) }),
    vocalMuteChanged: applyGuitarMute,
    showSheet: (name) => { if (document.querySelector(`.sheet[data-sheet="${name}"]`).hidden) openSheet(name); },
  });
  initJudge({
    isPlaying: () => api?.playerState === PLAYING,
    getTargets: currentTargets,
    trackInfo: () => (score ? { name: trackLabel(score.tracks[trackIndex], trackIndex), drums: isDrums(score.tracks[trackIndex]) } : {}),
    trackMuteChanged: applyGuitarMute,
    showSheet: (name) => { if (document.querySelector(`.sheet[data-sheet="${name}"]`).hidden) openSheet(name); },
  });
  initPlayAlong({
    api: () => api,
    score: () => score,
    output: () => api?.player?.output,
    playedBars,
    songSeconds: () => endTime / 1000,
    modeChanged: playModeChanged,
    showSheet: (name) => { if (document.querySelector(`.sheet[data-sheet="${name}"]`).hidden) openSheet(name); },
    closeSheets,
    playWhenLoaded: () => { playOnLoad = true; },
    play: startPlayback,
  });

  // Toggles in the play bar remember their state.
  for (const id of ['pl-countin', 'pl-metro']) {
    let on = false;
    try { on = localStorage.getItem('fretboard-' + id) === '1'; } catch { /* ignore */ }
    toggleButton(id, on);
  }
  $('pl-play').addEventListener('click', togglePlay);
  $('pl-stop').addEventListener('click', () => { cancelCountIn(); api?.stop(); });
  $('pl-back').addEventListener('click', backToStart);
  $('pl-speed').addEventListener('input', (e) => setSpeed(Number(e.target.value)));
  $('pl-speed-slide').addEventListener('input', (e) => slideSpeed(Number(e.target.value)));
  $('pl-speed-slide').addEventListener('change', (e) => e.target.blur());
  $('pl-tap').addEventListener('pointerdown', (e) => { e.preventDefault(); tapTempo(); });
  $('pl-tap').addEventListener('keydown', (e) => { if (e.key === 'Enter') tapTempo(); });
  initModes({ enter: enterLive, leave: leaveLive });
  $('pl-slower').addEventListener('click', () => setBpm(Math.round((baseTempo * speedPct) / 100) - 5));
  $('pl-faster').addEventListener('click', () => setBpm(Math.round((baseTempo * speedPct) / 100) + 5));
  $('pl-bpm-input').addEventListener('change', (e) => { const v = Number(e.target.value); if (v > 0 && !isLive()) setBpm(v); e.target.blur(); updateBpm(); });
  $('pl-bpm-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); });
  $('pl-bpm-input').addEventListener('blur', updateBpm);
  document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));
  $('pl-loop').addEventListener('click', () => setLoop(!$('pl-loop').classList.contains('on')));
  $('pl-clear-sel').addEventListener('click', clearSelection);
  $('pl-countin').addEventListener('click', () => toggleButton('pl-countin', !countInOn()));
  $('pl-metro').addEventListener('click', toggleClick);
  ['pl-layout', 'pl-stave', 'pl-zoom'].forEach((id) => $(id).addEventListener('change', () => api && rerender()));

  // Sections: click jumps there, double-click loops the section.
  const sectionAt = (e) => sections.find((sec) => sec.el === e.target.closest('.section-chip'));
  $('pl-sections').addEventListener('click', (e) => { const sec = sectionAt(e); if (sec) jumpToSection(sec); });
  $('pl-sections').addEventListener('dblclick', (e) => { const sec = sectionAt(e); if (sec) loopSection(sec); });

  // Transpose and capo, saved with the song.
  $('tp-down').addEventListener('click', () => setShift({ transpose: Math.max(-11, (song?.transpose || 0) - 1) }));
  $('tp-up').addEventListener('click', () => setShift({ transpose: Math.min(11, (song?.transpose || 0) + 1) }));
  $('capo-down').addEventListener('click', () => setShift({ capo: Math.max(0, (song?.capo ?? fileCapo) - 1) }));
  $('capo-up').addEventListener('click', () => setShift({ capo: Math.min(12, (song?.capo ?? fileCapo) + 1) }));
  $('tp-reset').addEventListener('click', () => setShift({ transpose: 0, capo: null }));

  // Fretboard and lyrics panes.
  initFretView($('pl-fretview'));
  for (const [id, key, def] of [['pl-fretboard', 'fretboard-fretview', '0'], ['pl-lyrics-on', 'fretboard-lyrics', '1']]) {
    let v = def;
    try { v = localStorage.getItem(key) ?? def; } catch { /* ignore */ }
    $(id).checked = v === '1';
    $(id).addEventListener('change', () => {
      try { localStorage.setItem(key, $(id).checked ? '1' : '0'); } catch { /* ignore */ }
      if (id === 'pl-fretboard') showNeck(); else resetLyrics();
    });
  }

  // Tracks: the mixer sheet, and quick mute / solo for the shown track in the play bar.
  const mixer = $('mixer-list');
  ['click', 'input', 'change'].forEach((t) => mixer.addEventListener(t, onMixerInput));
  $('pl-mute').addEventListener('click', () => score && setMute(trackIndex));
  $('pl-solo').addEventListener('click', () => score && setSolo(trackIndex));
  $('pl-mix-reset').addEventListener('click', () => { if (!score) return; mix = defaultMix(score); applyMix(); saveMix(); });

  // Setlist: previous / next song.
  ['pl-prev-song', 'pl-next-song'].forEach((id) => $(id).addEventListener('click', (e) => { if (e.currentTarget.dataset.id) location.hash = `song/${e.currentTarget.dataset.id}`; }));
  $('pl-setlist-leave').addEventListener('click', () => { leaveSetlist(); showSetlist(); });
  window.addEventListener('setlistschange', showSetlist);

  $('tr-go').addEventListener('click', () => {
    if (trainer.on) { stopTrainer(); return; }
    const num = (id) => Number($(id).value);
    Object.assign(trainer, { on: true, loops: 0, start: num('tr-start'), target: num('tr-target'), step: num('tr-step'), every: Math.max(1, num('tr-every')) });
    if (trainer.target < trainer.start) [trainer.start, trainer.target] = [trainer.target, trainer.start];
    setSpeed(trainer.start);
    setLoop(true);
    $('tr-go').textContent = 'Stop trainer';
    updateTrainerStatus();
    if (api.playerState !== PLAYING) startPlayback();
  });

  // Clicking a checkbox, select or slider leaves it focused, and Space / arrow keys would
  // then change it instead of controlling playback; hand focus back to the page.
  $('view-player').addEventListener('change', (e) => {
    if (e.target.matches('input[type=checkbox], input[type=range], select')) e.target.blur();
  });
  // Buttons too: a focused button would be "clicked" again by Space.
  $('view-player').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && !b.closest('dialog')) b.blur();
  });

  document.addEventListener('keydown', (e) => {
    if ($('view-player').hidden || $('view-player').querySelector('dialog[open]')) return;
    if (document.body.classList.contains('drawer-open')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Let text and number fields take typing and arrows.
    if (e.target.matches?.('input[type=number], input[type=text], input[type=search], input:not([type]), textarea, select')) return;
    const keys = {
      ' ': togglePlay,
      k: togglePlay,
      ArrowLeft: () => stepBars(e.shiftKey ? -4 : -1),
      ArrowRight: () => stepBars(e.shiftKey ? 4 : 1),
      ArrowUp: () => stepLines(-1),
      ArrowDown: () => stepLines(1),
      j: () => stepBars(-1),
      ';': () => stepBars(1),
      Home: backToStart,
      Backspace: backToStart,
      End: () => seekToBar(playedBars().length - 1),
      '[': () => !isLive() && setBpm(Math.round((baseTempo * speedPct) / 100) - 5),
      ']': () => !isLive() && setBpm(Math.round((baseTempo * speedPct) / 100) + 5),
      y: () => !isLive() && tapTempo(),
      // Page-turner pedals send Page Down / Page Up.
      PageDown: () => stepLines(1),
      PageUp: () => stepLines(-1),
      n: () => goSetlist(1),
      p: () => goSetlist(-1),
      l: () => !isLive() && setLoop(!$('pl-loop').classList.contains('on')),
      c: () => toggleButton('pl-countin', !countInOn()),
      b: toggleClick,
      m: () => score && setMute(trackIndex),
      s: () => score && setSolo(trackIndex),
      t: () => { if (!tapSync() && recordingOn()) openSheet('playalong'); },
      r: toggleRecording,
      f: () => { $('pl-fretboard').checked = !fretboardOn(); $('pl-fretboard').dispatchEvent(new Event('change')); },
      Escape: () => { if (!closeSheets()) clearSelection(); },
    };
    const action = keys[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!action) return;
    e.preventDefault(); // also stops Space from clicking a focused button and arrows from scrolling
    action();
  });
}
