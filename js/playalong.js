// Play along with the real recording: an audio file or a YouTube video drives playback
// instead of the synth (alphaTab's "external media" mode), and the tab cursor follows it.
// Sync: tap T on beat 1 of each bar as you hear it; every tap becomes a sync point, so the
// tab follows the band's real tempo (including drift) between tapped bars.
import { updateSong } from './db.js';
import { findRecording, youTubeSearchUrl } from './ytsearch.js';

const $ = (id) => document.getElementById(id);
const AT = window.alphaTab;

let hooks = null; // from player.js
// Only the external-media output takes positions; the synth's output has no updatePosition.
let song = null;
// Skipped parts of the video (an interlude, applause): [from, to] in the video's own ms. The
// tab and its sync points use "played time", the video's time with the skipped parts taken out,
// so skipped parts never need syncing; the video just jumps over them.
const skipList = () => (song?.skips || []).slice().sort((a, b) => a[0] - b[0]);
const toPlayed = (real) => skipList().reduce((t, [f, e]) => (real > f ? t - (Math.min(real, e) - f) : t), real);
const toReal = (played) => skipList().reduce((r, [f, e]) => (r >= f ? r + (e - f) : r), played);
// A video with no intro begins at a later part of the tab: the tab's clock runs `lead` ms ahead
// of the video's (the written length of the bars before that part), so video time 0 is that part.
const lead = () => {
  const at = song?.videoMaster ? startIdx() : 0;
  const bars = at > 0 ? hooks.playedBars() : null;
  return bars?.[at] ? bars[at].start * (60000 / (hooks.tempo() * 960)) : 0;
};
const skippedTotal = () => skipList().reduce((t, [f, e]) => t + (e - f), 0);
const sendPosition = (real) => {
  const hit = skipList().find(([f, e]) => real >= f && real < e);
  if (hit && media?.seekReal) { media.seekReal(hit[1]); return; }
  const o = hooks.output();
  if (typeof o?.updatePosition === 'function') o.updatePosition(toPlayed(real) + lead());
  showScrub(real);
};
let media = null; // the active handler (file or YouTube)
let on = false;
let taps = null; // tap-sync in progress: { next: played-bar index, points }

/* ---------- media handlers ---------- */

// An <audio> element. preservesPitch keeps the pitch when the speed changes.
function fileHandler(rec) {
  const el = new Audio();
  el.preload = 'auto';
  el.preservesPitch = true;
  el.src = URL.createObjectURL(new Blob([rec.data], { type: rec.type || 'audio/mpeg' }));
  let raf = 0, timer = 0, dead = false; // a switched-off handler must not move or play anything
  const tick = () => {
    sendPosition(el.currentTime * 1000);
    cancelAnimationFrame(raf);
    if (!el.paused) raf = requestAnimationFrame(tick);
    else { clearInterval(timer); timer = 0; }
  };
  // rAF stops in background tabs; a slow timer keeps the cursor (and loops) moving there
  el.addEventListener('play', () => { clearInterval(timer); timer = setInterval(tick, 100); tick(); });
  el.addEventListener('pause', tick);
  el.addEventListener('seeked', tick);
  el.addEventListener('ended', () => hooks.api()?.pause());
  el.addEventListener('loadedmetadata', () => sendPosition(el.currentTime * 1000));
  return {
    kind: 'file',
    get backingTrackDuration() { return Math.max(0, (el.duration || 0) * 1000 - skippedTotal() + lead()); },
    get rawDuration() { return (el.duration || 0) * 1000; },
    get isPlaying() { return !el.paused; },
    get playbackRate() { return el.playbackRate; },
    set playbackRate(v) { el.playbackRate = v; },
    get masterVolume() { return el.volume; },
    set masterVolume(v) { el.volume = Math.max(0, Math.min(1, v)); },
    seekTo(ms) { if (!dead) el.currentTime = toReal(Math.max(0, ms - lead())) / 1000; },
    seekReal(ms) { if (!dead) el.currentTime = ms / 1000; },
    nowReal: () => el.currentTime * 1000,
    play() { if (!dead) el.play().catch(() => {}); },
    pause() { el.pause(); },
    now: () => toPlayed(el.currentTime * 1000),
    destroy() { dead = true; el.pause(); URL.revokeObjectURL(el.src); cancelAnimationFrame(raf); clearInterval(timer); },
  };
}

