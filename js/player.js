// Guitar Pro / MusicXML / alphaTex player built on alphaTab:
// playback, tempo, A–B looping (drag-select bars), count-in, click track, a track mixer
// (show / mute / solo / volume), play-along with the recording and a speed trainer.
import { initEditor, pickBeat } from './editor.js';
import { updateSong, getValue, setValue } from './db.js';
import { TONES, installTone, getTone, setTone, ROOMS, getRoom, setRoom } from './tone.js';
import { createPracticeTimer, formatClock } from './practice.js';
import { asciiTabToAlphaTex, asciiTabsToAlphaTex } from './asciitab.js';
import { noteName, keyLabel } from './theory.js';
import { initAmp, ampSongOpened, playAlongState } from './amp.js';
import { scoreHasChords, guessChords, injectChords, fileChords, sheetKeyShift } from './chords.js';
import { sheetChords, sungWords, barSpans } from './chordsheet.js';
import { initSing, singPosition, singFinished, singStopped, singSongChanged, singTrackChanged, singWantsVocalMuted } from './sing.js';
import { buildMelody } from './singcore.js';
import { initJudge, judgePosition, judgeFinished, judgeStopped, judgeSongChanged, judgeTrackChanged, judgeWantsTrackMuted } from './judge.js';
import { buildTargets } from './judgecore.js';
import { installPlayhead } from './playhead.js';
import {
  CLICK_SOUNDS, COUNT_SOUNDS, SUBDIVISIONS, COUNT_LENGTHS, loadClickSettings, saveClickSettings, sanitize,
  usesClassicCountIn, usesClassicClick, clickEvents, runCountIn, previewSound,
} from './click.js';
import { parseSource, sourceLine, facts as tabFacts } from './tabinfo.js';
import { initPlayAlong, playAlongSongOpened, playAlongScoreReady, playerStateChanged as playAlongState2, recordingOn, videoStartTick, tapSync, tapVideoBeat, setStartHere, toggleRecording, startVideoHere } from './playalong.js';
import { setlistContext, leaveSetlist } from './drawer.js';
import { transposeScore, shiftChordName } from './transpose.js';
import { lyricsTrack, buildLyrics, lineAt } from './lyrics.js';
import { initFretView, setNeck, showNotes } from './fretview.js';
import { initKeyView, keyRange, setKeys, showKeys } from './keyview.js';
import { initDrumView, setKit, showDrums, drumMidi } from './drumview.js';
import { initShakerView, setShaker, showShake, SHAKEN } from './shakerview.js';
import { bindBtControls, delayPositionEvents } from './btdelay.js';
import { initModes, isLive, liveAutoPlay, LIVE_GAP_MS } from './livemode.js';
import { keepScreenOn, initMediaSession, describeSong } from './stand.js';
import { humanize, liftCymbals, sustainPads, ownDrumChannels } from './humanize.js';
import { highlight } from './texttab.js';
import { autoLevels } from './mixlevels.js';

const $ = (id) => document.getElementById(id);
const AT = window.alphaTab;
const VENDOR = new URL('../vendor/alphatab/', import.meta.url).href;
// Realistic built-in sounds: MuseScore General (MIT, FluidR3-based, 38 MB, cached after the first load).
const DEFAULT_SF = new URL('../vendor/soundfont/MuseScore_General.sf3', import.meta.url).href;
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
// MuseScore General is mixed much quieter than other soundfonts; lift it to a normal level.
const DEFAULT_SF_GAIN = 2;
const synthVolume = (v) => (recordingOn() || customSoundFont ? v : v * DEFAULT_SF_GAIN);
const customSoundFontReady = getValue('soundFont').then((sf) => { customSoundFont = sf || null; }).catch(() => {});

const timer = createPracticeTimer({ isActive: () => api?.playerState === PLAYING });

let click = loadClickSettings();

