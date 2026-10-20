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
const sendPosition = (ms) => { const o = hooks.output(); if (typeof o?.updatePosition === 'function') o.updatePosition(ms); };
let song = null;
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
  let raf = 0, timer = 0;
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
    get backingTrackDuration() { return (el.duration || 0) * 1000; },
    get playbackRate() { return el.playbackRate; },
    set playbackRate(v) { el.playbackRate = v; },
    get masterVolume() { return el.volume; },
    set masterVolume(v) { el.volume = Math.max(0, Math.min(1, v)); },
    seekTo(ms) { el.currentTime = ms / 1000; },
    play() { el.play().catch(() => {}); },
    pause() { el.pause(); },
    now: () => el.currentTime * 1000,
    destroy() { el.pause(); URL.revokeObjectURL(el.src); cancelAnimationFrame(raf); clearInterval(timer); },
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

async function youTubeHandler(rec) {
  await loadYouTubeApi();
  const box = $('pa-video');
  box.hidden = false;
  box.querySelector('.pa-video-frame').innerHTML = '<div id="pa-yt"></div>';
  let player;
  await new Promise((resolve) => {
    player = new window.YT.Player('pa-yt', {
      videoId: rec.id,
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1, controls: 1 },
      events: { onReady: resolve },
    });
  });
  let timer = 0;
  let rate = 1;
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
    get backingTrackDuration() { return (player.getDuration() || 0) * 1000; },
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
    seekTo(ms) { player.seekTo(ms / 1000, true); setTimeout(poll, 50); },
    play() { player.playVideo(); },
    pause() { player.pauseVideo(); },
    now: () => player.getCurrentTime() * 1000,
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
      clearInterval(timer);
      // YouTube's player can throw while tearing down (e.g. its frame already gone).
      try { player.destroy(); } catch { /* ignore */ }
      box.querySelector('.pa-video-frame').innerHTML = '';
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
  return points
    .filter(([p]) => p < bars.length)
    .sort((a, b) => a[0] - b[0])
    .map(([p, ms]) => ({ barIndex: bars[p].masterBar.index, barOccurence: occurrence[p], barPosition: 0, millisecondOffset: Math.max(0, ms + offset) }));
}

function syncPoints() {
  const pts = song?.syncPoints?.length ? song.syncPoints : [[0, 0]];
  return pts;
}

function applySync() {
  const api = hooks.api();
  const score = hooks.score();
  if (!api || !score) return;
  score.applyFlatSyncPoints(flatSyncPoints(syncPoints()));
  api.updateSyncPoints();
  showSync();
}

function showSync() {
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
  const first = taps.points[0][0];
  const last = taps.points.at(-1)[0];
  const kept = (song.syncPoints || []).filter(([p]) => p < first || p > last);
  song.syncPoints = [...kept, ...taps.points].sort((a, b) => a[0] - b[0]);
  updateSong(song.id, { syncPoints: song.syncPoints });
  $('pa-tap-state').textContent = `Saved ${taps.points.length} bar${taps.points.length > 1 ? 's' : ''}.`;
  taps = null;
  applySync();
}

export function playerStateChanged(playing) {
  if (!playing && taps) finishTaps();
}

/* ---------- switching modes ---------- */

export const recordingOn = () => on;

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
  }
  hooks.modeChanged(on);
  showState();
}