let ytReady = null;
function loadYouTubeApi() {
  ytReady ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) { resolve(); return; }
    window.onYouTubeIframeAPIReady = resolve;
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytReady = null; reject(new Error('Could not reach YouTube.')); };
    document.head.append(s);
  });
  return ytReady;
}

export function youTubeId(text) {
  const m = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/.exec(text || '') || /^([\w-]{11})$/.exec((text || '').trim());
  return m ? m[1] : null;
}

// One YouTube player for the whole session. Taking YouTube's player down and building a
// new one (switching songs or videos) can throw inside YouTube's own code and leave the
// new one stuck, so it's built once and given each song's video with cueVideoById.
let ytPlayer = null;

async function youTubeHandler(rec) {
  await loadYouTubeApi();
  const box = $('pa-video');
  box.hidden = false;
  let player = ytPlayer;
  if (player) {
    player.cueVideoById(rec.id);
  } else {
    box.querySelector('.pa-video-frame').innerHTML = '<div id="pa-yt"></div>';
    await new Promise((resolve) => {
      player = new window.YT.Player('pa-yt', {
        videoId: rec.id,
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, controls: 1 },
        events: { onReady: resolve },
      });
    });
    ytPlayer = player;
  }
  let timer = 0;
  let rate = 1;
  let dead = false; // a switched-off handler must not move or play anything
  const poll = () => sendPosition(player.getCurrentTime() * 1000);
  const stateChange = (e) => {
    clearInterval(timer);
    if (e.data === window.YT.PlayerState.PLAYING) timer = setInterval(poll, 30);
    poll();
    // Play / pause pressed on the video itself.
    const api = hooks.api();
    if (e.data === window.YT.PlayerState.PAUSED && api?.playerState === 1) api.pause();
    if (e.data === window.YT.PlayerState.ENDED) api?.pause();
  };
  player.addEventListener('onStateChange', stateChange);
  return {
    kind: 'youtube',
    get backingTrackDuration() { return Math.max(0, (player.getDuration() || 0) * 1000 - skippedTotal() + lead()); },
    get rawDuration() { return (player.getDuration() || 0) * 1000; },
    get isPlaying() { return player.getPlayerState?.() === window.YT.PlayerState.PLAYING; },
    get playbackRate() { return rate; },
    set playbackRate(v) {
      // YouTube only offers some speeds (0.25 steps, or finer on newer players).
      const rates = player.getAvailablePlaybackRates?.() || [0.25, 0.5, 0.75, 1, 1.25, 1.5];
      rate = rates.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), 1);
      player.setPlaybackRate(rate);
      showRateNote(v, rate);
    },
    get masterVolume() { return player.getVolume() / 100; },
    set masterVolume(v) { player.setVolume(Math.round(Math.max(0, Math.min(1, v)) * 100)); },
    seekTo(ms) { if (!dead) { player.seekTo(toReal(Math.max(0, ms - lead())) / 1000, true); setTimeout(poll, 50); } },
    seekReal(ms) { if (!dead) { player.seekTo(ms / 1000, true); setTimeout(poll, 50); } },
    nowReal: () => player.getCurrentTime() * 1000,
    play() { if (!dead) player.playVideo(); },
    pause() { player.pauseVideo(); },
    now: () => toPlayed(player.getCurrentTime() * 1000),
    // Another video in the same player (tearing YouTube's player down and making a new one
    // right away can leave the new one stuck). Resolves once it's ready to play.
    cue(id) {
      return new Promise((resolve) => {
        const done = (e) => {
          if (e.data !== window.YT.PlayerState.CUED) return;
          player.removeEventListener('onStateChange', done);
          resolve();
        };
        player.addEventListener('onStateChange', done);
        player.cueVideoById(id);
        setTimeout(resolve, 5000);
      });
    },
    destroy() {
      dead = true;
      clearInterval(timer);
      player.removeEventListener('onStateChange', stateChange);
      try { player.pauseVideo(); player.stopVideo(); } catch { /* ignore */ }
      box.hidden = true;
    },
  };
}

function showRateNote(wanted, got) {
  $('pa-rate-note').textContent = Math.abs(wanted - got) > 0.01
    ? `YouTube plays at ${Math.round(got * 100)}% (the nearest speed it offers). An audio file can play at any speed.`
    : '';
}

/* ---------- sync points ---------- */