function ensureApi() {
  if (api) return api;
  installTone();
  api = new AT.AlphaTabApi($('alphatab'), {
    core: { fontDirectory: VENDOR + 'font/', scriptFile: VENDOR + 'alphaTab.js' },
    display: { layoutMode: AT.LayoutMode.Page, staveProfile: AT.StaveProfile.Tab, scale: 1, effectBandPaddingBottom: 5, resources: { barNumberColor: '#222222' } }, // a little air between chord names and swells
    player: {
      playerMode: AT.PlayerMode.EnabledSynthesizer,
      soundFont: customSoundFont ? undefined : DEFAULT_SF,
      scrollElement: $('score-scroll'),
      enableCursor: true,
      enableUserInteraction: true,
      scrollOffsetY: -40,
    },
  });

  // Quiet italic bar numbers and bold serif section names, like Ultimate Guitar's Tab Pro.
  const fonts = api.settings.display.resources.elementFonts;
  fonts.set(AT.NotationElement.BarNumber, new AT.model.Font('Georgia, serif', 11, AT.model.FontStyle.Italic));
  fonts.set(AT.NotationElement.EffectMarker, new AT.model.Font('Georgia, serif', 15, AT.model.FontStyle.Plain, AT.model.FontWeight.Bold));
  api.updateSettings();

  if (customSoundFont) api.loadSoundFont(customSoundFont.data, false);
  playheadCtl = installPlayhead(api);
  applyClickVolume();

  api.scoreLoaded.on((s) => {
    score = s;
    baseTempo = s.masterBars[0]?.tempoAutomations?.[0]?.value || s.tempo || 120;
    $('pl-title').textContent = s.title || song?.title || 'Untitled';
    $('pl-artist').textContent = s.artist || song?.artist || '';
    showTabInfo();
    buildTrackControls();
    updateBpm();
    buildSections();
    showNeck();
    resetLyrics();
    window.dispatchEvent(new Event('fbscore'));
  });
  api.renderStarted.on(() => { $('pl-loading').hidden = false; });
  api.renderFinished.on(() => { $('pl-loading').hidden = true; });
  api.postRenderFinished?.on(drawSectionLabels);
  api.postRenderFinished?.on(drawPin);
  api.error.on((e) => {
    $('pl-loading').hidden = false;
    $('pl-loading').textContent = 'Could not load this file: ' + (e?.message || e);
  });
  api.playerReady.on(() => {
    delayPositionEvents(api, recordingOn); // Bluetooth headphones: hold the cursor back by their lag
    readyForPlayback = true;
    api.masterVolume = synthVolume(playAlongState().songVolume);
    setPlayButton();
  });
  api.soundFontLoad.on((e) => {
    if (!readyForPlayback) $('pl-play').title = `Loading sounds ${Math.round((e.loaded / e.total) * 100)}%`;
  });
  // Guitar chords are strummed, and the click is written into the song's MIDI on a channel of its own.
  api.midiLoad.on((midiFile) => { strumGuitars(midiFile); padSustain(midiFile); liftCymbals(midiFile.tracks.flatMap((t) => t.events)); addClickTrack(midiFile); });
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
    keepScreenOn(e.state === PLAYING || !!counting);
    if (e.state === PLAYING) measureLag.start();
  });
  api.playerPositionChanged.on(onPosition);
  api.playedBeatChanged.on(() => keepPlayheadInView());
  api.playedBeatChanged.on((beat) => { playedBeat = beat; onBeat(beat); });
  // While looping, alphaTab reports "finished" each time it wraps back to the start.
  api.playerFinished.on(() => {
    singFinished(api.isLooping);
    judgeFinished(api.isLooping);
    if (api.isLooping) onLoopCompleted();
    else if (isLive()) liveNextSong();
    else if (!recordingOn()) nextInSetlistHint();
  });
  api.playbackRangeChanged?.on(() => {
    document.body.classList.toggle('has-range', !!api.playbackRange);
    showLoops();
    window.dispatchEvent(new Event('fbselection'));
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
    pickBeat(beat);
    onBeat(beat);
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

// alphaTab reports the position ~300 times a second; the screen only needs the clock when its
// text changes and the chord / tempo / section / lyrics a few dozen times a second. (Each DOM
// write repaints the blurred play bar, which is what costs a phone its smoothness.)
let shownClock = '';
let shownSeek = -1;
let lastInfoAt = 0;

let seekHold = null; // after a jump, the bar stays where you put it until the song gets there
function onPosition(e) {
  endTime = e.endTime;
  const clock = `${formatClock(e.currentTime)} / ${formatClock(e.endTime)}`;
  if (clock !== shownClock) { shownClock = clock; $('pl-time').textContent = clock; }
  const seek = e.endTime ? Math.round((e.currentTime / e.endTime) * 1000) : 0;
  if (seekHold && (performance.now() > seekHold.until || Math.abs(seek - seekHold.value) < 15)) seekHold = null;
  if (!seeking && !seekHold && seek !== shownSeek) { shownSeek = seek; $('pl-seek').value = seek; }
  const now = performance.now();
  if (e.isSeek || now - lastInfoAt >= 40) {
    lastInfoAt = now;
    showChordAt(e.currentTick);
    showTempoAt(e.currentTick);
    showSectionAt(e.currentTick);
    showLyricsAt(e.currentTick);
  }
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

// Scrolls the tab to the line the playhead is on. The cursor itself isn't placed until playback
// starts (so scrollToCursor does nothing during a count-in); the line's bounds are known earlier.
function scrollToPlayhead() {
  const bars = playedBars();
  const box = $('score-scroll');
  const systems = api.renderer?.boundsLookup?.staffSystems;
  const mb = bars[currentBarIndex()]?.masterBar.index;
  const line = mb === undefined ? null : systems?.find((sys) => sys.bars.some((b) => b.index === mb));
  if (line && box) {
    const top = line.visualBounds.y + $('alphatab').getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTo({ top: Math.max(0, top - 40), behavior: 'instant' });
    return;
  }
  api.scrollToCursor?.();
}

// While the video pop-up covers the bottom of the tab, the cursor's line is brought to the top before
// it gets under the pop-up, so the playhead is always in view.
// Pinning the music's start: with a bar selected and the video open, the tab holds still while the
// video plays (the cursor still moves), so the bar you are matching stays where you can see it.
let frozenTop = null;
let userScrolled = 0;
let playheadCtl = null;
let holdScroll = false;
let pinnedBar = null; // a bar you locked as the spot the video's music starts at
const frozen = () => pinnedBar !== null || holdScroll || document.body.classList.contains('has-range') && document.body.classList.contains('video-open') && !document.body.classList.contains('edit-mode');
function initScrollHold() {
  const box = $('score-scroll');
  const touch = () => { userScrolled = Date.now(); };
  ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown'].forEach((t) => box.addEventListener(t, touch, { passive: true }));
  box.addEventListener('scroll', () => {
    if (!frozen()) { frozenTop = null; return; }
    if (Date.now() - userScrolled < 600) { frozenTop = box.scrollTop; return; } // you moved it: that is the new place to hold
    if (frozenTop === null) frozenTop = box.scrollTop;
    else if (Math.abs(box.scrollTop - frozenTop) > 1) box.scrollTop = frozenTop;
  }, { passive: true });
}

function keepPlayheadInView() {
  if (frozen()) return;
  const pop = $('pa-video');
  if (!document.body.classList.contains('video-open') || pop.hidden) return;
  const cur = document.querySelector('#alphatab .at-cursor-bar, #alphatab .at-cursor-beat');
  const box = $('score-scroll');
  if (!cur || !box) return;
  const c = cur.getBoundingClientRect();
  const limit = pop.getBoundingClientRect().top - 8;
  if (c.bottom > limit || c.top < box.getBoundingClientRect().top) box.scrollBy({ top: c.top - box.getBoundingClientRect().top - 40, behavior: 'instant' });
}

// Starts playback from the current position, with the count-in if it's on.
function startPlayback() {
  if (!api || !readyForPlayback || counting) return;
  scrollToPlayhead(); // show the playhead right away, so the count-in happens where the song will start
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

/* ---------- natural strums ---------- */

const strumOn = () => { try { return localStorage.getItem('fretboard.strum') !== 'off'; } catch { return true; } };

function strumGuitars(midiFile) {
  if (!strumOn()) return;
  try {
    const barStarts = api.tickCache ? api.tickCache.masterBars.map((b) => b.start) : [];
    humanize(midiFile.tracks.flatMap((t) => t.events), { barStarts });
    for (const t of midiFile.tracks) t.events.sort((a, b) => a.tick - b.tick); // stable
  } catch (e) {
    console.warn('Strums skipped', e); // playback still works, just with straight chords
  }
}

function padSustain(midiFile) {
  try {
    if (sustainPads(midiFile.tracks.flatMap((t) => t.events))) for (const t of midiFile.tracks) t.events.sort((a, b) => a.tick - b.tick);
  } catch (e) {
    console.warn('Pad sustain skipped', e);
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
let chordSource = 'none'; // 'sheet' | 'file' | 'guess' | 'none'
let chordTimeline = { bars: null, list: [] };

function prepareChords(sc) {
  chordBars = null;
  chordSource = 'none';
  sheetMove = (song?.transpose || 0) - (sc.tracks[trackIndex]?.staves[0]?.capo || 0);
  try {
    // a chord sheet saved with the song (Ultimate Guitar's chords), lined up with the sung words
    const bars = song?.chordSheet ? barSpans(sc) : null;
    const fromSheet = bars ? sheetChords(song.chordSheet, sungWords(sc, bars), bars) : null;
    if (fromSheet?.some((b) => b.all.length)) {
      // a sheet in another key, or written for a capo, is moved to the key the song plays in (as shapes for its capo)
      const move = sheetKeyShift(sc, fromSheet) - (sc.tracks[trackIndex]?.staves[0]?.capo || 0);
      if (move % 12) for (const b of fromSheet) for (const c of new Set([...b.all, ...b.shown])) c.name = shiftChordName(c.name, move, shiftFlats);
      for (const t of sc.tracks) for (const st of t.staves) for (const b of st.bars) for (const v of b.voices) for (const bt of v.beats) bt.chordId = null;
      injectChords(sc, fromSheet, AT.model.Chord);
      chordSource = 'sheet';
      chordBars = fromSheet;
      sheetMove = move;
    } else if (scoreHasChords(sc)) {
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

// The chord sheet view: the song's chord sheet (chords over the words) in place of the tab, in the
// key the tab plays in. Chosen with Chords beside Tab / Both / Notes, or the Chords badge in the library.
let chordView = false;
let sheetMove = 0; // semitones from the sheet's chord names to the song's

function showChordView() {
  const has = !!song?.chordSheet;
  const on = chordView && has;
  $('score-scroll').hidden = on;
  $('pl-chordsheet').hidden = !on;
  if (on) $('pl-loading').hidden = true; // the tab is drawn when it's shown again
  document.querySelector('#qk-stave [data-stave=chords]').hidden = !has;
  if (on) $('pl-chordsheet').innerHTML = highlight(song.chordSheet, sheetMove % 12 ? (c) => shiftChordName(c, sheetMove, shiftFlats) : null);
  showStave();
}

function showStave() {
  const shown = chordView && song?.chordSheet ? 'chords' : $('pl-stave').value;
  document.querySelectorAll('#qk-stave [data-stave]').forEach((b) => b.classList.toggle('on', b.dataset.stave === shown));
}

function showChordSettings() {
  $('pl-chords-src').textContent = {
    sheet: 'Chord names come from the song’s chord sheet, lined up with the words. Edit them under Edit › Chord sheet.',
    file: 'Chord names come from the file.',
    guess: 'This file has no chord names, so they are guessed from the notes of all tracks. Treat them as a hint.',
    none: 'No chords found in this song.',
  }[chordSource];
  $('pl-chord').hidden = !chordsOn() || chordSource === 'none';
}

// Where the tab is from and which version: the line under the title and the Tab info sheet.
function showTabInfo() {
  const line = song ? sourceLine(song) : '';
  const a = $('pl-source');
  a.hidden = !line;
  a.textContent = line;
  const href = song?.sourceUrl && parseSource(song.sourceUrl) ? song.sourceUrl : '';
  if (href) a.href = href; else a.removeAttribute('href');
  if (document.activeElement !== $('ti-url')) $('ti-url').value = song?.sourceUrl || '';
  if (document.activeElement !== $('ti-note')) $('ti-note').value = song?.versionNote || '';
  const p = song?.sourceUrl ? parseSource(song.sourceUrl) : null;
  $('ti-parsed').textContent = !song?.sourceUrl ? '' : !p ? 'That doesn’t look like a web link.'
    : [p.site, p.type, p.version ? `version ${p.version}` : '', p.artist && p.song ? `${p.artist} – ${p.song}` : ''].filter(Boolean).join(' · ');
  const dl = $('ti-facts');
  dl.textContent = '';
  for (const [k, v] of tabFacts(song, score)) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
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
  $('pl-speed').value = Math.max(25, Math.min(175, percent)); // the slider has 100% in the middle
  timer.noteSpeed(Math.round(percent));
  updateBpm();
  if (save && song) updateSong(song.id, { speed: percent });
}

// Tempo as BPM: the speed field shows and takes the song's tempo in BPM at this speed.
function setBpm(bpm) {
  setSpeed((bpm / baseTempo) * 100);
}

// Hold the tempo number and drag sideways: right is faster, left slower, a BPM per 6 pixels.
// A plain tap still lets you type.
const SPEED_STOPS_PCT = [10, 25, 50, 75, 100];
function scrubBpm(input) {
  let start = null;
  let moved = false;
  let lastStop = null;
  input.addEventListener('pointerdown', (e) => {
    if (isLive() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    start = { x: e.clientX, bpm: Math.round((baseTempo * speedPct) / 100), id: e.pointerId };
    moved = false;
  });
  input.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    if (!moved) {
      if (Math.abs(dx) < 6) return;
      moved = true;
      input.setPointerCapture(e.pointerId);
      input.blur();
      input.classList.add('scrubbing');
    }
    // Magnets at the usual practice speeds: the number sticks to 10, 25, 50, 75 and 100% of the
    // song's tempo until you drag a little past.
    const want = start.bpm + dx / 6;
    const pct = (want / baseTempo) * 100;
    const stop = SPEED_STOPS_PCT.find((p) => Math.abs(pct - p) <= 2.5);
    if (stop !== undefined) {
      if (stop !== lastStop) navigator.vibrate?.(8);
      lastStop = stop;
      setSpeed(stop);
    } else {
      lastStop = null;
      setBpm(Math.round(want));
    }
  });
  const end = () => { start = null; input.classList.remove('scrubbing'); };
  input.addEventListener('pointerup', end);
  input.addEventListener('pointercancel', end);
  // A drag is not a tap: keep it from putting the cursor in the field.
  input.addEventListener('click', (e) => { if (moved) { e.preventDefault(); input.blur(); moved = false; } });
  input.addEventListener('focus', () => { if (moved) input.blur(); });
}

function updateBpm() {
  const bpm = Math.round((baseTempo * speedPct) / 100);
  if (document.activeElement !== $('pl-bpm-input')) $('pl-bpm-input').value = bpm;
  const pct = Math.round(speedPct);
  $('pl-speed-val').textContent = speedPct === 100 ? `${bpm} BPM, the song's own speed` : `${bpm} BPM: ${pct}% of the song's ${Math.round(baseTempo)}`;
  $('pl-speed-pct').textContent = pct + '%';
  $('pl-tempo-open-txt').textContent = `♩ ${bpm}${pct === 100 ? '' : ` · ${pct}%`}`;
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
// Tab is for fretted parts only: guitars and basses (by instrument or by name). Vocals, keys,
// strings, synths and the rest are always shown as standard notation, even when the file
// gives them a tab staff (UG PDFs and some Guitar Pro files do).
const FRETTED_NAME = /guitar|gtr|\bbass\b|ukulele|banjo|mandolin/i;
const NOT_FRETTED_NAME = /vocal|voice|sing|piano|key|synth(?!.*bass)|string|violin|cello|organ|pad|horn|sax|trumpet|flute|choir/i;
function isFretted(track) {
  if (!hasTab(track) || isDrums(track)) return false;
  const name = track.name || '';
  if (FRETTED_NAME.test(name)) return true;
  if (NOT_FRETTED_NAME.test(name)) return false;
  const program = track.playbackInfo?.program ?? -1;
  return program >= 24 && program <= 39 || (program >= 104 && program <= 107); // guitars, basses, sitar/banjo/shamisen/koto
}

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

// The starting mix: vocals on top, lead guitar and drums next, then bass, keys, rhythm
// guitars and synths (js/mixlevels.js).
let mixDefaults = [];
function defaultMix(sc) {
  mixDefaults = autoLevels(sc.tracks.map((t) => ({
    name: t.name, program: t.playbackInfo?.program, drums: isDrums(t), volume: t.playbackInfo?.volume,
  })));
  return sc.tracks.map((t, i) => ({ mute: false, solo: false, volume: mixDefaults[i] }));
}
const mixChanged = () => mix.some((m, i) => m.mute || m.solo || Math.abs(m.volume - (mixDefaults[i] ?? 1)) > 0.005);

function loadMix(sc, saved) {
  mix = defaultMix(sc);
  if (Array.isArray(saved) && saved.length === sc.tracks.length) {
    // Volumes saved before the automatic mix existed are all 100%: those songs get it too.
    const ownVolumes = saved.some((m) => Number.isFinite(m.volume) && m.volume !== 1);
    saved.forEach((m, i) => Object.assign(mix[i], { mute: !!m.mute, solo: !!m.solo, ...(ownVolumes ? { volume: Number.isFinite(m.volume) ? m.volume : 1 } : {}) }));
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
    api.changeTrackVolume([t], mix[i].volume * (i === trackIndex ? 1 : othersLevel()));
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
    row.querySelector('small').textContent = isFretted(track) ? '' : 'notation';
    list.append(row);
  });
  // parts written as standard notation (piano, drums...) are kept as their PDF pages
  (song?.sheets || []).forEach((s, k) => {
    const row = document.createElement('a');
    row.className = 'sheet-row';
    row.href = `#song/${song.id}/sheet/${k}`;
    row.title = 'Show this part as sheet music';
    row.innerHTML = '<span class="ticon">📄</span><span class="tname"></span><small>sheet music</small>';
    row.querySelector('.tname').textContent = s.name;
    list.append(row);
  });
  applyMix();
}

// "Other parts": every track but the one shown is turned down by this much (0..1), so you
// hear your own part clearly. Kept between songs.
let othersVol = (() => { try { const v = Number(localStorage.getItem('fretboard-others')); return localStorage.getItem('fretboard-others') === null || !(v >= 0 && v <= 1) ? 1 : v; } catch { return 1; } })();
const othersLevel = () => othersVol;

// The Tracks sheet's master slider shows the song volume (set here or in the Amp panel).
function showMaster() {
  $('pl-master').value = $('amp-song-vol').value;
  $('pl-master-val').textContent = $('amp-song-vol').value + '%';
  $('pl-others').value = Math.round(othersLevel() * 100);
  $('pl-others-val').textContent = Math.round(othersLevel() * 100) + '%';
  const t = score?.tracks[trackIndex];
  $('pl-others-note').textContent = t ? 'all but ' + trackLabel(t, trackIndex) : '';
}

function showMix() {
  showMaster();
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
  $('pl-mixer-note').textContent = mixChanged() ? '' : 'Vocals are set loudest, then lead guitar and drums. Click a name to show that track. M = mute, S = solo (you can solo several).';
  $('pl-mix-reset').hidden = !mixChanged() && $('amp-song-vol').value === '100' && othersVol === 1;
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
  if (act === 'show') { selectTrack(i); closeSheets(); } // picked: the menu goes away
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
  const playable = (t) => isFretted(t) && instrumentOf(t) !== 'Bass'
    && !/bass|drum|vocal|voice|sing|percussion/i.test(t.name || '');
  for (const ok of [(t) => playable(t) && instrumentOf(t) === 'Guitar', playable, isFretted, hasTab]) {
    const i = sc.tracks.findIndex(ok);
    if (i !== -1) return i;
  }
  return 0;
}

// Guitar and bass parts follow the Notation setting (tab by default). Every other part
// (vocals, keys, drums, strings...) is shown as standard notation.
function applyStaveProfile() {
  const track = score?.tracks[trackIndex];
  const wanted = $('pl-stave').value;
  const noTab = track && !isFretted(track);
  $('pl-notab').hidden = !noTab;
  $('qk-stave').hidden = !!noTab; // Tab / Both / Notes only means something for a guitar or bass part
  const profile = noTab ? 'score' : wanted;
  api.settings.display.staveProfile = { tab: AT.StaveProfile.Tab, default: AT.StaveProfile.Default, score: AT.StaveProfile.Score }[profile];
  // Tab only: draw the rhythm (stems and beams) under the tab, like Songsterr.
  api.settings.notation.rhythmMode = profile === 'tab' ? AT.TabRhythmMode.ShowWithBars : AT.TabRhythmMode.Automatic;
  // "Guitar Standard Tuning" above a synth or vocal part would be wrong.
  api.settings.notation.elements.set(AT.NotationElement.GuitarTuning, !noTab);
  api.updateSettings();
  showTrackInfo();
}

// "Tuning: E A D G B E · Key: E · Capo: none" for the current track.
function showTrackInfo() {
  const staff = score?.tracks[trackIndex]?.staves[0];
  const parts = [];
  const fretted = score?.tracks[trackIndex] && isFretted(score.tracks[trackIndex]);
  if (staff && fretted) {
    parts.push('Tuning: ' + [...staff.tuning].reverse().map((m) => noteName(m % 12, true)).join(' '));
  }
  // Transposed or retuned: the key it plays in now, and the song's own.
  const moved = (song?.transpose || 0) + (song?.tune || 0);
  const key = songKey();
  const original = key && moved ? keyLabel({ ...key, tonic: ((key.tonic - moved) % 12 + 12) % 12 }) : '';
  if (key) parts.push('Key: ' + keyLabel(key) + (original ? ` (original ${original})` : ''));
  if (staff && fretted) parts.push('Capo: ' + (staff.capo ? `fret ${staff.capo}` : 'none'));
  $('pl-info').textContent = parts.join(' · ');
  const keyBadge = $('pl-key-badge');
  keyBadge.hidden = !original;
  keyBadge.textContent = original ? `Not the original key: ${keyLabel(key)} (was ${original})` : '';
  // The focus view shows just the key, and the capo when there is one.
  const capoBadge = $('pl-capo-badge');
  capoBadge.hidden = !(fretted && staff?.capo > 0);
  capoBadge.textContent = staff?.capo > 0 ? `Capo ${staff.capo}` : '';
  $('pl-info').dataset.short = [songKey() ? 'Key ' + keyLabel(songKey()) : '', staff?.capo ? `Capo ${staff.capo}` : ''].filter(Boolean).join(' · ');
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
  const score = parseScore(s);
  ownDrumChannels(score.tracks); // a shaker beside the drums gets its own volume and mute
  return score;
}

function parseScore(s) {
  if (s.kind === 'text' || s.kind === 'tex') {
    let tex = s.data;
    if (s.kind === 'text') {
      const opts = { title: s.title, artist: s.artist, tempo: s.tempo };
      // a guitar tab with its bass tab (combined on import): a track each
      const converted = s.parts?.length
        ? asciiTabsToAlphaTex([{ name: s.part || 'Guitar', text: s.data }, ...s.parts.map((p) => ({ name: p.name, text: p.data }))], opts)
        : asciiTabToAlphaTex(s.data, opts);
      if (!converted) throw new Error('No tab lines found in this text (chord sheets can’t be played).');
      tex = converted.tex;
    }
    tex = tex.replace(/\\staff \{tabs\}/g, '\\staff {score tabs}'); // so Notation / Both work on songs saved before
    const importer = new AT.importer.AlphaTexImporter();
    importer.initFromString(tex, api.settings);
    const parsed = importer.readScore();
    // a shaker or other hand percussion sits far above a drum staff in alphaTab: draw it on the middle line
    for (const t of parsed.tracks) {
      t.percussionArticulations = t.percussionArticulations.map((a) => (a.staffLine < -8 ? Object.assign(Object.create(Object.getPrototypeOf(a)), a, { staffLine: 4 }) : a));
    }
    return parsed;
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
  chordView = location.hash.split('/')[2] === 'chords'; // the library's Chords badge
  showChordView();
  holdScroll = false;
  pinnedBar = null;
  $('pin-marker')?.remove();
  frozenTop = null;
  score = null;
  mix = [];
  cancelCountIn();
  readyForPlayback = readyForPlayback && !!api;
  $('pl-title').textContent = s.title;
  describeSong(s.title, s.artist);
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
  fileTuning = [...(parsed.tracks[trackIndex]?.staves[0]?.tuning || [])];
  shiftFlats = transposeScore(parsed, { semitones: song.transpose || 0, capo: song.capo ?? null, capoTrack: trackIndex, retune: song.tune || 0 }).flats;
  score = parsed;
  prepareChords(parsed);
  singSongChanged();
  judgeSongChanged();
  applyChordVisibility();
  applyStaveProfile();
  showChordView();
  api.renderScore(parsed, [trackIndex]);
}

/* ---------- transpose and capo ---------- */

let fileCapo = 0; // the capo the file has on the shown track
let fileTuning = []; // the shown track's tuning as the file has it (song.tune moves it)
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
  $('qk-val').textContent = $('tp-val').textContent;
  $('qk-down').disabled = semis <= -11;
  $('qk-up').disabled = semis >= 11;
  $('tp-down').disabled = semis <= -11;
  $('tp-up').disabled = semis >= 11;
  $('capo-down').disabled ||= capo <= 0;
  $('capo-up').disabled ||= capo >= 12;
  $('tp-reset').hidden = !semis && !song?.tune && (song?.capo == null || song.capo === fileCapo);
  // Tunings with the same frets: the file's, and up to 3 semitones down or up (Eb standard → E standard).
  const tune = song?.tune || 0;
  const names = (d) => [...fileTuning].reverse().map((m) => noteName((m + d) % 12, true)).join(' ');
  const sel = $('tune-sel');
  sel.disabled = !canCapo() || !fileTuning.length;
  sel.replaceChildren(...(sel.disabled ? [0] : [-3, -2, -1, 0, 1, 2, 3]).map((d) => {
    const o = document.createElement('option');
    o.value = String(d);
    o.textContent = !fileTuning.length ? '–' : names(d) + (d ? ` (${d > 0 ? '+' : '−'}${Math.abs(d)})` : ' (original)');
    return o;
  }));
  sel.value = String(sel.disabled ? 0 : tune);
  const notes = [];
  if (tune) notes.push(`File: ${names(0)}`);
  if (song?.capo != null && song.capo !== fileCapo) notes.push(`File: capo ${fileCapo || 'none'}`);
  if (semis && recordingOn()) notes.push('The recording keeps its pitch');
  $('tp-note').textContent = notes.join(' · ');
}

function setShift(changes) {
  if (!song || !score) return;
  Object.assign(song, changes);
  if (song.capo === fileCapo) song.capo = null; // the file's own capo
  updateSong(song.id, { transpose: song.transpose || 0, capo: song.capo ?? null, tune: song.tune || 0 });
  reloadScore();
}

/* ---------- sections ---------- */

let sections = []; // [{ index (master bar), end (master bar after it), el }]
let shownSection = null;

// Each section's name at the bar it begins, drawn over the score (alphaTab's own marker is
// switched off while chords show, since it covers the first chord).
// The pinned bar: an orange block over it (with an ✕ to unpin) that stays until you unpin or link.
function drawPin() {
  let el = $('pin-marker');
  if (pinnedBar === null) { el?.remove(); return; }
  const systems = api?.renderer?.boundsLookup?.staffSystems;
  const sys = systems?.find((s) => s.bars.some((b) => b.index === pinnedBar));
  const bar = sys?.bars.find((b) => b.index === pinnedBar);
  if (!bar) { el?.remove(); return; }
  const box = bar.realBounds || bar.visualBounds;
  const sysBox = sys.realBounds || sys.visualBounds;
  if (!el) {
    el = document.createElement('div');
    el.id = 'pin-marker';
    el.innerHTML = '<span class="pin-tag">📍 Music starts here <button type="button" class="pin-x" aria-label="Unpin">✕</button></span>';
    el.querySelector('.pin-x').addEventListener('click', (e) => { e.stopPropagation(); setPin(null); });
    $('sec-labels').parentElement.append(el);
  }
  const at = $('alphatab');
  Object.assign(el.style, { left: `${at.offsetLeft + box.x}px`, top: `${at.offsetTop + sysBox.y}px`, width: `${box.w}px`, height: `${sysBox.h}px` });
}

function setPin(masterIndex) {
  pinnedBar = masterIndex;
  drawPin();
  if (masterIndex !== null) {
    playheadCtl?.lock(false);
    const mb = score?.masterBars[masterIndex];
    if (mb) moveTo(mb.start); // the playhead goes to the pinned bar, then stays there (red)
    scrollBarToTop(masterIndex, false);
    setTimeout(() => { if (pinnedBar === masterIndex) playheadCtl?.lock(true); }, 200);
  } else {
    playheadCtl?.lock(false);
    frozenTop = null;
  }
  window.dispatchEvent(new CustomEvent('fbpin', { detail: masterIndex }));
}

function drawSectionLabels() {
  const layer = $('sec-labels');
  layer.textContent = '';
  const systems = api?.renderer?.boundsLookup?.staffSystems;
  if (!systems || !sections.length) return;
  const at = $('alphatab');
  for (const sec of sections) {
    const sys = systems.find((s) => s.bars.some((b) => b.index === sec.index));
    const bar = sys?.bars.find((b) => b.index === sec.index);
    if (!bar || sec.index === 0) continue; // the title block already sits above bar 1
    const box = bar.realBounds || bar.visualBounds;
    const top = Math.max(18, (sys.visualBounds || sys.realBounds).y);
    const el = document.createElement('span');
    el.className = 'sec-label';
    el.textContent = sec.el.textContent.trim();
    el.style.left = `${at.offsetLeft + box.x}px`;
    el.style.top = `${at.offsetTop + top}px`;
    layer.append(el);
  }
}

function buildSections() {
  const nav = $('pl-sections');
  showLoops(); // the song's saved loops come with its sections
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
function scrollBarToTop(masterIndex, smooth = true) {
  const go = () => {
    const systems = api?.renderer?.boundsLookup?.staffSystems;
    const sys = systems?.find((s) => s.bars.some((b) => b.index === masterIndex));
    if (!sys) return;
    const box = $('score-scroll');
    const offset = $('alphatab').getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    const bounds = sys.realBounds || sys.visualBounds;
    box.scrollTo({ top: Math.max(0, offset + bounds.y - 12), behavior: smooth ? 'smooth' : 'instant' });
    if (!smooth) frozenTop = box.scrollTop;
  };
  // After alphaTab has moved the cursor (and done any scrolling of its own).
  setTimeout(go, 60);
}

function loopSection(sec) {
  const range = sectionBars(sec);
  if (!range) return;
  loopRange(range, sec);
}

// range: { first, last } played bars. sec: the section chip to mark as looped (if any).
function loopRange(range, sec = null) {
  if (!readyForPlayback) return;
  const staff = score.tracks[trackIndex].staves[0];
  const startBeat = staff.bars[range.first.masterBar.index]?.voices[0]?.beats[0];
  const endBeat = staff.bars[range.last.masterBar.index]?.voices[0]?.beats.at(-1);
  if (startBeat && endBeat && api.highlightPlaybackRange) {
    api.highlightPlaybackRange(startBeat, endBeat);
    api.applyPlaybackRangeFromHighlight?.();
  }
  api.playbackRange = { startTick: range.first.start, endTick: range.last.end };
  document.body.classList.add('has-range');
  showLoops();
  sections.forEach((x) => x.el.classList.toggle('looped', x === sec));
  setLoop(true);
  moveTo(range.first.start);
  scrollBarToTop(range.first.masterBar.index);
}

/* ---------- saved loops ---------- */

// Your trouble spots, kept with the song: a chip per saved bar range (tap to loop it), and a chip to
// save the range you have selected. Stored as played-bar numbers, { name, a, b }.
function selectedBars() {
  const r = api?.playbackRange;
  const bars = playedBars();
  if (!r || !bars.length) return null;
  const a = bars.findIndex((b) => b.end > r.startTick);
  let z = a;
  bars.forEach((b, i) => { if (i >= a && b.start < r.endTick) z = i; });
  return a < 0 ? null : { a, b: z };
}

function showLoops() {
  const nav = $('pl-loops');
  if (!nav) return;
  const saved = song?.loops || [];
  const sel = selectedBars();
  const dup = sel && saved.some((l) => l.a === sel.a && l.b === sel.b);
  nav.hidden = !saved.length && !(sel && !dup);
  nav.innerHTML = (sel && !dup ? '<button class="loop-chip save" data-save>＋ Save loop</button>' : '')
    + saved.map((l, i) => `<span class="loop-chip"><button data-loop="${i}">${l.name.replace(/[&<>"]/g, '')}</button><button class="x" data-del="${i}" aria-label="Delete ${l.name.replace(/[&<>"]/g, '')}">✕</button></span>`).join('');
}

function saveLoop() {
  const sel = selectedBars();
  const bars = playedBars();
  if (!sel || !song) return;
  const name = sel.a === sel.b ? `Bar ${bars[sel.a].masterBar.index + 1}` : `Bars ${bars[sel.a].masterBar.index + 1}–${bars[sel.b].masterBar.index + 1}`;
  song.loops = [...(song.loops || []), { name, a: sel.a, b: sel.b }].sort((x, y) => x.a - y.a);
  updateSong(song.id, { loops: song.loops });
  showLoops();
}

function initLoops() {
  $('pl-loops').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || !song) return;
    if (t.hasAttribute('data-save')) { saveLoop(); return; }
    if (t.dataset.del !== undefined) {
      song.loops.splice(Number(t.dataset.del), 1);
      updateSong(song.id, { loops: song.loops });
      showLoops();
      return;
    }
    const l = song.loops?.[Number(t.dataset.loop)];
    const bars = playedBars();
    if (l && bars[l.a] && bars[l.b]) loopRange({ first: bars[l.a], last: bars[l.b] });
  });
}

/* ---------- instrument view (learning mode) ---------- */

// Under the score: how to play the beat under the cursor (or under the mouse / a tapped note)
// on the track's own instrument. A neck for guitar and bass, keys for every other pitched
// part, a drum kit for drums.
const fretboardOn = () => $('pl-fretboard').checked;
let viewKind = null; // 'neck' | 'keys' | 'drums' | 'shaker'
let playedBeat = null;

const trackNotes = (staff) => {
  const out = [];
  for (const bar of staff.bars) for (const v of bar.voices) for (const b of v.beats) for (const n of b.notes) out.push(n);
  return out;
};
const octaveName = (m) => noteName(m % 12, shiftFlats) + (Math.floor(m / 12) - 1);

function showNeck() {
  const track = score?.tracks[trackIndex];
  const staff = track?.staves[0];
  const on = fretboardOn() && !!staff;
  $('pl-fretview').hidden = !on;
  setNeck(null); setKeys(null); setShaker(false); setKit(false);
  viewKind = null;
  if (on) {
    const shaken = staff.isPercussion && handPercussion(track);
    if (shaken) {
      viewKind = 'shaker';
      setShaker(true, shaken);
    } else if (staff.isPercussion) {
      viewKind = 'drums';
      setKit(true);
    } else if (staff.tuning.length > 0 && isFretted(track)) {
      viewKind = 'neck';
      let high = 0;
      for (const n of trackNotes(staff)) if (n.fret > high) high = n.fret;
      const capo = staff.capo || 0;
      setNeck({
        strings: staff.tuning.length,
        frets: high + capo > 15 ? Math.min(24, Math.max(19, high + capo + 1)) : 15,
        names: [...staff.tuning].reverse().map((m) => noteName(m % 12, shiftFlats)),
        capo,
      });
    } else {
      viewKind = 'keys';
      setKeys(keyRange(trackNotes(staff).map((n) => n.realValue).filter((m) => m > 0)), octaveName);
    }
  }
  const kit = viewKind === 'drums' || viewKind === 'shaker';
  for (const [id, on] of [['pl-neck', viewKind === 'neck'], ['pl-keys', viewKind === 'keys'], ['pl-drums', kit]]) $(id).hidden = !on;
  $('pl-fretview').classList.toggle('over-music', kit); // the kit floats over the bottom of the music
  document.body.classList.toggle('kit-over', kit); // room under the last line of music
  // the play bar's button for it, named for what this track shows
  $('pl-howto').hidden = !staff;
  $('pl-howto').textContent = !staff ? 'Neck' : staff.isPercussion ? 'Drums' : staff.tuning.length > 0 && isFretted(track) ? 'Neck' : 'Keys';
  $('pl-howto').classList.toggle('on', on);
  onBeat(playedBeat?.voice?.bar?.staff?.track?.index === trackIndex ? playedBeat : null);
}

// A percussion track of only shaken hand percussion (shaker, tambourine...): its name, else ''.
function handPercussion(track) {
  const notes = trackNotes(track.staves[0]);
  if (!notes.length || !notes.every((n) => SHAKEN.has(drumNote(n)))) return '';
  if (/shaker|tamb|maraca|cabasa/i.test(track.name || '')) return track.name;
  return { 82: 'Shaker', 54: 'Tambourine', 70: 'Maracas', 69: 'Cabasa' }[drumNote(notes[0])];
}
// Down or up for a shaker hit: strokes alternate on the bar's finest beat (16ths, else 8ths),
// down on the beat, up between, the way a shaker is played.
function shakeDir(beat) {
  let grid = 480;
  for (const b of beat.voice.beats) if (b.notes.length && b.playbackDuration > 0) grid = Math.min(grid, b.playbackDuration);
  grid = Math.max(240, grid);
  return Math.round(beat.playbackStart / grid) % 2 ? 'up' : 'down';
}
// The count a hit falls on: "2", "2 e", "2 &", "2 a".
function countOf(beat) {
  const pos = beat.playbackStart;
  const sub = Math.round((pos % 960) / 240);
  return `${Math.floor(pos / 960) + 1}${['', ' e', ' &', ' a'][sub] ?? ''}`;
}

// The MIDI drum note of a drum note: the track's own articulation list, else the Guitar Pro id.
const drumNote = (n) => {
  const list = n.beat?.voice?.bar?.staff?.track?.percussionArticulations || [];
  const a = list[n.percussionArticulation];
  return a?.outputMidiNumber > 0 ? a.outputMidiNumber : drumMidi(n.percussionArticulation);
};
// A tied drum note isn't hit again.
const sounding = (beat) => (beat?.notes || []).filter((n) => !(n.isTieDestination && viewKind === 'drums'));

// How loud a note is played (MIDI velocity, as alphaTab plays it) shown as how solid its key
// is lit: pianissimo is faint, fortissimo solid.
const VELOCITY = [15, 31, 47, 63, 79, 95, 111, 127, 10, 5, 3, 127, 127, 127];
function noteLevel(n) {
  let v = VELOCITY[n.dynamics] ?? 111;
  if (n.isGhost) v -= 16;
  if (n.accentuated === 1) v += 16; else if (n.accentuated === 2) v += 32;
  v = Math.max(1, Math.min(127, v));
  return Math.round((0.25 + 0.75 * Math.sqrt(Math.max(0, v - 15) / 112)) * 100) / 100; // mf 0.82, p 0.65, ppp 0.25
}
// What the key turns to while the note sounds: a held note stays as solid as it started; a
// diminuendo (or a fade out) fades it, a crescendo (or fade in) makes it more solid.
function loudness(n, ms) {
  const level = noteLevel(n);
  const b = n.beat;
  let to = level;
  const after = b.nextBeat?.notes?.[0];
  const nextLevel = after ? noteLevel(after) : null;
  if (b.crescendo === 2 || b.fade === 2) to = nextLevel != null && nextLevel < level ? nextLevel : Math.max(0.15, level - 0.35);
  else if (b.crescendo === 1 || b.fade === 1) to = nextLevel != null && nextLevel > level ? nextLevel : Math.min(1, level + 0.35);
  return { level, to, ms };
}
// How long a beat lasts at the current tempo and speed (ms).
function beatMs(beat) {
  let tempo = score?.tempo || 120;
  for (let i = beat.voice.bar.masterBar.index; i >= 0; i--) {
    const t = score.masterBars[i]?.tempoAutomations;
    if (t?.length) { tempo = t[t.length - 1].value; break; }
  }
  return (beat.playbackDuration / 960) * (60000 / tempo) / (api?.playbackSpeed || 1);
}

function onBeat(beat) {
  if ($('pl-fretview').hidden || !viewKind) return;
  if (beat && beat.voice?.bar?.staff?.track?.index !== trackIndex) return;
  let next = beat?.nextBeat;
  while (next && !next.notes.length && next.nextBeat) next = next.nextBeat;
  if (viewKind === 'neck') {
    const frets = (b) => sounding(b).filter((n) => n.fret >= 0 && n.string >= 1).map((n) => ({ string: n.string, fret: n.fret }));
    showNotes(frets(beat), frets(next));
  } else if (viewKind === 'keys') {
    const keys = (b) => sounding(b).map((n) => n.realValue).filter((m) => m > 0);
    const ms = api?.playerState === PLAYING && beat === playedBeat ? beatMs(beat) : 0;
    showKeys(sounding(beat).filter((n) => n.realValue > 0).map((n) => ({ m: n.realValue, ...loudness(n, ms) })), keys(next));
  } else if (viewKind === 'shaker') {
    const hit = (b) => !!b && sounding(b).length > 0;
    const ms = api?.playerState === PLAYING && beat === playedBeat ? beatMs(beat) : 150;
    showShake(hit(beat) ? shakeDir(beat) : null, hit(next) ? shakeDir(next) : null, hit(beat) ? countOf(beat) : '', ms);
  } else {
    const hits = (b) => sounding(b).map(drumNote);
    showDrums(hits(beat), hits(next));
  }
}

// Hovering a note (while stopped or paused) shows it; leaving the score goes back to the cursor.
function hoverNotes(surface) {
  let frame = 0;
  let hovered = null;
  let last = null;
  surface.addEventListener('mousemove', (e) => {
    last = e;
    if (frame || $('pl-fretview').hidden || api?.playerState === PLAYING) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const at = surface.querySelector('.at-surface') || surface;
      const r = at.getBoundingClientRect();
      const beat = api?.renderer?.boundsLookup?.getBeatAtPos(last.clientX - r.left, last.clientY - r.top);
      if (!beat || beat === hovered) return;
      hovered = beat;
      onBeat(beat);
    });
  });
  surface.addEventListener('mouseleave', () => {
    if (!hovered) return;
    hovered = null;
    if (api?.playerState !== PLAYING) onBeat(playedBeat);
  });
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
  $('pl-lyr-btn').hidden = track === -1;
  $('pl-lyr-btn').classList.toggle('on', on);
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
  keepScreenOn(false);
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
  moveTo(api.playbackRange ? api.playbackRange.startTick : videoStartTick());
}

function setLoop(on) {
  toggleButton('pl-loop', on);
  if (api) api.isLooping = on;
}

// On a phone a drag scrolls the page, so alphaTab's drag-to-select never fires. Instead: press
// and hold a bar until the phone buzzes, then slide to the last bar you want (the page
// scrolls when your finger nears its top or bottom edge); lifting your finger loops those bars.
function initTouchSelect() {
  const box = $('score-scroll');
  let timer = 0;
  let from = null; // first bar of the selection, once the hold has registered
  let at = null; // where the touch started, then where it is now
  let raf = 0;
  const barAt = (x, y) => {
    const r = $('alphatab').getBoundingClientRect();
    return api?.renderer?.boundsLookup?.getBeatAtPos(x - r.left, y - r.top)?.voice?.bar || null;
  };
  const show = () => {
    const to = barAt(at.x, at.y);
    if (!to) return;
    const [a, z] = from.index <= to.index ? [from, to] : [to, from];
    const first = a.voices[0]?.beats[0];
    const last = z.voices[0]?.beats.at(-1);
    if (first && last) api.highlightPlaybackRange(first, last);
  };
  const edgeScroll = () => {
    if (!from) return;
    const r = box.getBoundingClientRect();
    const dy = at.y < r.top + 70 ? -(r.top + 70 - at.y) / 4 : at.y > r.bottom - 70 ? (at.y - (r.bottom - 70)) / 4 : 0;
    if (dy) { box.scrollTop += dy; show(); }
    raf = requestAnimationFrame(edgeScroll);
  };
  const finish = (apply) => {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    if (from && apply) {
      api.applyPlaybackRangeFromHighlight?.();
      setLoop(true);
      sections.forEach((sec) => sec.el.classList.remove('looped'));
    } else if (from) api.clearPlaybackRangeHighlight?.();
    from = null;
  };
  box.addEventListener('touchstart', (e) => {
    finish(false);
    if (e.touches.length !== 1 || !api || !readyForPlayback || !$('alphatab').contains(e.target)) return;
    const t = e.touches[0];
    at = { x: t.clientX, y: t.clientY };
    const start = { ...at };
    timer = setTimeout(() => {
      from = barAt(start.x, start.y);
      if (!from) return;
      navigator.vibrate?.(25);
      show();
      raf = requestAnimationFrame(edgeScroll);
    }, 450);
  }, { passive: true });
  box.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (!from) {
      // Moved before the hold registered: an ordinary scroll.
      if (at && Math.hypot(t.clientX - at.x, t.clientY - at.y) > 10) clearTimeout(timer);
      return;
    }
    e.preventDefault(); // keep the page still while choosing bars
    at = { x: t.clientX, y: t.clientY };
    show();
  }, { passive: false });
  box.addEventListener('touchend', () => finish(true));
  box.addEventListener('touchcancel', () => finish(false));
  box.addEventListener('contextmenu', (e) => { if (from || timer) e.preventDefault(); });
}

function clearSelection() {
  if (!api) return;
  api.playbackRange = null;
  document.body.classList.remove('has-range');
  api.clearPlaybackRangeHighlight?.();
  showLoops();
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
    : 'Using the built-in realistic sound set (MuseScore General)';
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
  else api.loadSoundFont(DEFAULT_SF, false);
  api.masterVolume = synthVolume(playAlongState().songVolume);
}

function initSound() {
  const tone = $('pl-tone');
  Object.entries(TONES).forEach(([key, t]) => tone.add(new Option(t.label, key)));
  tone.value = getTone();
  tone.addEventListener('change', () => setTone(tone.value));
  const roomSel = $('pl-room');
  Object.entries(ROOMS).forEach(([key, r]) => roomSel.add(new Option(r.label, key)));
  roomSel.value = getRoom();
  roomSel.addEventListener('change', () => setRoom(roomSel.value));
  const strum = $('pl-strum');
  strum.checked = strumOn();
  strum.addEventListener('change', () => {
    try { localStorage.setItem('fretboard.strum', strum.checked ? 'on' : 'off'); } catch {}
    rebuildClick(); // regenerates the MIDI, keeping the position
  });
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
  if (!recording) api.masterVolume = synthVolume(playAlongState().songVolume);
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
  document.body.classList.toggle('sheet-up', !!opening); // the floating drum kit steps aside
  document.body.classList.toggle('card-up', !!opening && name !== 'edit'); // every sheet but Edit: a card in front of everything
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
  // (A phone has no second screen or taskbar, so there it only reacts to the events above.)
  if (!matchMedia('(pointer: coarse)').matches) setInterval(fit, 1500);
  fit();
}

// Phone / focus helpers: the tempo popover, the ⚙ menu and the focus view close when you press elsewhere.
function initCompact() {
  const body = document.body;
  // On a phone the settings button lives in the top bar, beside the search, and the video rides in the
  // play bar (full width above the buttons, or a small picture beside the tempo button).
  document.querySelector('.topbar').append($('pl-more'));
  if (matchMedia('(max-width: 640px)').matches) {
    const chip = document.querySelector('.track-chip'); // the instrument stays in the bar, not in the menu
    $('pl-tempo-open').after(chip);
    chip.after($('pa-video'));
    // The video is a pop-up from the bottom; its minimize button folds it down to just its title bar.
    const pop = (on) => {
      document.body.classList.toggle('video-open', on);
      $('pa-video-close').title = on ? 'Minimize the video (it keeps playing)' : 'Show the video';
      $('pa-video-close').setAttribute('aria-label', $('pa-video-close').title);
      if (on) setTimeout(keepPlayheadInView, 300);
    };
    pop(false);
    $('pa-video-close').addEventListener('click', () => pop(!document.body.classList.contains('video-open')));
    $('pa-video-title').addEventListener('click', () => { if (!document.body.classList.contains('video-open')) pop(true); });
    $('pa-video-sync').addEventListener('click', () => pop(false));
    $('pa-toggle').addEventListener('click', () => setTimeout(() => pop(!$('pa-video').hidden), 400));
  }
  const flip = (cls, btn, force) => {
    const on = force ?? !body.classList.contains(cls);
    body.classList.toggle(cls, on);
    btn?.setAttribute('aria-expanded', String(on));
    return on;
  };
  $('pl-tempo-open').addEventListener('click', () => { flip('more-open', $('pl-more'), false); flip('tempo-open', $('pl-tempo-open')); });
  $('pl-more').addEventListener('click', () => { flip('tempo-open', $('pl-tempo-open'), false); flip('more-open', $('pl-more')); });
  document.addEventListener('pointerdown', (e) => {
    if (body.classList.contains('tempo-open') && !e.target.closest('.speed, #pl-tempo-open')) flip('tempo-open', $('pl-tempo-open'), false);
    if (body.classList.contains('more-open') && !e.target.closest('.playbar-end, #pl-more')) flip('more-open', $('pl-more'), false);
  });
  // Choosing something from the menu (or Advanced…) opens its sheet and tucks the menu away.
  document.querySelectorAll('.playbar-end [data-sheet-btn], #pl-tempo-adv').forEach((b) => b.addEventListener('click', () => {
    flip('more-open', $('pl-more'), false);
    flip('tempo-open', $('pl-tempo-open'), false);
  }));
  // Wide screens: the sheets, count-in and Bluetooth sit in one settings menu (like Ultimate Guitar's).
  $('pl-menu').addEventListener('click', () => flip('menu-open', $('pl-menu')));
  // A sheet's card: a click outside it puts it away (not on the linked video, a sheet button or a message)
  document.addEventListener('pointerdown', (e) => {
    if (body.classList.contains('card-up') && !e.target.closest('.sheet, [data-sheet-btn], .pa-video, .toast, dialog')) openSheet(null);
  });
  document.addEventListener('pointerdown', (e) => {
    if (body.classList.contains('menu-open') && !e.target.closest('.sheet-btns, #pl-menu')) flip('menu-open', $('pl-menu'), false);
  });
  document.querySelectorAll('.sheet-btns [data-sheet-btn]').forEach((b) => b.addEventListener('click', () => flip('menu-open', $('pl-menu'), false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') flip('menu-open', $('pl-menu'), false); });
  $('pl-focus').addEventListener('click', () => {
    const on = body.classList.toggle('focus');
    $('pl-focus').setAttribute('aria-pressed', String(on));
    $('pl-focus').textContent = on ? '⤡' : '⛶';
    flip('more-open', $('pl-more'), false);
    flip('tempo-open', $('pl-tempo-open'), false);
    try { if (on) document.documentElement.requestFullscreen?.().catch(() => {}); else if (document.fullscreenElement) document.exitFullscreen?.(); } catch { /* not allowed here */ }
  });
}

function initDock() {
  initCompact();
  document.querySelectorAll('[data-sheet-btn]').forEach((b) => b.addEventListener('click', () => { openSheet(b.dataset.sheetBtn); b.blur(); }));
  document.querySelectorAll('.sheet [data-close]').forEach((b) => b.addEventListener('click', () => openSheet(null)));
  // The score fills the space between the top bar and the play bar.
  const root = document.documentElement.style;
  const measure = () => {
    root.setProperty('--dock-h', (document.querySelector('.playbar')?.offsetHeight ?? 0) + 'px');
    root.setProperty('--top-h', (document.querySelector('.topbar')?.offsetHeight ?? 0) + 'px');
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
    seekHold = { value: Number(seek.value), until: performance.now() + 1500 };
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
  try { chords.checked = localStorage.getItem('fretboard-chords') !== '0'; } catch { /* storage blocked */ }
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
    setSongVolume: (v) => { if (api) api.masterVolume = synthVolume(v); },
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
    tempo: () => baseTempo,
    seekToBar: (i) => seekToBar(i),
    releaseSelection: () => { setPin(null); clearSelection(); setLoop(false); },
    cursorMaster: () => { // the pinned bar, else the start of the selection, else the cursor's bar
      if (pinnedBar !== null) return pinnedBar;
      const bars = playedBars();
      const tick = api.playbackRange ? api.playbackRange.startTick : currentTick();
      const i = bars.findIndex((b) => tick >= b.start && tick < b.end);
      return (bars[i < 0 ? currentBarIndex() : i] || bars[0]).masterBar.index;
    },
    sectionChoices: () => sections.map((sec) => ({ master: sec.index, name: sec.el.textContent.trim() })),
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
  initMediaSession({
    play: () => { if (api?.playerState !== PLAYING) togglePlay(); },
    pause: () => { if (api?.playerState === PLAYING || counting) togglePlay(); },
    back: () => backToStart(),
  });
  $('pl-stop').addEventListener('click', () => {
    cancelCountIn();
    api?.stop();
    // A video that begins at the verse: stopping goes back to the verse, not the intro.
    setTimeout(() => { const t = videoStartTick(); if (t && api) api.tickPosition = t; }, 80);
  });
  $('pl-back').addEventListener('click', backToStart);
  $('pl-speed').addEventListener('input', (e) => setSpeed(Number(e.target.value)));
  $('pl-speed-slide').addEventListener('input', (e) => slideSpeed(Number(e.target.value)));
  $('pl-speed-slide').addEventListener('change', (e) => e.target.blur());
  initTouchSelect();
  $('ti-url').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (!song) return;
    song.sourceUrl = v && parseSource(v) ? v : '';
    updateSong(song.id, { sourceUrl: song.sourceUrl });
    showTabInfo();
  });
  $('ti-note').addEventListener('change', (e) => {
    if (!song) return;
    song.versionNote = e.target.value.trim().slice(0, 2000);
    updateSong(song.id, { versionNote: song.versionNote });
    showTabInfo();
  });
  $('pl-tap').addEventListener('pointerdown', (e) => { e.preventDefault(); tapTempo(); });
  $('pl-tap').addEventListener('keydown', (e) => { if (e.key === 'Enter') tapTempo(); });
  initModes({ enter: enterLive, leave: leaveLive });
  $('pl-slower').addEventListener('click', () => setBpm(Math.round((baseTempo * speedPct) / 100) - 5));
  $('pl-faster').addEventListener('click', () => setBpm(Math.round((baseTempo * speedPct) / 100) + 5));
  $('pl-bpm-input').addEventListener('change', (e) => { const v = Number(e.target.value); if (v > 0 && !isLive()) setBpm(v); e.target.blur(); updateBpm(); });
  $('pl-bpm-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); });
  $('pl-bpm-input').addEventListener('blur', updateBpm);
  scrubBpm($('pl-bpm-input'));
  document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));
  $('pl-loop').addEventListener('click', () => setLoop(!$('pl-loop').classList.contains('on')));
  $('pl-clear-sel').addEventListener('click', clearSelection);
  initLoops();
  initScrollHold();
  initEditor({
    AT,
    song: () => song,
    score: () => score,
    readScore: () => readScore(song),
    reload: reloadScore,
    selection: () => {
      const sel = selectedBars();
      const bars = playedBars();
      if (!sel || !bars[sel.a]) return null;
      const idx = bars.slice(sel.a, sel.b + 1).map((b) => b.masterBar.index);
      return { first: Math.min(...idx), last: Math.max(...idx) };
    },
    pin: (i) => setPin(i),
    pinned: () => pinnedBar,
    barAt: (x, y) => {
      const r = $('alphatab').getBoundingClientRect();
      return api?.renderer?.boundsLookup?.getBeatAtPos?.(x - r.left, y - r.top)?.voice.bar.index ?? null;
    },
    holdScroll: () => holdScroll,
    toggleHold: () => { holdScroll = !holdScroll; frozenTop = holdScroll ? $('score-scroll').scrollTop : null; window.dispatchEvent(new CustomEvent('fbtoast', { detail: holdScroll ? 'The tab stays put while it plays. Right-click to let it follow again.' : 'The tab follows the playhead again.' })); },
    clearSelection: () => { clearSelection(); setLoop(false); },
    loopSelection: () => setLoop(true),
    selectBars: (first, last) => {
      const staff = score?.tracks[trackIndex]?.staves[0];
      const a = staff?.bars[first]?.voices[0]?.beats[0];
      const z = staff?.bars[last]?.voices[0]?.beats.at(-1);
      if (a && z && api.highlightPlaybackRange) {
        api.highlightPlaybackRange(a, z);
        api.applyPlaybackRangeFromHighlight?.();
      }
    },
    cursorBar: () => playedBars()[currentBarIndex()]?.masterBar.index ?? 0,
  });
  bindBtControls({ button: $('pl-bt'), labelMs: true, title: 'Bluetooth' });
  bindBtControls({ button: $('sb-bt'), input: $('sb-bt-ms'), nudges: document.querySelectorAll('#sb-bt-row [data-bt]') });
  $('pl-countin').addEventListener('click', () => toggleButton('pl-countin', !countInOn()));
  $('pl-metro').addEventListener('click', toggleClick);
  // Quick switches on the play bar: notation (tab / both / notes) and transpose
  document.querySelectorAll('#qk-stave [data-stave]').forEach((b) => b.addEventListener('click', () => {
    chordView = b.dataset.stave === 'chords';
    showChordView();
    if (chordView) return;
    $('pl-stave').value = b.dataset.stave;
    $('pl-stave').dispatchEvent(new Event('change'));
  }));
  try { const keep = localStorage.getItem('fb-stave'); if (keep) $('pl-stave').value = keep; } catch { /* no storage */ }
  $('pl-stave').addEventListener('change', () => { showStave(); try { localStorage.setItem('fb-stave', $('pl-stave').value); } catch { /* no storage */ } });
  showStave();
  $('qk-down').addEventListener('click', () => $('tp-down').click());
  $('qk-up').addEventListener('click', () => $('tp-up').click());
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
  $('tp-reset').addEventListener('click', () => setShift({ transpose: 0, capo: null, tune: 0 }));
  $('tune-sel').addEventListener('change', (e) => setShift({ tune: Number(e.target.value) || 0 }));

  // Fretboard and lyrics panes.
  // Master volume (the Tracks sheet) and the Amp panel's song volume are one setting.
  const master = $('pl-master');
  const songVol = $('amp-song-vol');
  master.addEventListener('input', () => { songVol.value = master.value; songVol.dispatchEvent(new Event('input')); });
  songVol.addEventListener('input', showMix);
  $('pl-others').addEventListener('input', () => {
    othersVol = Number($('pl-others').value) / 100;
    try { localStorage.setItem('fretboard-others', String(othersVol)); } catch { /* ignore */ }
    applyMix();
  });
  showMaster();
  initFretView($('pl-neck'));
  initKeyView($('pl-keys'));
  initDrumView($('pl-drums'));
  initShakerView($('pl-drums'));
  hoverNotes($('alphatab'));
  const flip = (id, v) => { $(id).checked = v; $(id).dispatchEvent(new Event('change')); };
  $('ly-hide').addEventListener('click', () => flip('pl-lyrics-on', false));
  $('pl-lyr-btn').addEventListener('click', () => flip('pl-lyrics-on', !$('pl-lyrics-on').checked));
  $('pl-howto').addEventListener('click', () => flip('pl-fretboard', !fretboardOn()));
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
  // Reset mix: the song's own track levels, Master and Other parts back to 100%.
  $('pl-mix-reset').addEventListener('click', () => {
    if (!score) return;
    mix = defaultMix(score);
    othersVol = 1;
    try { localStorage.setItem('fretboard-others', '1'); } catch { /* ignore */ }
    const songVol = $('amp-song-vol');
    songVol.value = '100';
    songVol.dispatchEvent(new Event('input'));
    applyMix();
    saveMix();
  });

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
      g: startVideoHere,
      v: () => { if (recordingOn()) tapVideoBeat(); },
      h: () => { if (recordingOn()) setStartHere(); },
      f: () => { $('pl-fretboard').checked = !fretboardOn(); $('pl-fretboard').dispatchEvent(new Event('change')); },
      Escape: () => { if (!closeSheets()) clearSelection(); },
    };
    const action = keys[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!action) return;
    e.preventDefault(); // also stops Space from clicking a focused button and arrows from scrolling
    action();
  });
}