function showState() {
  $('pa-on').checked = on;
  $('pa-on').disabled = !song?.recording;
  const rec = song?.recording;
  $('pa-source').textContent = !rec ? 'No recording yet.'
    : rec.kind === 'youtube' ? `YouTube: ${rec.title ? `${rec.title}${rec.author ? ` (${rec.author})` : ''}` : rec.id}` : `Audio file: ${rec.name}`;
  $('pa-yt-search').href = song ? youTubeSearchUrl(song) : '#';
  document.querySelectorAll('#pa-yt-results button').forEach((b) => b.classList.toggle('on', rec?.kind === 'youtube' && b.dataset.id === rec.id));
  $('pa-remove').hidden = !rec;
  document.querySelector('[data-sheet-btn=playalong]')?.classList.toggle('live', on);
  $('pa-toggle').classList.toggle('on', on);
  $('pa-toggle').title = on ? 'Playing the recording (click for the synth)' : 'Play along with the recording';
  $('pa-video').hidden = !(on && rec?.kind === 'youtube');
  $('pa-video-title').textContent = rec?.kind === 'youtube' && rec.title ? rec.title : 'Recording';
  $('pa-video-title').title = $('pa-video-title').textContent;
  const at = matches.findIndex((r) => rec?.kind === 'youtube' && r.id === rec.id);
  $('pa-video-prev').hidden = $('pa-video-next').hidden = matches.length < 2 || at < 0;
  $('pa-video-prev').disabled = at <= 0;
  $('pa-video-next').disabled = at >= matches.length - 1;
  showSync();
}

async function setRecording(rec) {
  // YouTube to YouTube while playing along: same player, new video.
  if (on && media?.kind === 'youtube' && rec?.kind === 'youtube') {
    hooks.api()?.stop();
    song.recording = rec;
    song.syncPoints = [];
    song.syncOffset = 0;
    await updateSong(song.id, { recording: rec, syncPoints: [], syncOffset: 0 });
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
  await updateSong(song.id, { recording: rec, syncPoints: [], syncOffset: 0 });
  showState();
  if (rec) await setOn(true);
  else if (wasOn) showState();
}

/* ---------- finding the recording on YouTube ---------- */

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

// Searches for the song and, with pick on (or no recording yet), uses the best match.
async function findOnYouTube(pick) {
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
  state.textContent = 'Not the right one? Pick another:';
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
  if (pick || !song.recording) await useVideo(results[0]);
  else showState();
}

const useVideo = (r) => setRecording({ kind: 'youtube', id: r.id, title: r.title, author: r.author });

// Picked by hand: play it with the tab from the start, panel closed, so you can hear and
// see whether it matches the chords (‹ › on the video try the other matches).
async function tryVideo(r) {
  if (!r) return;
  hooks.closeSheets();
  const reload = !(on && media?.kind === 'youtube'); // switching videos keeps the loaded MIDI
  await useVideo(r);
  if (on && reload) hooks.playWhenLoaded();
  else if (on) setTimeout(() => hooks.play(), 150);
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
  if (!song?.recording) { hooks.showSheet('playalong'); findOnYouTube(true); return; }
  setOn(!on);
}

/** Re-apply sync points after the score changes (another track renders new bars). */
export function playAlongScoreReady() {
  if (on) applySync();
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
  $('pa-find').addEventListener('click', () => findOnYouTube(true));
  $('pa-on').addEventListener('change', (e) => setOn(e.target.checked));
  $('pa-toggle').addEventListener('click', toggleRecording);
  $('pa-tap').addEventListener('click', () => { if (!tapSync()) $('pa-tap-state').textContent = 'Play the recording first, then tap on beat 1 of each bar.'; });
  document.querySelectorAll('[data-nudge]').forEach((b) => b.addEventListener('click', () => {
    if (!song) return;
    song.syncOffset = (song.syncOffset || 0) + Number(b.dataset.nudge);
    updateSong(song.id, { syncOffset: song.syncOffset });
    if (on) applySync(); else showSync();
  }));
  $('pa-clear').addEventListener('click', () => {
    if (!song) return;
    song.syncPoints = [];
    song.syncOffset = 0;
    updateSong(song.id, { syncPoints: [], syncOffset: 0 });
    if (on) applySync(); else showSync();
  });
  $('pa-video-hide').addEventListener('click', () => $('pa-video').classList.toggle('mini'));
  $('pa-video-prev').addEventListener('click', () => stepMatch(-1));
  $('pa-video-next').addEventListener('click', () => stepMatch(1));
}