// Stored as [playedBarIndex, ms]; alphaTab wants master bar index + which repeat.
function flatSyncPoints(points) {
  const bars = hooks.playedBars();
  const seen = new Map();
  const occurrence = bars.map((b) => {
    const i = b.masterBar.index;
    const n = seen.get(i) ?? 0;
    seen.set(i, n + 1);
    return n;
  });
  const offset = song?.syncOffset || 0;
  const sorted = points.filter(([p]) => p < bars.length).sort((a, b) => a[0] - b[0]);
  const ahead = lead();
  // The bars before a video's first part keep their written tempo: a point at 0 ms.
  if (sorted.length && sorted[0][0] > 0) sorted.unshift([0, -ahead]);
  let prev = -1;
  return sorted.map(([p, ms]) => {
    prev = Math.max(prev + 1, Math.max(0, ms + offset + ahead));
    return { barIndex: bars[p].masterBar.index, barOccurence: occurrence[p], barPosition: 0, millisecondOffset: prev };
  });
}

// The played bar where the video begins: the first bar of the chosen section (0 = the start).
function startIdx() {
  const want = song?.videoMaster || 0;
  const i = want ? hooks.playedBars().findIndex((b) => b.masterBar.index === want) : 0;
  return Math.max(0, i);
}

function syncPoints() {
  return song?.syncPoints?.length ? song.syncPoints : [[startIdx(), 0]];
}

function applySync() {
  const api = hooks.api();
  const score = hooks.score();
  if (!api || !score) return;
  score.applyFlatSyncPoints(flatSyncPoints(syncPoints()));
  api.updateSyncPoints();
  showSync();
}

// Skips: add or remove one, keeping the tapped bars lined up (played time after it changes).
function shiftSyncAfter(playedMs, by) {
  if (!song.syncPoints?.length) return;
  song.syncPoints = song.syncPoints.map(([p, t]) => [p, t >= playedMs ? Math.max(0, t + by) : t]);
  updateSong(song.id, { syncPoints: song.syncPoints });
}

function changeSkips(skips, shiftAt, by) {
  shiftSyncAfter(shiftAt, by);
  song.skips = skips;
  updateSong(song.id, { skips });
  showSkips();
  if (on) applySync(); else showSync();
}

function addSkip(fromSec, toSec) {
  const f = Math.round(fromSec * 1000);
  const e = Math.round(toSec * 1000);
  if (!song || !(e > f)) { $('pa-skip-state').textContent = 'The skip must end after it starts.'; return; }
  if (skipList().some(([a, b]) => f < b && e > a)) { $('pa-skip-state').textContent = 'That overlaps a skip you already set.'; return; }
  const playedAt = toPlayed(f);
  changeSkips([...(song.skips || []), [f, e]], playedAt, -(e - f));
  $('pa-skip-state').textContent = '';
}

function removeSkip(i) {
  const [f, e] = skipList()[i];
  const playedAt = toPlayed(f);
  changeSkips(skipList().filter((_, k) => k !== i), playedAt, e - f);
}

const skipClock = (ms) => `${Math.floor(ms / 60000)}:${(ms % 60000 / 1000).toFixed(1).padStart(4, '0')}`;
function showSkips() {
  const ul = $('pa-skips');
  ul.innerHTML = '';
  skipList().forEach(([f, e], i) => {
    const li = document.createElement('li');
    li.textContent = `${skipClock(f)} → ${skipClock(e)} `;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost small';
    b.textContent = '✕';
    b.title = 'Play this part again';
    b.addEventListener('click', () => removeSkip(i));
    li.append(b);
    ul.append(li);
  });
}

// Where the first bar begins in the video. Everything tapped later moves with it.
function setStart(sec) {
  if (!song) return;
  const ms = Math.max(0, Math.round(sec * 1000));
  const at = startIdx();
  const pts = song.syncPoints?.length ? song.syncPoints : [[at, 0]];
  const first = pts.find(([p]) => p === at);
  const delta = ms - (first ? first[1] : 0);
  song.syncPoints = first
    ? pts.map(([p, t]) => [p, Math.max(0, t + delta)])
    : [[at, ms], ...pts.map(([p, t]) => [p, t + delta])];
  updateSong(song.id, { syncPoints: song.syncPoints });
  if (on) applySync(); else showSync();
}

