// Play along with the real recording: an audio file or a YouTube video drives playback
// instead of the synth (alphaTab's "external media" mode), and the tab cursor follows it.
// Sync: tap T on beat 1 of each bar as you hear it; every tap becomes a sync point, so the
// tab follows the band's real tempo (including drift) between tapped bars.
import { updateSong } from './db.js';
import { findRecording, youTubeSearchUrl, pickConfident, explainPick, tabEvidence, groupResults } from './ytsearch.js';
import { parseSource } from './tabinfo.js';
import { btDelay, onBtChange, bindBtControls } from './btdelay.js';
import { bpmFromTaps, foldBpm, tempoCompare, guessTempoFromDurations, syncSummary, stashSync, restoreSync } from './videosync.js';

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
  let wantPlay = false; // YouTube starts playing by itself when you seek an idle video; only the play button may start it
  let seekedAt = 0;
  const seekIdle = () => { seekedAt = wantPlay ? 0 : Date.now(); };
  const poll = () => sendPosition(player.getCurrentTime() * 1000);
  const stateChange = (e) => {
    if (e.data === window.YT.PlayerState.PLAYING && !wantPlay && seekedAt && Date.now() - seekedAt < 2000) { player.pauseVideo(); return; }
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
    seekTo(ms) { if (!dead) { seekIdle(); player.seekTo(toReal(Math.max(0, ms - lead())) / 1000, true); setTimeout(poll, 50); } },
    seekReal(ms) { if (!dead) { seekIdle(); player.seekTo(ms / 1000, true); setTimeout(poll, 50); } },
    nowReal: () => player.getCurrentTime() * 1000,
    play() { if (!dead) { wantPlay = true; seekedAt = 0; player.playVideo(); } },
    pause() { wantPlay = false; player.pauseVideo(); },
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
  const offset = totalOffset();
  // Mistapped points (two bars a few ms apart) make the cursor fly through the song: a bar can't
  // last under 0.35 s, so a point that squeezes the bars before it that tight is ignored.
  const sorted = [];
  for (const pt of points.filter(([p]) => p < bars.length).sort((a, b) => a[0] - b[0])) {
    const last = sorted[sorted.length - 1];
    if (last && (pt[1] - last[1]) / Math.max(1, pt[0] - last[0]) < 350) continue;
    sorted.push(pt);
  }
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
  paintScrub(real);
}

// Both position sliders (the sheet's and the pop-up's) show the same video time.
function paintScrub(real) {
  const sec = Math.max(0, real / 1000);
  const max = Math.max(1, (media?.rawDuration || 0) / 1000 || 600);
  for (const [slider, time] of [['pa-scrub', 'pa-scrub-time'], ['pa-vid-scrub', 'pa-vid-time']]) {
    $(slider).max = max;
    $(slider).value = sec;
    $(time).textContent = fmtT(real);
  }
  for (const id of ['pa-scrub-play', 'pa-vid-play']) $(id).textContent = media?.isPlaying ? '⏸' : '▶';
}

function setLabel() {}

// Tempo match: the video's tempo (tapped or typed) gives every bar's time, so the tab keeps
// pace with a video that is faster or slower than the written tempo.
const tempoTaps = [];
/** Keyboard V (or the button): tap the video's beat. At 8 taps the tab follows it live. */
export function tapVideoBeat() {
  const now = performance.now();
  if (tempoTaps.length && now - tempoTaps.at(-1) > 2500) tempoTaps.length = 0;
  tempoTaps.push(now);
  if (tempoTaps.length > 17) tempoTaps.shift();
  const raw = bpmFromTaps(tempoTaps);
  if (raw === null) { $('pa-tempo-state').textContent = 'Keep tapping the beat (V on the keyboard)…'; return; }
  const bpm = foldBpm(raw, hooks.tempo());
  $('pa-vbpm').value = bpm.toFixed(1);
  const cmp = tempoCompare(bpm, hooks.tempo());
  const folded = Math.abs(bpm - raw) > 0.5 ? ` (you tapped ${raw.toFixed(0)}; counted as ${bpm.toFixed(0)})` : '';
  $('pa-tempo-state').textContent = `${tempoTaps.length} taps: ${bpm.toFixed(1)} BPM${folded}, ${cmp.text}. ${tempoTaps.length < 8 ? 'A few more…' : 'Following it; keep tapping to refine.'}`;
  if (tempoTaps.length >= 8 && media && hasStart()) matchTempo(bpm, true);
}