// Step 1 and 2 of lining up: scrub the video to where the music starts, pick the part of the
// tab that begins there. A video with no intro starts at the verse, for example.
let pendingMaster = 0;
let scrubbing = false;
let lastScrubShown = 0;
const fmtT = (ms) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, '0')}`;
const chosenName = () => $('pa-start-chips').querySelector('.on')?.dataset.name || 'the start of the tab';

function showScrub(real) {
  if (scrubbing) return;
  const t = performance.now();
  if (t - lastScrubShown < 90) return;
  lastScrubShown = t;
  $('pa-scrub-time').textContent = fmtT(real);
  $('pa-scrub-play').textContent = media?.isPlaying ? '⏸' : '▶';
  setLabel();
}

function setLabel() {}

// The video's start time follows the scrubber once a part has been chosen.
const hasStart = () => !!song?.syncPoints?.some(([p]) => p === startIdx()) && !!song?.videoMaster;
function applyStartAt(realMs) {
  if (!media || !song) return;
  setStart(Math.max(0, (toPlayed(realMs) - (song.syncOffset || 0)) / 1000));
  fillStartBars();
}

function refreshScrub() {
  $('pa-scrub').setAttribute('aria-disabled', String(!media));
  $('pa-scrub-play').disabled = !media;
  if (media) {
    $('pa-scrub-time').textContent = fmtT(media.nowReal());
    $('pa-scrub-play').textContent = media.isPlaying ? '⏸' : '▶';
  }
  setLabel();
}

function fillStartBars() {
  const box = $('pa-start-chips');
  const list = hooks.sectionChoices?.() || [];
  const want = song?.videoMaster || 0;
  const sig = `${want}|` + list.map((s) => `${s.master}:${s.name}`).join('|');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    pendingMaster = want;
    box.innerHTML = '';
    const add = (master, name, label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost small';
      b.dataset.master = master;
      b.dataset.name = name;
      b.textContent = label;
      b.classList.toggle('on', master === pendingMaster);
      box.append(b);
    };
    add(0, 'the start of the tab', 'Start of tab');
    for (const s of list) if (s.master > 0) add(s.master, s.name, `${s.name} · bar ${s.master + 1}`);
    if (![...box.children].some((b) => b.classList.contains('on'))) box.firstElementChild.classList.add('on');
  }
  refreshScrub();
  const pt = song?.syncPoints?.find(([p]) => p === startIdx());
  $('pa-start-state').textContent = pt
    ? `Now: the video's ${fmtT(pt[1])} is the start of ${list.find((s) => s.master === want)?.name || 'the tab'}.`
    : media ? 'Not set yet: the video starts with the tab.' : 'Turn on “Play with the linked video” above, then scrub to find where the music starts.';
}

function setStartBar(master) {
  if (!song) return;
  const oldAt = startIdx();
  const oldPt = song.syncPoints?.find(([p]) => p === oldAt);
  song.videoMaster = master;
  const at = startIdx();
  const rest = (song.syncPoints || []).filter(([p]) => p !== oldAt && p !== at);
  song.syncPoints = [[at, oldPt ? oldPt[1] : 0], ...rest].sort((a, b) => a[0] - b[0]);
  updateSong(song.id, { videoMaster: master, syncPoints: song.syncPoints });
  if (on) applySync(); else showSync();
}

function showSync() {
  showSkips();
  fillStartBars();
  const pts = song?.syncPoints || [];
  const off = song?.syncOffset || 0;
  $('pa-sync-state').textContent = pts.length
    ? `Synced at ${pts.length} bar${pts.length > 1 ? 's' : ''}${off ? `, nudged ${off > 0 ? '+' : ''}${off} ms` : ''}.`
    : `Not synced yet: bar 1 starts at the very beginning${off ? ` (nudged ${off > 0 ? '+' : ''}${off} ms)` : ''}.`;
  $('pa-clear').disabled = !pts.length && !off;
}

/** T while the recording plays: the bar after the last tapped one starts now. */
export function tapSync() {
  if (!on || !media) return false;
  const api = hooks.api();
  if (api.playerState !== 1) return false;
  const bars = hooks.playedBars();
  const ms = media.now() - (song.syncOffset || 0);
  if (!taps) {
    // First tap: the bar whose (current) start is closest to now.
    const tick = api.tickPosition;
    let i = bars.findIndex((b) => tick >= b.start && tick < b.end);
    if (i === -1) i = 0;
    const into = (tick - bars[i].start) / (bars[i].end - bars[i].start);
    if (into > 0.5 && i + 1 < bars.length) i++;
    taps = { next: i, points: [] };
  }
  taps.points.push([taps.next, Math.round(ms)]);
  $('pa-tap-state').textContent = `Bar ${taps.next + 1} ✓ — keep tapping beat 1 of each bar, then pause.`;
  taps.next++;
  return true;
}

// Taps replace the sync points of the bars they cover (and only those).
function finishTaps() {
  if (!taps || !taps.points.length) { taps = null; return; }
  // A stray or double tap squeezes the tab (the cursor races through the bars around it).
  // Drop any tap that makes a bar last under 55% or over 180% of its written length.
  const bars = hooks.playedBars();
  const msPerTick = 60000 / (hooks.tempo() * 960);
  const fit = [];
  let dropped = 0;
  for (const pt of taps.points) {
    const prev = fit.at(-1);
    if (prev && pt[0] > prev[0]) {
      const expect = (bars[pt[0]].start - bars[prev[0]].start) * msPerTick;
      const ratio = (pt[1] - prev[1]) / expect;
      if (ratio < 0.55 || ratio > 1.8) { dropped++; continue; }
    }
    fit.push(pt);
  }
  taps.points = fit;
  const droppedNote = dropped ? ` Left out ${dropped} tap${dropped > 1 ? 's' : ''} that didn't fit the tempo.` : '';
  const first = taps.points[0][0];
  const last = taps.points.at(-1)[0];
  const kept = (song.syncPoints || []).filter(([p]) => p < first || p > last);
  song.syncPoints = [...kept, ...taps.points].sort((a, b) => a[0] - b[0]);
  updateSong(song.id, { syncPoints: song.syncPoints });
  $('pa-tap-state').textContent = `Saved ${taps.points.length} bar${taps.points.length > 1 ? 's' : ''}.${droppedNote}`;
  taps = null;
  applySync();
}

export function playerStateChanged(playing) {
  if (!playing && taps) finishTaps();
}

/* ---------- switching modes ---------- */

export const recordingOn = () => on;

/** Where the song starts: the part of the tab the video begins with (0 = the very start). */
export function videoStartTick() {
  if (!on || !song?.videoMaster) return 0;
  return hooks.playedBars()[startIdx()]?.start || 0;
}

async function setOn(want) {
  const api = hooks.api();
  if (!api || !song) return;
  if (want && !song.recording) { $('pa-error').textContent = 'Add an audio file or a YouTube link first.'; return; }
  $('pa-error').textContent = '';
  api.stop();
  media?.destroy();
  media = null;
  on = false;
  if (want) {
    try {
      media = song.recording.kind === 'youtube' ? await youTubeHandler(song.recording) : fileHandler(song.recording);
    } catch (e) {
      $('pa-error').textContent = e?.message || String(e);
      want = false;
    }
  }
  on = !!want;
  api.settings.player.playerMode = on ? AT.PlayerMode.EnabledExternalMedia : AT.PlayerMode.EnabledSynthesizer;
  api.updateSettings();
  api.loadMidiForScore();
  if (on) {
    api.player.output.handler = media;
    applySync();
    if (song?.videoMaster) setTimeout(() => hooks.seekToBar(startIdx()), 200);
  }
  hooks.modeChanged(on);
  showState();
}

function showState() {
  $('pa-on').checked = on;
  $('pa-on').disabled = !song?.recording;
  const rec = song?.recording;
  $('pa-source').textContent = !rec ? 'No video linked yet.'
    : rec.kind === 'youtube' ? `YouTube: ${rec.title ? `${rec.title}${rec.author ? ` (${rec.author})` : ''}` : rec.id}` : `Audio file: ${rec.name}`;
  $('pa-yt-search').href = song ? youTubeSearchUrl(song) : '#';
  document.querySelectorAll('#pa-yt-results button').forEach((b) => b.classList.toggle('on', rec?.kind === 'youtube' && b.dataset.id === rec.id));
  $('pa-remove').hidden = !rec;
  document.querySelector('[data-sheet-btn=playalong]')?.classList.toggle('live', on);
  $('pa-toggle').classList.toggle('on', on);
  $('pa-toggle').title = on ? 'Playing with the linked video (click for the built-in guitar sound)' : 'Play with this song\u2019s linked video instead of the built-in guitar sound';
  $('pa-video').hidden = !(on && rec?.kind === 'youtube');
  $('pa-video-title').textContent = rec?.kind === 'youtube' && rec.title ? rec.title : 'Linked video';
  $('pa-video-title').title = $('pa-video-title').textContent;
  fillStartBars();
  const at = matches.findIndex((r) => rec?.kind === 'youtube' && r.id === rec.id);
  $('pa-video-prev').hidden = $('pa-video-next').hidden = matches.length < 2 || at < 0;
  $('pa-video-prev').disabled = at <= 0;
  $('pa-video-next').disabled = at >= matches.length - 1;
  showSync();
}