function matchTempo(bpm, quiet = false) {
  if (!song || !(bpm >= 30 && bpm <= 300)) { $('pa-tempo-state').textContent = 'Tap along with the video, or type its BPM.'; return; }
  const bars = hooks.playedBars();
  const at = startIdx();
  const anchor = song.syncPoints?.find(([p]) => p === at)?.[1] ?? 0;
  const perTick = 60000 / (bpm * 960);
  const base = bars[at]?.start || 0;
  song.syncPoints = bars.map((b, p) => [p, Math.round(anchor + (b.start - base) * perTick)]).filter(([p]) => p >= at);
  song.videoBpm = bpm;
  updateSong(song.id, { syncPoints: song.syncPoints, videoBpm: bpm });
  if (!quiet) $('pa-tempo-state').textContent = `Matched: ${tempoCompare(bpm, hooks.tempo()).text}, from ${fmtT(anchor)} in the video. Check the beat; tap again to adjust.`;
  if (on) applySync(); else showSync();
}

// The video's start time follows the scrubber once a part has been chosen.
const hasStart = () => !!song?.syncPoints?.some(([p]) => p === startIdx()) && !!song?.videoMaster;
function applyStartAt(realMs) {
  if (!media || !song) return;
  setStart(Math.max(0, (toPlayed(realMs) - totalOffset()) / 1000));
  fillStartBars();
}

/** Keyboard H: the music starts here, at the chosen part of the tab. */
export function setStartHere() {
  if (!media) return false;
  setStartBar(pendingMaster);
  applyStartAt(media.nowReal());
  hooks.seekToBar(startIdx());
  return true;
}

// A first guess at the tempo from the two lengths, shown until you tap or type one.
function tempoHint() {
  if (!song || !media || song.videoBpm) return '';
  const pt = song.syncPoints?.find(([p]) => p === startIdx());
  const g = guessTempoFromDurations({ tabSeconds: hooks.songSeconds?.() || 0, videoSeconds: (media.rawDuration || 0) / 1000, startSeconds: (pt ? pt[1] : 0) / 1000, tabBpm: hooks.tempo() });
  if (!g) return '';
  if (g.bpm === null) return `The video is ${g.ratio < 1 ? 'much longer' : 'much shorter'} than the tab; if it is a live version, tap its beat.`;
  if (g.sure) return 'The video and tab are about the same length, so the tempo is probably the same.';
  if (!$('pa-vbpm').value) $('pa-vbpm').value = g.bpm.toFixed(1);
  const c = tempoCompare(g.bpm, hooks.tempo());
  return `By length the video looks ${c.pct}% of the tab's speed (about ${g.bpm.toFixed(0)} BPM, filled in); tap the beat (V) to confirm.`;
}

function refreshScrub() {
  for (const id of ['pa-scrub', 'pa-vid-scrub', 'pa-scrub-play', 'pa-vid-play', 'pa-link-here']) $(id).disabled = !media;
  if (media) paintScrub(media.nowReal());
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
    ? `Now: the video's ${fmtT(pt[1])} is the start of ${list.find((s) => s.master === want)?.name || (want ? `bar ${want + 1}` : 'the tab')}.`
    : media ? 'Not set yet: the video starts with the tab. Scrub to the music, pick the part, or press H.' : 'Turn on “Play with the linked video” above, then scrub to find where the music starts.';
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
  if (pts.length || off || song?.videoBpm) {
    const pt = pts.find(([p]) => p === startIdx());
    $('pa-sync-state').textContent = syncSummary({ startText: pt ? fmtT(pt[1]) : '', bpm: song.videoBpm, tabBpm: hooks.tempo?.(), points: pts.length, offsetMs: off, skips: skipList().length });
  }
  if (!tempoTaps.length) { const h = tempoHint(); if (h) $('pa-tempo-state').textContent = h; }
}