// The linked video is used every time the song is opened, unless it was switched off here.
const remember = (want) => {
  if (!song?.recording) return;
  song.videoOff = !want;
  song.videoOn = !!want;
  updateSong(song.id, { videoOff: !want, videoOn: !!want });
};

async function setRecording(rec) {
  // YouTube to YouTube while playing along: same player, new video.
  if (on && media?.kind === 'youtube' && rec?.kind === 'youtube') {
    hooks.api()?.stop();
    song.recording = rec;
    song.syncPoints = [];
    song.syncOffset = 0;
    song.videoOff = false;
    song.videoOn = true;
    await updateSong(song.id, { recording: rec, syncPoints: [], syncOffset: 0, videoOff: false, videoOn: true });
    await media.cue(rec.id);
    applySync();
    showState();
    return;
  }
  const wasOn = on;
  if (on) await setOn(false);
  song.recording = rec;
  song.syncPoints = [];
  song.syncOffset = 0;
  song.videoOff = false;
  song.videoOn = true;
  await updateSong(song.id, { recording: rec, syncPoints: [], syncOffset: 0, videoOff: false, videoOn: true });
  showState();
  if (rec) await setOn(true);
  else if (wasOn) showState();
}

/* ---------- finding the recording on YouTube ---------- */

let autoTried = false; // the linked video is switched on once per opened song
let matches = []; // the last search's results, to step through from the video

const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
let finding = 0;

// A YouTube link written in the file itself (Guitar Pro notices, copyright, instructions…).
function linkInScore() {
  const s = hooks.score?.();
  if (!s) return null;
  const text = [s.notices, s.instructions, s.copyright, s.words, s.music, s.album, s.tab, s.title, s.subTitle].join(' ');
  const m = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:\S*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/.exec(text);
  return m ? { id: m[1], title: 'linked in the tab file', author: '', seconds: 0 } : null;
}

// Searches for the song and lists the matches; the choice is the user's.
async function findOnYouTube() {
  if (!song) return;
  const mine = ++finding;
  const state = $('pa-find-state');
  const list = $('pa-yt-results');
  $('pa-error').textContent = '';
  state.textContent = 'Searching YouTube…';
  $('pa-find').disabled = true;
  let results = [];
  try {
    const linked = linkInScore();
    results = await findRecording(song, hooks.songSeconds?.() || 0).catch((e) => { if (!linked) throw e; return []; });
    if (linked) results.unshift(linked);
  } catch (e) {
    if (mine === finding) {
      state.textContent = '';
      $('pa-error').textContent = `${e?.message || e} Use “Search on youtube.com”, then paste the link.`;
      $('pa-find').disabled = false;
    }
    return;
  }
  if (mine !== finding) return;
  $('pa-find').disabled = false;
  results = results.slice(0, 6);
  matches = results;
  if (!results.length) { state.textContent = 'Nothing found. Try “Search on youtube.com”.'; list.hidden = true; return; }
  state.textContent = 'Best matches first. Click one to play it with the tab:';
  list.innerHTML = '';
  for (const r of results) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.dataset.id = r.id;
    b.title = r.title;
    const img = document.createElement('img');
    img.src = `https://i.ytimg.com/vi/${r.id}/mqdefault.jpg`;
    img.alt = '';
    img.loading = 'lazy';
    const t = document.createElement('span');
    t.className = 'yt-title';
    t.textContent = r.title;
    const meta = document.createElement('span');
    meta.className = 'yt-meta';
    meta.textContent = [r.author, r.seconds ? clock(r.seconds) : ''].filter(Boolean).join(' · ');
    b.append(img, t, meta);
    b.addEventListener('click', () => tryVideo(r));
    li.append(b);
    list.append(li);
  }
  list.hidden = false;
  showState(); // nothing plays until you pick one
}

const useVideo = (r) => setRecording({ kind: 'youtube', id: r.id, title: r.title, author: r.author });