/** T while the recording plays: the bar after the last tapped one starts now. */
export function tapSync() {
  if (!on || !media) return false;
  const api = hooks.api();
  if (api.playerState !== 1) return false;
  const bars = hooks.playedBars();
  const ms = media.now() - totalOffset();
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

// Each video keeps its own sync (start, tempo, nudge, skips): going back to one is instant.
function swapSync(rec) {
  const oldId = song.recording?.kind === 'youtube' ? song.recording.id : null;
  const newId = rec?.kind === 'youtube' ? rec.id : null;
  const syncByVideo = stashSync(song, oldId);
  const fresh = restoreSync({ syncByVideo }, newId);
  tempoTaps.length = 0;
  return { syncByVideo, ...fresh };
}

async function setRecording(rec) {
  // YouTube to YouTube while playing along: same player, new video.
  if (on && media?.kind === 'youtube' && rec?.kind === 'youtube') {
    hooks.api()?.stop();
    const swap = swapSync(rec);
    song.recording = rec;
    Object.assign(song, swap);
    song.videoOff = false;
    song.videoOn = true;
    await updateSong(song.id, { recording: rec, ...swap, videoOff: false, videoOn: true });
    await media.cue(rec.id);
    applySync();
    showState();
    return;
  }
  const wasOn = on;
  if (on) await setOn(false);
  const swap = swapSync(rec);
  song.recording = rec;
  Object.assign(song, swap);
  song.videoOff = false;
  song.videoOn = true;
  await updateSong(song.id, { recording: rec, ...swap, videoOff: false, videoOn: true });
  showState();
  if (rec) await setOn(true);
  else if (wasOn) showState();
}

/* ---------- finding the recording on YouTube ---------- */

let autoTried = false; // the linked video is switched on once per opened song
let matches = []; // the last search's results, to step through from the video

const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
// Headphone delay: Bluetooth audio arrives a moment after the video clock, so the tab cursor
// is held back by the same amount. A device setting, not part of the song.
const totalOffset = () => (song?.syncOffset || 0) + btDelay();

let finding = 0;
let findRound = 0; // presses of Find for this song; each one looks for other videos
let shownIds = new Set();
let findSongId = null;

// A YouTube link written in the file itself (Guitar Pro notices, copyright, instructions…).
function linkInScore() {
  const s = hooks.score?.();
  if (!s) return null;
  const text = [s.notices, s.instructions, s.copyright, s.words, s.music, s.album, s.tab, s.title, s.subTitle].join(' ');
  const m = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:\S*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/.exec(text);
  return m ? { id: m[1], title: 'linked in the tab file', author: '', seconds: 0 } : null;
}

// Searches for the song and shows the matches in sections (official, the artist's other
// versions, covers, lyric videos, practice); the choice is the user's. Each search is a
// page: ‹ › go back and forward through the pages, › at the last one looks for more.
let pages = []; // { groups, results, note }
let pageIdx = -1;

function collapseResults() {
  $('pa-yt-results').hidden = true;
  $('pa-yt-nav').hidden = true;
  $('pa-find-state').textContent = '';
  $('pa-find').classList.remove('open');
}

function renderPage(i) {
  const page = pages[i];
  if (!page) return;
  pageIdx = i;
  const list = $('pa-yt-results');
  list.innerHTML = '';
  for (const g of page.groups) {
    const h = document.createElement('li');
    h.className = 'yt-group';
    h.textContent = g.label;
    list.append(h);
    for (const r of g.items) {
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
  }
  matches = page.results;
  list.hidden = false;
  $('pa-yt-nav').hidden = false;
  $('pa-yt-page').textContent = `Search ${i + 1} of ${pages.length}`;
  $('pa-yt-back').disabled = i === 0;
  $('pa-find-state').textContent = page.note;
  $('pa-find').classList.add('open');
  showState();
}

async function findOnYouTube() {
  if (!song) return;
  const mine = ++finding;
  const state = $('pa-find-state');
  $('pa-error').textContent = '';
  state.textContent = 'Searching YouTube…';
  $('pa-find').disabled = true;
  $('pa-yt-fwd').disabled = true;
  if (findSongId !== song.id) { findSongId = song.id; findRound = 0; shownIds = new Set(); pages = []; pageIdx = -1; }
  const round = findRound++;
  let results = [];
  let want = null;
  let confident = null;
  let whyPicked = '';
  if (round === 0) usingBox(null);
  try {
    const linked = round === 0 ? linkInScore() : null;
    const secs = hooks.songSeconds?.() || 0;
    const ev = tabEvidence(song.sourceUrl ? parseSource(song.sourceUrl) : null, (hooks.score?.()?.tracks || []).map((t) => t.name));
    results = await findRecording(song, secs, ev, round, [...shownIds]).catch((e) => { if (!linked) throw e; return []; });
    want = results.want || null;
    if (linked) { results.unshift(linked); confident = linked; whyPicked = 'the file links to it'; }
    else if (round > 0) { confident = null; whyPicked = ''; } // asked again: show choices, don't pick for them
    else { confident = pickConfident(results, secs); whyPicked = confident && want ? explainPick(confident, want) : ''; }
  } catch (e) {
    findRound--;
    if (mine === finding) {
      state.textContent = '';
      $('pa-error').textContent = `${e?.message || e} Use “Search on youtube.com”, then paste the link.`;
      $('pa-find').disabled = false;
      $('pa-yt-fwd').disabled = false;
    }
    return;
  }
  if (mine !== finding) return;
  $('pa-find').disabled = false;
  $('pa-yt-fwd').disabled = false;
  const groups = groupResults(results, shownIds);
  if (linked_in(results)) groups.unshift({ key: 'official', label: 'Linked in the tab file', items: results.filter((r) => !r.cat) });
  const flat = groups.flatMap((g) => g.items);
  flat.forEach((r) => shownIds.add(r.id));
  if (!flat.length) {
    findRound--;
    state.textContent = pages.length ? 'No more videos found.' : 'Nothing found. Try “Search on youtube.com”.';
    return;
  }
  pages.push({ groups, results: flat, note: round ? 'Different videos. › looks for more.' : (confident ? 'Other matches:' : 'Official first, then other versions, covers, lyrics and practice videos:') });
  renderPage(pages.length - 1);
  if (confident) {
    if (!song.recording) { usingBox(confident, whyPicked); await useVideo(confident); collapseResults(); } // attach only; never replaces a video already chosen
  }
}
const linked_in = (list) => list.some((r) => !r.cat);

/** The Find button: opens the results, and closes them when they are already showing. */
function findButton() {
  if (!song) return;
  if (!$('pa-yt-results').hidden) { collapseResults(); return; }
  if (pages.length && findSongId === song.id) { renderPage(pageIdx); return; }
  findOnYouTube();
}

// "Using: <title> (change)" with the reason; (change) shows the runner-ups.
function usingBox(r, why = '') {
  const box = $('pa-using');
  if (!box) return;
  box.hidden = !r;
  if (!r) return;
  $('pa-using-text').textContent = `Using: ${r.title}${r.author ? ` — ${r.author}` : ''}`;
  $('pa-using-why').textContent = why ? `Picked because: ${why}.` : '';
}

const useVideo = (r) => setRecording({ kind: 'youtube', id: r.id, title: r.title, author: r.author });

// Picked by hand: link it with the panel closed; press play to hear and
// see whether it matches the chords (‹ › on the video try the other matches).
async function tryVideo(r) {
  if (!r) return;
  hooks.closeSheets();
  await useVideo(r); // nothing starts by itself: press play (or G) when you want to hear it
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
  usingBox(null);
  matches = [];
  $('pa-find-state').textContent = '';
  $('pa-find').disabled = false;
  $('pa-tap-state').textContent = '';
  $('pa-rate-note').textContent = '';
  showState();
}

/** Toggle from the play bar. */
/** G: start the video from the part of the song being played (or looked at). */
export async function startVideoHere() {
  const api = hooks.api();
  if (!api || !song) return;
  if (!song.recording) { hooks.showSheet('playalong'); findButton(); return; }
  const bars = hooks.playedBars();
  const tick = api.tickPosition;
  let idx = 0;
  bars.forEach((b, i) => { if (b.start <= tick) idx = i; });
  if (!on) { remember(true); await setOn(true); }
  const go = () => { hooks.seekToBar(idx); api.play(); };
  setTimeout(go, on ? 250 : 0);
}

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
  $('pa-find').addEventListener('click', findButton);
  $('pa-yt-back').addEventListener('click', () => renderPage(Math.max(0, pageIdx - 1)));
  $('pa-yt-fwd').addEventListener('click', () => { if (pageIdx < pages.length - 1) renderPage(pageIdx + 1); else findOnYouTube(); });
  $('pa-using-change').addEventListener('click', () => { if (pages.length) renderPage(pageIdx); else findOnYouTube(); });
  $('pa-on').addEventListener('change', (e) => { remember(e.target.checked); setOn(e.target.checked); });
  $('pa-toggle').addEventListener('click', toggleRecording);
  $('pa-tap').addEventListener('click', () => { if (!tapSync()) $('pa-tap-state').textContent = 'Play the recording first, then tap on beat 1 of each bar.'; });
  bindBtControls({ button: $('pa-bt'), input: $('pa-bt-ms'), nudges: document.querySelectorAll('#pa-bt-row [data-bt]') });
  onBtChange(() => { if (song && on) applySync(); });
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
  // The position sliders: the number shown is the video's own time, to a tenth of a second.
  let hear = true;
  try { hear = localStorage.getItem('fretboard-scrub-hear') !== '0'; } catch { /* ignore */ }
  const paintHear = () => ['pa-hear', 'pa-hear2'].forEach((id) => { $(id).classList.toggle('on', hear); $(id).setAttribute('aria-pressed', String(hear)); });
  paintHear();
  ['pa-hear', 'pa-hear2'].forEach((id) => $(id).addEventListener('click', () => {
    hear = !hear;
    try { localStorage.setItem('fretboard-scrub-hear', hear ? '1' : '0'); } catch { /* ignore */ }
    paintHear();
  }));
  // While scrubbing the video plays (if you want to hear it) and goes quiet again when you let go.
  let resumeQuiet = false;
  const startScrub = () => {
    scrubbing = true;
    if (hear && media && !media.isPlaying) { resumeQuiet = true; media.play(); }
  };
  const endScrub = () => {
    scrubbing = false;
    if (resumeQuiet) { resumeQuiet = false; media?.pause(); }
  };
  const finishScrub = (sec) => {
    seekTo(sec);
    if (hasStart()) applyStartAt(sec * 1000);
    endScrub();
    setTimeout(() => media && paintScrub(media.nowReal()), 300);
  };
  const bindScrub = (slider, time) => {
    let last = 0;
    slider.addEventListener('pointerdown', startScrub);
    slider.addEventListener('input', () => {
      if (!media) return;
      const sec = Number(slider.value);
      $(time).textContent = fmtT(sec * 1000);
      const now = performance.now();
      if (now - last > 90) { last = now; seekTo(sec); }
    });
    slider.addEventListener('change', () => media && finishScrub(Number(slider.value)));
    slider.addEventListener('pointerup', () => { if (!media) endScrub(); });
  };
  // The time itself is a fine scrubber, like the tempo number: hold it and drag sideways,
  // 0.1 s for every 5 pixels in a straight line, so the number is exactly where the video is.
  const bindJog = (el, slider) => {
    let from = null;
    let last = 0;
    el.addEventListener('pointerdown', (e) => {
      if (!media) return;
      el.setPointerCapture(e.pointerId);
      from = { x: e.clientX, sec: media.nowReal() / 1000, target: media.nowReal() / 1000, moved: false };
    });
    el.addEventListener('pointermove', (e) => {
      if (!from) return;
      if (!from.moved) { if (Math.abs(e.clientX - from.x) < 4) return; from.moved = true; startScrub(); el.classList.add('on'); }
      from.target = Math.max(0, Math.min((media.rawDuration || 1e9) / 1000, from.sec + Math.round((e.clientX - from.x) / 5) / 10));
      el.textContent = fmtT(from.target * 1000);
      slider.value = from.target;
      const now = performance.now();
      if (now - last > 70) { last = now; seekTo(from.target); }
    });
    const end = () => {
      if (!from) return;
      const j = from;
      from = null;
      el.classList.remove('on');
      if (!j.moved) { if (media.isPlaying) media.pause(); else media.play(); setTimeout(() => paintScrub(media.nowReal()), 250); return; } // a tap plays or pauses
      finishScrub(j.target);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  bindScrub($('pa-scrub'), 'pa-scrub-time');
  bindScrub($('pa-vid-scrub'), 'pa-vid-time');
  bindJog($('pa-scrub-time'), $('pa-scrub'));
  bindJog($('pa-vid-time'), $('pa-vid-scrub'));
  $('pa-vid-play').addEventListener('click', () => $('pa-scrub-play').click());
  // From the song screen: the video is at the moment the music starts; the selected bar (or the
  // one the cursor is on) is what starts there.
  $('pa-link-here').addEventListener('click', () => {
    if (!media) return;
    const master = hooks.cursorMaster();
    setStartBar(master);
    applyStartAt(media.nowReal());
    hooks.seekToBar(startIdx());
    $('pa-link-note').textContent = `Bar ${master + 1} = ${fmtT(media.nowReal())}`;
  });
  document.querySelectorAll('[data-scrub]').forEach((b) => b.addEventListener('click', () => {
    if (!media) return;
    const to = media.nowReal() / 1000 + Number(b.dataset.scrub);
    seekTo(to);
    $('pa-scrub-time').textContent = fmtT(Math.max(0, to) * 1000);
    if (hear && !media.isPlaying) { media.play(); setTimeout(() => { if (!scrubbing) media?.pause(); }, 600); } // a short listen at the new spot
    if (hasStart()) applyStartAt(Math.max(0, to) * 1000);
  }));
  $('pa-scrub-play').addEventListener('click', () => {
    if (!media) return;
    if (media.isPlaying) media.pause(); else media.play();
    setTimeout(() => { $('pa-scrub-play').textContent = media?.isPlaying ? '⏸' : '▶'; }, 250);
  });
  $('pa-tempo-tap').addEventListener('pointerdown', (e) => { e.preventDefault(); tapVideoBeat(); });
  $('pa-vbpm').addEventListener('change', () => { if (media && hasStart() && Number($('pa-vbpm').value) >= 30) matchTempo(Number($('pa-vbpm').value)); });
  $('pa-tempo-match').addEventListener('click', () => matchTempo(Number($('pa-vbpm').value)));
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