// Picked by hand: play it with the tab from the start, panel closed, so you can hear and
// see whether it matches the chords (‹ › on the video try the other matches).
async function tryVideo(r) {
  if (!r) return;
  hooks.closeSheets();
  const reload = !(on && media?.kind === 'youtube'); // switching videos keeps the loaded MIDI
  if (reload) hooks.playWhenLoaded(); // before the MIDI loads: that's what starts it
  await useVideo(r);
  if (on && !reload) setTimeout(() => hooks.play(), 150);
}

function stepMatch(step) {
  const at = matches.findIndex((r) => r.id === song?.recording?.id);
  tryVideo(matches[at + step]);
}

/** Called by the player when a song is opened (before its score renders). */
export async function playAlongSongOpened(s) {
  if (on) await setOn(false);
  song = s;
  taps = null;
  autoTried = false;
  finding++;
  $('pa-yt-results').hidden = true;
  $('pa-yt-results').innerHTML = '';
  matches = [];
  $('pa-find-state').textContent = '';
  $('pa-find').disabled = false;
  $('pa-tap-state').textContent = '';
  $('pa-rate-note').textContent = '';
  showState();
}

/** Toggle from the play bar. */
export function toggleRecording() {
  if (!song?.recording) { hooks.showSheet('playalong'); findOnYouTube(); return; }
  remember(!on);
  setOn(!on);
}

/** Re-apply sync points after the score changes (another track renders new bars). */
export function playAlongScoreReady() {
  if (on) { applySync(); return; }
  // Only a video you switched on yourself comes back by itself when the song opens.
  if (!autoTried && song?.recording && song.videoOn && !song.videoOff) { autoTried = true; setOn(true); }
}

export function initPlayAlong(h) {
  hooks = h;
  $('pa-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !song) return;
    await setRecording({ kind: 'file', name: file.name, type: file.type, data: await file.arrayBuffer() });
  });
  $('pa-yt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = youTubeId($('pa-yt-url').value);
    if (!id) { $('pa-error').textContent = 'That doesn’t look like a YouTube link.'; return; }
    $('pa-yt-url').value = '';
    await setRecording({ kind: 'youtube', id });
  });
  $('pa-remove').addEventListener('click', () => setRecording(null));
  $('pa-find').addEventListener('click', () => findOnYouTube());
  $('pa-on').addEventListener('change', (e) => { remember(e.target.checked); setOn(e.target.checked); });
  $('pa-toggle').addEventListener('click', toggleRecording);
  $('pa-tap').addEventListener('click', () => { if (!tapSync()) $('pa-tap-state').textContent = 'Play the recording first, then tap on beat 1 of each bar.'; });
  document.querySelectorAll('[data-nudge]').forEach((b) => b.addEventListener('click', () => {
    if (!song) return;
    song.syncOffset = (song.syncOffset || 0) + Number(b.dataset.nudge);
    updateSong(song.id, { syncOffset: song.syncOffset });
    if (on) applySync(); else showSync();
  }));
  const nowSec = (input) => {
    if (!media) { $('pa-skip-state').textContent = 'Turn on the linked video first, then find the spot.'; return; }
    input.value = (media.nowReal() / 1000).toFixed(1);
  };
  $('pa-skip-from-now').addEventListener('click', () => nowSec($('pa-skip-from')));
  $('pa-skip-to-now').addEventListener('click', () => nowSec($('pa-skip-to')));
  $('pa-skip-add').addEventListener('click', () => addSkip(Number($('pa-skip-from').value), Number($('pa-skip-to').value)));
  $('pa-start-chips').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    pendingMaster = Number(b.dataset.master);
    $('pa-start-chips').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    if (!media) { $('pa-start-state').textContent = 'Turn on “Play with the linked video” above first, then scrub to where the music starts.'; return; }
    // The video is where the music starts: that part of the tab starts there, and the tab goes to it.
    setStartBar(pendingMaster);
    applyStartAt(media.nowReal());
    hooks.seekToBar(startIdx());
  });
  let seekAt = 0;
  const seekTo = (sec) => {
    if (!media) return;
    media.seekReal(Math.max(0, Math.min(media.rawDuration || 1e9, sec * 1000)));
  };
  // Hold the time and drag: right goes forward in the video, left back. Small drags move in
  // fractions of a second; past 60 px it speeds up, so a long drag crosses minutes.
  const jog = $('pa-scrub');
  let from = null;
  const jogTo = (x) => {
    const dx = x - from.x;
    const sec = dx * 0.02 + Math.sign(dx) * Math.max(0, Math.abs(dx) - 60) * 0.06;
    from.target = Math.max(0, Math.min((media.rawDuration || 1e9) / 1000, from.sec + sec));
    $('pa-scrub-time').textContent = fmtT(from.target * 1000);
    const now = performance.now();
    if (now - seekAt > 110) { seekAt = now; seekTo(from.target); }
  };
  jog.addEventListener('pointerdown', (e) => {
    if (!media) return;
    jog.setPointerCapture(e.pointerId);
    from = { x: e.clientX, sec: media.nowReal() / 1000, target: media.nowReal() / 1000, moved: false };
    scrubbing = true;
    jog.classList.add('on');
  });
  jog.addEventListener('pointermove', (e) => {
    if (!from) return;
    if (Math.abs(e.clientX - from.x) > 6) from.moved = true;
    if (from.moved) jogTo(e.clientX);
  });
  const jogEnd = () => {
    if (!from) return;
    const j = from;
    from = null;
    scrubbing = false;
    jog.classList.remove('on');
    if (!j.moved) {
      // A tap on the time: play or pause the video there.
      if (media.isPlaying) media.pause(); else media.play();
      setTimeout(() => { $('pa-scrub-play').textContent = media?.isPlaying ? '⏸' : '▶'; }, 250);
      return;
    }
    seekTo(j.target);
    if (hasStart()) applyStartAt(j.target * 1000);
  };
  jog.addEventListener('pointerup', jogEnd);
  jog.addEventListener('pointercancel', jogEnd);
  jog.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 0.1 : e.key === 'ArrowLeft' ? -0.1 : 0;
    if (step && media) {
      e.preventDefault();
      const to = media.nowReal() / 1000 + (e.shiftKey ? step * 10 : step);
      seekTo(to);
      if (hasStart()) applyStartAt(Math.max(0, to) * 1000);
    }
  });
  document.querySelectorAll('[data-scrub]').forEach((b) => b.addEventListener('click', () => {
    if (!media) return;
    const to = media.nowReal() / 1000 + Number(b.dataset.scrub);
    seekTo(to);
    $('pa-scrub-time').textContent = fmtT(Math.max(0, to) * 1000);
    if (hasStart()) applyStartAt(Math.max(0, to) * 1000);
  }));
  $('pa-scrub-play').addEventListener('click', () => {
    if (!media) return;
    if (media.isPlaying) media.pause(); else media.play();
    setTimeout(() => { $('pa-scrub-play').textContent = media?.isPlaying ? '⏸' : '▶'; }, 250);
  });
  $('pa-start-test').addEventListener('click', () => {
    if (!on) { $('pa-start-state').textContent = 'Turn on “Play with the linked video” above first.'; return; }
    hooks.seekToBar(startIdx());
    setTimeout(() => hooks.play(), 300);
  });
  $('pa-clear').addEventListener('click', () => {
    if (!song) return;
    song.syncPoints = [];
    song.syncOffset = 0;
    updateSong(song.id, { syncPoints: [], syncOffset: 0 });
    if (on) applySync(); else showSync();
  });
  // The picture: bigger / smaller, or hidden away (the sound keeps playing); remembered.
  const box = $('pa-video');
  const look = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const save = (key, v) => { try { localStorage.setItem(key, v); } catch { /* ignore */ } };
  const showLook = () => {
    const hidden = box.classList.contains('collapsed');
    $('pa-video-hide').textContent = hidden ? '▢' : '–';
    $('pa-video-hide').title = hidden ? 'Show the video again' : 'Hide the picture (the sound keeps playing)';
    $('pa-video-hide').setAttribute('aria-label', $('pa-video-hide').title);
  };
  box.classList.toggle('mini', look('fretboard-video-mini', matchMedia('(max-width: 640px)').matches ? '1' : '0') === '1'); // small by default on a phone
  box.classList.toggle('collapsed', look('fretboard-video-hidden', '0') === '1');
  showLook();
  $('pa-video-size').addEventListener('click', () => { save('fretboard-video-mini', box.classList.toggle('mini') ? '1' : '0'); });
  $('pa-video-hide').addEventListener('click', () => { save('fretboard-video-hidden', box.classList.toggle('collapsed') ? '1' : '0'); showLook(); });
  $('pa-video-title').addEventListener('click', () => { if (box.classList.contains('collapsed')) $('pa-video-hide').click(); });
  $('pa-video-prev').addEventListener('click', () => stepMatch(-1));
  $('pa-video-next').addEventListener('click', () => stepMatch(1));
}
