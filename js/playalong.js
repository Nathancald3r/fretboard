// Play along with the real recording: an audio file or a YouTube video drives playback
// instead of the synth (alphaTab's "external media" mode), and the tab cursor follows it.
// Sync: tap T on beat 1 of each bar as you hear it; every tap becomes a sync point, so the
// tab follows the band's real tempo (including drift) between tapped bars.
import { updateSong as saveSong } from './db.js';
import { syncState } from './songmeta.js';
import { findRecording, youTubeSearchUrl, pickConfident, explainPick, tabEvidence, groupResults } from './ytsearch.js';
import { parseSource } from './tabinfo.js';
import { btDelay, onBtChange, bindBtControls } from './btdelay.js';
import { clickTrackBuffer } from './click.js';
import { loadYouTubeApi } from './ytapi.js';
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
  let held = false; // handed over to the synth: plays on by itself until it fades out
  let wantPlay = false;
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
    el,
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
    play() { if (dead) return; wantPlay = true; whenReady(() => { if (!dead && wantPlay) el.play().catch(() => {}); }); },
    pause() { if (!held) { wantPlay = false; el.pause(); } },
    now: () => toPlayed(el.currentTime * 1000),
    hold() { dead = true; held = true; },
    destroy() { dead = true; held = false; el.pause(); URL.revokeObjectURL(el.src); cancelAnimationFrame(raf); clearInterval(timer); },
  };
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
  // The length is 0 until YouTube has loaded the video's details; the tab's timing needs it.
  for (let i = 0; i < 50 && !(player.getDuration?.() > 0); i++) await new Promise((r) => setTimeout(r, 100));
  let timer = 0;
  let rate = 1;
  let dead = false; // a switched-off handler must not move or play anything
  let held = false; // handed over to the synth: plays on by itself until it fades out
  let wantPlay = false; // YouTube starts playing by itself when you seek an idle video; only the play button may start it
  let seekedAt = 0;
  let gating = false; // holding the video until your tracks are made
  const seekIdle = () => { seekedAt = wantPlay ? 0 : Date.now(); };
  // For about a quarter second after it starts or seeks, YouTube's clock runs ahead and then jumps
  // back. It counts as steady once its readings have kept time with the wall clock for 0.3 s.
  let anchor = null, steadyFrom = 0, playingAt = 0;
  const poll = () => {
    const t = player.getCurrentTime() * 1000, w = performance.now();
    if (!anchor || Math.abs(t - (anchor[0] + (w - anchor[1]) * rate)) > 25) { anchor = [t, w]; steadyFrom = w; }
    sendPosition(t);
  };
  const stateChange = (e) => {
    if (held || dead) return; // YouTube never really removes a listener: a switched-off handler must ignore it
    if (e.data === window.YT.PlayerState.PLAYING && !wantPlay && seekedAt && Date.now() - seekedAt < 2000) { player.pauseVideo(); return; }
    // Play pressed on the video itself while your tracks aren't made yet: it waits for them too.
    if (e.data === window.YT.PlayerState.PAUSED && gating) return;
    if (e.data === window.YT.PlayerState.PLAYING && !gating) {
      const wait = mineWait();
      if (wait) {
        gating = true;
        wantPlay = true;
        player.pauseVideo();
        const api = hooks.api();
        if (api && api.playerState !== 1) api.play();
        wait.then(() => { gating = false; if (!dead && wantPlay) player.playVideo(); });
        return;
      }
    }
    clearInterval(timer);
    anchor = null;
    if (e.data === window.YT.PlayerState.PLAYING) { playingAt = performance.now(); timer = setInterval(poll, 30); }
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
    get steady() { const w = performance.now(); return this.isPlaying && !!anchor && w - steadyFrom >= 300 && w - playingAt >= 450; },
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
    seekTo(ms) { if (!dead) { seekIdle(); anchor = null; player.seekTo(toReal(Math.max(0, ms - lead())) / 1000, true); setTimeout(poll, 50); } },
    // ahead=false (while scrubbing) only moves within what YouTube has already loaded, so it never stalls on buffering; the final seek on release loads the exact spot.
    seekReal(ms, ahead = true) { if (!dead) { seekIdle(); anchor = null; player.seekTo(ms / 1000, ahead); setTimeout(poll, 50); } },
    nowReal: () => player.getCurrentTime() * 1000,
    play() { if (dead) return; wantPlay = true; seekedAt = 0; whenReady(() => { if (!dead && wantPlay) player.playVideo(); }); },
    pause() { if (!held) { wantPlay = false; player.pauseVideo(); } },
    hold() { dead = true; held = true; },
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
      held = false;
      clearInterval(timer);
      player.removeEventListener('onStateChange', stateChange);
      try { player.pauseVideo(); player.stopVideo(); } catch { /* ignore */ }
      box.hidden = true;
    },
  };
}

let rateToast = '';
function showRateNote(wanted, got) {
  const text = Math.abs(wanted - got) > 0.01
    ? `YouTube plays at ${Math.round(got * 100)}% (the nearest speed it offers). An audio file can play at any speed.`
    : '';
  $('pa-rate-note').textContent = text;
  // Said once per speed: the tab, the click and your tracks all follow the video, so a speed it can't
  // play would otherwise look like the click and the tab running slow.
  const say = text && `${Math.round(wanted * 100)}% isn’t a YouTube speed: the video, the tab and the click play at ${Math.round(got * 100)}%. Pick a speed in 25% steps for the video.`;
  if (say && say !== rateToast) window.dispatchEvent(new CustomEvent('fbtoast', { detail: say }));
  rateToast = say;
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

// With nothing saved, every bar is placed at the tab's own tempo from the start point, so a video that
// is shorter or longer than the tab can't stretch or squeeze the whole song.
function syncPoints() {
  const bars = hooks.playedBars();
  if (song?.syncPoints?.length) {
    // Points that run backwards (left over from an earlier move of the start) make the cursor and video
    // jump back and forth, so only an increasing run is kept; past the last point the bars carry on at
    // the video's tempo (or the tab's) instead of leaving it to chance.
    const kept = [];
    for (const pt of [...song.syncPoints].sort((x, y) => x[0] - y[0])) {
      if (!kept.length || (pt[0] > kept[kept.length - 1][0] && pt[1] > kept[kept.length - 1][1])) kept.push(pt);
    }
    const last = kept[kept.length - 1];
    const bpm = song.videoBpm || hooks.tempo();
    if (last && bars[last[0]] && bpm > 0 && last[0] < bars.length - 1) {
      const perTick = 60000 / (bpm * 960);
      for (let p = last[0] + 1; p < bars.length; p++) kept.push([p, Math.round(last[1] + (bars[p].start - bars[last[0]].start) * perTick)]);
    }
    return kept;
  }
  const at = startIdx();
  const tempo = hooks.tempo();
  if (!bars[at] || !(tempo > 0)) return [[at, 0]];
  const perTick = 60000 / (tempo * 960);
  return bars.map((b, p) => [p, Math.round((b.start - bars[at].start) * perTick)]).filter(([p]) => p >= at);
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
let stickHeld = false;
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
// After you let go of a scrubber the video needs a moment (buffering) to arrive; until it is close to where you
// put it, the sliders stay where you put them instead of jumping back to the old position.
let settle = null;
function paintScrub(real) {
  if (settle) {
    if (performance.now() > settle.until || Math.abs(real / 1000 - settle.sec) < 0.7) settle = null;
    else real = settle.sec * 1000;
  }
  const sec = Math.max(0, real / 1000);
  const max = Math.max(1, (media?.rawDuration || 0) / 1000 || 600);
  for (const [slider, time] of [['pa-scrub', 'pa-scrub-time']]) {
    $(slider).max = max;
    $(slider).value = sec;
    $(time).textContent = fmtT(real);
  }
  if (!stickHeld) $('pa-vid-time').textContent = fmtT(real);
  for (const id of ['pa-scrub-play']) $(id).textContent = media?.isPlaying ? '⏸' : '▶';
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
  for (const id of ['pa-scrub', 'pa-scrub-play', 'pa-link-here']) $(id).disabled = !media;
  $('pa-vid-jog').setAttribute('aria-disabled', String(!media));
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

// Where bar `p` falls in the video, given the synced points: between two points it is interpolated,
// beyond the ends it follows the video's tempo (or the tab's).
function timeOf(pts, p) {
  const bars = hooks.playedBars();
  const perTick = 60000 / ((song?.videoBpm || hooks.tempo() || 100) * 960);
  const sorted = [...pts].sort((a, b) => a[0] - b[0]);
  const exact = sorted.find(([q]) => q === p);
  if (exact) return exact[1];
  const tick = (q) => bars[q]?.start ?? 0;
  const next = sorted.find(([q]) => q > p);
  const prev = [...sorted].reverse().find(([q]) => q < p);
  if (prev && next) return prev[1] + ((tick(p) - tick(prev[0])) / Math.max(1, tick(next[0]) - tick(prev[0]))) * (next[1] - prev[1]);
  const from = prev || next;
  return from ? from[1] + (tick(p) - tick(from[0])) * perTick : 0;
}

function setStartBar(master) {
  if (!song) return;
  const oldAt = startIdx();
  const oldPts = syncPoints(); // what is playing now (saved points, or the tab's own tempo)
  const oldPt = song.syncPoints?.find(([p]) => p === oldAt);
  song.videoMaster = master;
  const at = startIdx();
  // Moving the start must not change how long the bars last: every later bar keeps its distance from the start.
  const base = oldPt ? oldPt[1] : 0;
  const here = timeOf(oldPts, at);
  const rest = oldPts.filter(([p]) => p > at).map(([p, t]) => [p, Math.max(0, Math.round(base + t - here))]);
  song.syncPoints = [[at, base], ...rest];
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
  if (taps.next >= bars.length) return false; // past the last bar
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

/* ---------- hearing the tab with the recording ---------- */

// To check a tab against its recording: the tab's own instruments play along with it. The tab is
// rendered to audio once with the sync points, so its time is the recording's time, and kept in
// step with the recording while it plays. 'right' puts the tab in the right ear and an audio-file
// recording in the left (YouTube's sound can't be moved: it stays in both ears).
// The click track is built the same way (on its own, so switching it is instant): with the video
// on, the player's synth is silent and this is the only way to hear it.
const MINE_MODES = { off: 'Off', both: 'With the recording', right: 'My tracks in the right ear' };
const mine = { mode: 'off', level: 0.8, ctx: null, out: null, pan: null, at: 0, ctxAt: 0, rate: 1, timer: 0, fileEl: null, fileNode: null };
const layer = (kind) => ({ kind, buf: null, key: '', busy: null, src: null, gain: null });
const layers = [layer('tracks'), layer('click')];
try { mine.mode = MINE_MODES[localStorage.getItem('fretboard-mine')] ? localStorage.getItem('fretboard-mine') : 'off'; mine.level = Number(localStorage.getItem('fretboard-mine-level')) || 0.8; } catch { /* ignore */ }

function mineCtx() {
  if (!mine.ctx) {
    mine.ctx = new AudioContext({ latencyHint: 'interactive' });
    mine.out = mine.ctx.createGain(); // fades in and out, so a start or a jump never pops
    mine.pan = mine.ctx.createStereoPanner();
    mine.out.connect(mine.pan).connect(mine.ctx.destination);
    for (const l of layers) { l.gain = mine.ctx.createGain(); l.gain.connect(mine.out); }
  }
  if (mine.ctx.state === 'suspended') mine.ctx.resume().catch(() => {});
  return mine.ctx;
}

const wanted = (l) => (l.kind === 'tracks' ? mine.mode !== 'off' : !!hooks.clickWanted?.());
// alphaTab's audio render drops a shift shared by every sync point (it starts bar 1 at 0 s), so a
// nudge never moved the tracks' sound, only the cursor. The tracks are rendered from the points
// less the first one's time, and played that much later: a nudge is then heard at once, unrendered.
const tracksAt = () => (flatSyncPoints(syncPoints())[0]?.millisecondOffset || 0) / 1000;
const relSync = () => { const pts = flatSyncPoints(syncPoints()); const base = pts[0]?.millisecondOffset || 0; return pts.map((p) => [p.barIndex, p.barOccurence, p.millisecondOffset - base]); };
// What each rendered layer depends on: the song, its sync, and the mixer or the click's settings.
const layerKey = (l) => JSON.stringify([song?.id, l.kind === 'tracks' ? relSync() : flatSyncPoints(syncPoints()), l.kind === 'tracks' ? hooks.trackLevels?.() : hooks.clickSig?.()]);

// The sync as a line of [tick, video ms] corners (the video's played time, nudge included), one
// per bar; past either end it carries on at the tab's own tempo.
function syncLine() {
  const bars = hooks.playedBars();
  const off = totalOffset();
  const pts = syncPoints().filter(([p]) => bars[p]).map(([p, t]) => [bars[p].start, t + off]);
  const perTick = 60000 / ((hooks.tempo() || 100) * 960);
  if (!pts.length) pts.push([0, off]);
  if (pts.length === 1) pts.push([pts[0][0] + 960, pts[0][1] + 960 * perTick]);
  return pts;
}
// Reads the line: from column `from` (0 = tick, 1 = ms) to column `to`.
function along(pts, x, from, to) {
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1][from] <= x) i++;
  const [a, b] = [pts[i], pts[i + 1]];
  return a[to] + ((x - a[from]) * (b[to] - a[to])) / ((b[from] - a[from]) || 1);
}

// The click track in the rendered audio's time: each click at its tick's place in the video.
async function renderClick(ctx) {
  const pts = syncLine();
  const shift = lead();
  const hits = hooks.clickHits().map(({ tick, level }) => ({ t: (along(pts, tick, 0, 1) + shift) / 1000, level }));
  const end = hits.length ? hits[hits.length - 1].t + 1 : 1;
  return clickTrackBuffer(ctx, hits, hooks.clickSound(), end);
}

const mineState = (text) => { $('pa-mine-state').textContent = text; };

async function renderLayer(l, key) {
  const api = hooks.api();
  const ctx = mineCtx();
  if (l.kind === 'click') return renderClick(ctx);
  mineState('Getting your tracks ready…');
  const opts = new AT.synth.AudioExportOptions();
  opts.soundFonts = [await hooks.soundFontBytes()];
  opts.useSyncPoints = true;
  opts.sampleRate = ctx.sampleRate;
  opts.masterVolume = hooks.synthGain();
  hooks.trackLevels().forEach((v, i) => opts.trackVolume.set(i, v));
  const ex = await api.exportAudio(opts);
  const parts = [];
  let n = 0;
  try {
    for (let c; (c = await ex.render(2000));) {
      if (l.busy?.key !== key) return null; // the sync or the mix changed: a newer render takes over
      parts.push(c.samples);
      n += c.samples.length;
      mineState(`Getting your tracks ready… ${Math.round((100 * c.currentTime) / Math.max(1, c.endTime))}%`);
    }
  } finally { ex.destroy?.(); }
  const buf = ctx.createBuffer(2, Math.max(1, n / 2), ctx.sampleRate);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let j = 0;
  for (const s of parts) for (let i = 0; i < s.length; i += 2, j++) { L[j] = s[i]; R[j] = s[i + 1]; }
  return buf;
}

// One render at a time (the click first, it's quick).
function mineRender() {
  if (layers.some((l) => l.busy)) return;
  for (const l of [layers[1], layers[0]]) {
    if (!wanted(l)) continue;
    const key = layerKey(l);
    if (l.key === key) continue;
    const busy = { key };
    l.busy = busy;
    renderLayer(l, key).then((buf) => {
      if (l.busy !== busy) return;
      l.busy = null;
      if (!buf) return;
      l.buf = buf; l.key = key;
      mineStop(); // starts again with the new audio on the next tick
      showMine();
    }).catch((e) => { console.warn('Tab sound render failed', e); if (l.busy === busy) { l.busy = null; l.key = key; mineState('Couldn’t make the tab’s sound: ' + (e?.message || e)); } });
    return;
  }
}

// A quick fade (15 ms) before stopping, so cutting the sound off never clicks or pops.
function mineStop() {
  const playing = layers.filter((l) => l.src);
  if (!playing.length) return;
  const t = mine.ctx.currentTime;
  mine.out.gain.cancelScheduledValues(t);
  mine.out.gain.setValueAtTime(mine.out.gain.value, t);
  mine.out.gain.linearRampToValueAtTime(0, t + 0.015);
  for (const l of playing) {
    const src = l.src;
    l.src = null;
    try { src.stop(t + 0.02); } catch { /* not started */ }
    setTimeout(() => src.disconnect(), 60);
  }
}

// The recording's ears: an audio file goes left while the tab is in the right ear.
function mineEars() {
  const right = mine.mode === 'right';
  if (mine.pan) mine.pan.pan.value = right ? 1 : 0;
  for (const l of layers) if (l.gain) l.gain.gain.value = l.kind === 'tracks' ? mine.level : (hooks.clickLevel?.() ?? 0.8);
  const el = media?.kind === 'file' ? media.el : null;
  if (el && right && mine.fileEl !== el) {
    const ctx = mineCtx();
    mine.fileEl = el;
    mine.fileNode = ctx.createStereoPanner();
    ctx.createMediaElementSource(el).connect(mine.fileNode).connect(ctx.destination);
  }
  if (mine.fileNode && mine.fileEl === el) mine.fileNode.pan.value = right ? -1 : 0;
}

// The tab's sound reaches your ears this long after it is started (the browser's audio buffer
// and the output device). The video's clock already allows for its own delay, so the tab is
// started this much further on and both are heard together, on headphones too.
const outDelay = () => (mine.ctx ? (mine.ctx.outputLatency || 0) + (mine.ctx.baseLatency || 0) : 0);

// Every 100 ms while the video is on: start, follow and stop the tab's sound with the recording.
function mineTick() {
  const live = layers.filter((l) => wanted(l));
  if (!on || !media || !live.length) { mineStop(); return; }
  mineEars();
  mineRender();
  const ready = live.filter((l) => l.buf);
  if (!ready.length || !media.isPlaying) { mineStop(); return; }
  const ctx = mineCtx();
  // Where the recording is, in the rendered audio's time (the sync points' time).
  const pos = (media.now() + lead() + btDelay()) / 1000 + outDelay();
  const rate = media.playbackRate || 1;
  const running = layers.filter((l) => l.src);
  const shift = tracksAt();
  if (running.length && running.length === ready.length && ready.every((l) => l.src) && shift === mine.shift) {
    mine.at += (ctx.currentTime - mine.ctxAt) * running[0].src.playbackRate.value;
    mine.ctxAt = ctx.currentTime;
    const ahead = mine.at - pos;
    // Started on YouTube's unsteady first readings: carry on as started until its clock is steady,
    // then line up once, closely (the start's nudge: it was ~40 ms early for seconds).
    const steady = media.steady !== false;
    if (!steady && rate === mine.rate) return;
    const jump = mine.synced ? 0.15 : 0.02;
    // The video's clock reads a few ms off each time: under 20 ms the speed stays exact. More drift
    // is eased out (at most 0.5 %, which can't be heard); a jump starts again from there.
    if (Math.abs(ahead) < jump && rate === mine.rate) {
      mine.synced = true;
      const ease = Math.abs(ahead) < 0.02 ? 0 : Math.max(-0.005, Math.min(0.005, ahead / 4));
      for (const l of running) l.src.playbackRate.value = rate * (1 - ease);
      return;
    }
  }
  mineStop();
  // Starts just after the fade-out of what was playing, and fades in over 15 ms.
  const t = ctx.currentTime + 0.025;
  const at = pos + 0.025 * rate;
  if (at < 0) return;
  for (const l of ready) {
    // the tracks' audio starts at the first sync point (the click's is in the video's own time)
    const from = l.kind === 'tracks' ? at - shift : at;
    if (from >= l.buf.duration) continue;
    const src = ctx.createBufferSource();
    src.buffer = l.buf;
    src.playbackRate.value = rate;
    src.connect(l.gain);
    if (from < 0) src.start(t - from / rate, 0); else src.start(t, from);
    l.src = src;
  }
  mine.out.gain.setValueAtTime(0, t);
  mine.out.gain.linearRampToValueAtTime(1, t + 0.015);
  Object.assign(mine, { at, ctxAt: t, rate, shift, synced: media.steady !== false });
}

// The video waits until your tracks (and the click) are made, so they all start together and
// never come in part way.
let waiting = null;
function mineWait() {
  const missing = () => on && layers.some((l) => wanted(l) && l.key !== layerKey(l));
  if (!missing()) return null;
  if (waiting) return waiting;
  mineCtx();
  toast('Getting your tracks ready: the video starts when they are.');
  waiting = new Promise((resolve) => {
    const t = setInterval(() => { mineRender(); if (!missing()) { clearInterval(t); waiting = null; resolve(); } }, 100);
  });
  return waiting;
}

function whenReady(go) {
  syncCheck();
  const wait = mineWait();
  if (wait) wait.then(go); else go();
}

// Said once per song, before it first plays with its recording: does the sync hold up?
let checkedSong = null;
function syncCheck() {
  if (!song || !media || checkedSong === song.id) return;
  checkedSong = song.id;
  const bars = hooks.playedBars();
  if (!bars.length) return;
  if (!song.syncPoints?.length) { toast('Sync check: not synced yet. The tab plays at its own tempo from the start you set.'); return; }
  const pts = syncPoints().filter(([p]) => bars[p]);
  const issues = [];
  // A bar much faster or slower than both its neighbours is a stray point (a real tempo change stays).
  const speed = pts.slice(1).map(([p, t], i) => (t - pts[i][1]) / Math.max(1, bars[p].start - bars[pts[i][0]].start));
  const odd = [];
  for (let i = 1; i < speed.length - 1; i++) {
    const a = speed[i] / speed[i - 1] - 1, b = speed[i] / speed[i + 1] - 1;
    if (Math.abs(a) > 0.03 && Math.abs(b) > 0.03 && a * b > 0) odd.push(pts[i][0] + 1);
  }
  if (odd.length) issues.push(`bar${odd.length > 1 ? 's' : ''} ${odd.slice(0, 5).join(', ')}${odd.length > 5 ? '…' : ''} jump in speed`);
  const len = (media.rawDuration || 0) - skippedTotal();
  const end = pts[pts.length - 1][1] + totalOffset();
  if (len > 0 && end > len + 2000) issues.push(`the tab runs ${Math.round((end - len) / 1000)} s past the end of the recording`);
  const lastSet = Math.max(...song.syncPoints.map(([p]) => p)) + 1;
  if (lastSet < bars.length - 4) issues.push(`only bars 1–${lastSet} are lined up (the rest follow the tab’s tempo)`);
  toast(issues.length
    ? `Sync check: ${issues.join('; ')}. It may drift there.`
    : `Sync check: OK. All ${bars.length} bars line up with the recording.`);
}
const toast = (text) => window.dispatchEvent(new CustomEvent('fbtoast', { detail: text }));

function setMine(mode = mine.mode, level = mine.level) {
  mine.mode = MINE_MODES[mode] ? mode : 'off';
  mine.level = level;
  try { localStorage.setItem('fretboard-mine', mine.mode); localStorage.setItem('fretboard-mine-level', String(level)); } catch { /* ignore */ }
  if (on) mineCtx();
  mineEars();
  clearInterval(mine.timer);
  mine.timer = on ? setInterval(mineTick, 100) : 0;
  mineTick();
  showMine();
}

const svgIcon = (d, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON_NOTE = svgIcon('<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>', 17);
const ICON_HIDE = svgIcon('<path d="M6 9l6 6 6-6"/>', 19);
const ICON_SHOW = svgIcon('<path d="M6 15l6-6 6 6"/>', 19);

function showMine() {
  $('pa-mine').value = mine.mode;
  $('pa-mine-vol').value = mine.level;
  const b = $('pa-mine-btn');
  const yt = media?.kind === 'youtube';
  b.classList.toggle('on', mine.mode !== 'off');
  b.setAttribute('aria-pressed', String(mine.mode !== 'off'));
  b.innerHTML = `${ICON_NOTE}<span>${{ off: 'Mine', both: 'Mine on', right: 'Mine R' }[mine.mode]}</span>`;
  b.title = `Hear this tab's own instruments with the video, to check it (now: ${MINE_MODES[mine.mode]}). Click to switch.`
    + (mine.mode === 'right' && yt ? ' YouTube’s sound can’t be moved, so the video stays in both ears.' : '');
  if (layers[0].busy) return; // the render shows its progress
  mineState(mine.mode === 'right' && yt ? 'Your tracks are in the right ear. YouTube’s sound can’t be moved, so the video stays in both ears (an audio file goes to the left).' : '');
}

/* ---------- switching modes ---------- */

export const recordingOn = () => on;

/** With the video on, your tracks or the click are still being made: the video waits for them (whenReady). */
export const minePending = () => on && !!media && layers.some((l) => wanted(l) && l.key !== layerKey(l));

/** Where the song starts: the part of the tab the video begins with (0 = the very start). */
export function videoStartTick() {
  if (!on || !song?.videoMaster) return 0;
  return hooks.playedBars()[startIdx()]?.start || 0;
}

// Fades, so switching never pops: the synth by its master volume, the video by its own.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function fade(get, set, to, ms = 120) {
  const from = get();
  for (let i = 1; i <= 6; i++) { set(from + ((to - from) * i) / 6); await pause(ms / 6); }
}

// Where the video is, as a tick of the tab (its sync points, as the tab cursor uses them).
const tickAtVideo = (playedMs) => Math.max(0, Math.round(along(syncLine(), playedMs, 1, 0)));

// Switching while it plays carries on from the same spot. Video off: the video plays on until
// the synth is ready, the synth starts where the video is, and the video fades out. Video on:
// the synth fades out and the video starts where the tab was.
async function setOn(want) {
  const api = hooks.api();
  if (!api || !song) return;
  if (want && !song.recording) { $('pa-error').textContent = 'Add an audio file or a YouTube link first.'; return; }
  $('pa-error').textContent = '';
  const playing = api.playerState === 1;
  const fromTick = api.tickPosition;
  const handOff = playing && on && !want && media?.isPlaying ? media : null;
  if (playing && !on) await fade(() => api.masterVolume, (v) => { api.masterVolume = v; }, 0, 100);
  held?.destroy(); // a video still handing over (switched off and on again quickly)
  held = null;
  if (handOff) { handOff.hold(); held = handOff; }
  else media?.destroy();
  api.stop();
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
    if (playing) setTimeout(() => { api.tickPosition = fromTick; api.play(); }, 250);
    else if (song?.videoMaster) setTimeout(() => hooks.seekToBar(startIdx()), 200);
  }
  hooks.modeChanged(on);
  showState();
  setMine();
  if (handOff) takeOver(handOff);
}

// The built-in sound takes over from the video at the spot the video has reached by then.
let held = null;
async function takeOver(video) {
  const api = hooks.api();
  for (let i = 0; i < 600 && !hooks.synthReady() && !on; i++) await pause(50); // the synth loads its sounds again: up to ~15 s
  if (held !== video) return; // switched on again meanwhile
  held = null;
  const level = hooks.synthLevel();
  if (!on && hooks.synthReady() && video.isPlaying && api.playerState !== 1) {
    api.masterVolume = 0;
    api.tickPosition = tickAtVideo(video.now() + 60); // the synth starts about 60 ms after this
    api.play();
    fade(() => api.masterVolume, (v) => { api.masterVolume = v; }, level, 120);
  }
  const vol = video.masterVolume;
  await fade(() => video.masterVolume, (v) => { video.masterVolume = v; }, 0, 150);
  video.destroy();
  video.masterVolume = vol; // YouTube remembers its volume: put it back for next time
  if (api.masterVolume !== level && !on) api.masterVolume = level;
}

// Every save here also refreshes the sync badge and checklist.
const updateSong = (id, changes) => saveSong(id, changes).then((r) => { if (song?.id === id) paintSyncStatus(); return r; });

const SYNC_STEPS = ['Video linked', 'Music start found', 'Tempo matched', 'Marked as synced'];

function paintSyncStatus() {
  const pill = $('pl-sync');
  if (!song) { pill.hidden = true; return; }
  const { state, steps, label } = syncState(song);
  pill.hidden = false;
  pill.className = `pill sync-pill ${state}`;
  pill.textContent = state === 'synced' ? '✓ Synced' : state === 'none' ? '○ No video' : `◐ ${label}`;
  const rec = song.recording;
  const sub = $('pa-video-sub'); // the video bar's second line: who uploaded it and how far the sync is
  sub.className = `pa-vt-sub ${state}`;
  sub.textContent = [rec?.kind === 'youtube' ? rec.author : '', state === 'synced' ? '✓ Synced' : state === 'none' ? '' : `◐ ${label}`].filter(Boolean).join(' · ');
  const box = $('pa-sync-status');
  box.className = `sync-status ${state}`;
  box.innerHTML = `<b>${state === 'synced' ? 'Synced with the video' : state === 'none' ? 'No video yet' : 'Sync in progress'}</b>
    <ol>${SYNC_STEPS.map((t, i) => `<li class="${steps[i] ? 'ok' : ''}">${t}</li>`).join('')}</ol>
    ${steps[2] ? `<button id="pa-sync-done" class="small ${song.syncDone ? 'ghost' : 'primary'}" type="button">${song.syncDone ? 'Mark as still in progress' : 'Mark as synced ✓'}</button>` : ''}`;
}

// The video moment you last linked to the music start, to jump back to while you are pinning.
function paintLast() {
  const b = $('pa-last');
  const l = song?.lastLink;
  b.hidden = !l || !media;
  if (l) b.textContent = `↩ Last spot ${fmtT(l.ms)}`;
}

function showState() {
  showMine();
  paintSyncStatus();
  paintLast();
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
  // A synced song always opens with its video; otherwise only a video you switched on yourself
  // comes back by itself. Switching it off lasts until the song is opened again.
  const synced = syncState(song || {}).state === 'synced';
  if (!autoTried && song?.recording && (synced || (song.videoOn && !song.videoOff))) { autoTried = true; setOn(true); }
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
  $('pa-mine').addEventListener('change', (e) => setMine(e.target.value));
  $('pa-mine-vol').addEventListener('input', (e) => setMine(mine.mode, Number(e.target.value)));
  $('pa-mine-btn').addEventListener('click', () => setMine({ off: 'both', both: 'right', right: 'off' }[mine.mode]));
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
  const seekTo = (sec, ahead = true) => {
    if (!media) return;
    media.seekReal(Math.max(0, Math.min(media.rawDuration || 1e9, sec * 1000)), ahead);
  };
  // The position sliders: the number shown is the video's own time, to a tenth of a second.
  // The speaker: listen to 3 seconds from where the video is, then it goes back to that same spot.
  let listening = null;
  const stopListening = () => {
    if (!listening) return;
    const { at, timer } = listening;
    listening = null;
    clearTimeout(timer);
    media?.pause();
    media?.seekReal(at);
    ['pa-hear', 'pa-hear2'].forEach((id) => $(id).classList.remove('on'));
    setTimeout(() => media && paintScrub(media.nowReal()), 400);
  };
  const listen = () => {
    if (!media) return;
    if (listening) { stopListening(); return; }
    const at = media.nowReal();
    listening = { at, timer: setTimeout(stopListening, 3000) };
    ['pa-hear', 'pa-hear2'].forEach((id) => $(id).classList.add('on'));
    media.play();
  };
  ['pa-hear', 'pa-hear2'].forEach((id) => $(id).addEventListener('click', listen));
  const startScrub = () => { stopListening(); scrubbing = true; };
  const endScrub = () => { scrubbing = false; };
  const finishScrub = (sec, moved = true) => {
    seekTo(sec);
    settle = { sec, until: performance.now() + 4000 };
    if (moved && hasStart()) applyStartAt(sec * 1000); // a plain tap or a cancelled touch must not move the start
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
      if (now - last > 250) { last = now; seekTo(sec, false); }
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
      if (now - last > 250) { last = now; seekTo(from.target, false); }
    });
    const end = (e) => {
      if (!from) return;
      const j = from;
      from = null;
      el.classList.remove('on');
      if (!media) { endScrub(); return; }
      if (!j.moved) { if (e.type === 'pointerup') { if (media.isPlaying) media.pause(); else media.play(); setTimeout(() => media && paintScrub(media.nowReal()), 250); } return; } // a tap plays or pauses
      finishScrub(j.target, Math.abs(j.target - j.sec) >= 0.05);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  bindScrub($('pa-scrub'), 'pa-scrub-time');
  bindJog($('pa-scrub-time'), $('pa-scrub'));
  // The big pad on the video: hold it and push left or right like a stick. A small push scrubs
  // slowly (fine tuning), a bigger one faster; let go and it stops where it is.
  const pad = $('pa-vid-jog');
  let hold = null;
  const speed = (dx) => (Math.abs(dx) < 8 ? 0 : Math.sign(dx) * 0.25 * ((Math.abs(dx) - 8) / 30) ** 1.5); // video seconds per second
  const step = (now) => {
    if (!hold) return;
    hold.target = Math.max(0, Math.min((media.rawDuration || 1e9) / 1000, hold.target + speed(hold.dx) * ((now - hold.t) / 1000)));
    hold.t = now;
    $('pa-vid-time').textContent = fmtT(hold.target * 1000);
    if (now - hold.seek > 300) { hold.seek = now; seekTo(hold.target, false); } // moves the picture; the sound is the speaker button
    requestAnimationFrame(step);
  };
  pad.addEventListener('pointerdown', (e) => {
    if (!media) return;
    pad.setPointerCapture(e.pointerId);
    stickHeld = true;
    pad.classList.add('on');
    startScrub();
    hold = { x: e.clientX, dx: 0, target: media.nowReal() / 1000, start: media.nowReal() / 1000, t: performance.now(), seek: 0 };
    requestAnimationFrame(step);
  });
  pad.addEventListener('pointermove', (e) => { if (hold) hold.dx = e.clientX - hold.x; });
  const release = () => {
    if (!hold) return;
    const { target: t, start } = hold;
    hold = null;
    stickHeld = false;
    pad.classList.remove('on');
    finishScrub(t, Math.abs(t - start) >= 0.05);
  };
  pad.addEventListener('pointerup', release);
  pad.addEventListener('pointercancel', release);
  // From the song screen: the video is at the moment the music starts; the selected bar (or the
  // one the cursor is on) is what starts there.
  $('pa-link-here').addEventListener('click', () => {
    if (!media) return;
    const master = hooks.cursorMaster();
    setStartBar(master);
    applyStartAt(media.nowReal());
    hooks.seekToBar(startIdx());
    updateSong(song.id, { lastLink: { bar: master, ms: Math.round(media.nowReal()) } });
    song.lastLink = { bar: master, ms: Math.round(media.nowReal()) };
    hooks.releaseSelection?.(); // pinned: the tab follows the video again
    paintLast();
    $('pa-link-note').textContent = `Bar ${master + 1} = ${fmtT(media.nowReal())}`;
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
  $('pa-tempo-tap').addEventListener('pointerdown', (e) => { e.preventDefault(); tapVideoBeat(); });
  $('pa-last').addEventListener('click', () => { if (media && song?.lastLink) { stopListening(); seekTo(song.lastLink.ms / 1000); settle = { sec: song.lastLink.ms / 1000, until: performance.now() + 4000 }; paintScrub(song.lastLink.ms); } });
  window.addEventListener('fbpin', (e) => {
    const bar = e.detail;
    $('pa-link-here').textContent = bar === null ? 'Music starts here' : `Music starts at bar ${bar + 1}`;
  });
  $('pl-sync').addEventListener('click', () => document.querySelector('[data-sheet-btn=playalong]')?.click());
  $('pa-sync-status').addEventListener('click', (e) => {
    if (!e.target.closest('#pa-sync-done') || !song) return;
    song.syncDone = !song.syncDone;
    updateSong(song.id, { syncDone: song.syncDone });
  });
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
    updateSong(song.id, { syncPoints: [], syncOffset: 0, syncDone: false });
    if (on) applySync(); else showSync();
  });
  // The picture: bigger / smaller, or hidden away (the sound keeps playing); remembered.
  const box = $('pa-video');
  const look = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const save = (key, v) => { try { localStorage.setItem(key, v); } catch { /* ignore */ } };
  const showLook = () => {
    const hidden = box.classList.contains('collapsed');
    $('pa-video-hide').innerHTML = hidden ? ICON_SHOW : ICON_HIDE;
    $('pa-video-hide').title = hidden ? 'Show the video again' : 'Hide the picture (the sound keeps playing)';
    $('pa-video-hide').setAttribute('aria-label', $('pa-video-hide').title);
    dock();
  };
  // Hidden away on a bigger screen: just its bar, laid over a slot in the play bar beside the tempo,
  // out of the tab's way. The video itself never moves in the page (a moved iframe reloads and stops).
  const slot = document.createElement('span');
  slot.className = 'pa-dock';
  slot.hidden = true;
  document.querySelector('.playbar-row .speed')?.after(slot);
  const dock = () => {
    const on = box.classList.contains('collapsed') && !box.hidden && !matchMedia('(max-width: 640px)').matches;
    box.classList.toggle('docked', on);
    slot.hidden = !on;
    if (!on) { box.style.left = box.style.top = box.style.width = ''; return; }
    const r = slot.getBoundingClientRect();
    if (!r.width) return;
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px` });
  };
  // The slot moves whenever anything in the row changes width (the chord name, the time, the speed box),
  // and no observer sees every such move: while docked, check where it is each frame (cheap) and follow.
  let at = '', following = false;
  const follow = () => {
    following = box.classList.contains('docked');
    if (!following) { at = ''; return; }
    const r = slot.getBoundingClientRect();
    const now = `${r.left},${r.top},${r.width}`;
    if (now !== at) { at = now; dock(); }
    requestAnimationFrame(follow);
  };
  new ResizeObserver(dock).observe(slot);
  new MutationObserver(() => { if (!following && box.classList.contains('docked')) { following = true; requestAnimationFrame(follow); } }).observe(box, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(dock).observe(box, { attributes: true, attributeFilter: ['hidden'] });
  addEventListener('resize', dock);
  addEventListener('scroll', dock, true);
  box.classList.toggle('mini', look('fretboard-video-mini', matchMedia('(max-width: 640px)').matches ? '1' : '0') === '1'); // small by default on a phone
  box.classList.toggle('collapsed', look('fretboard-video-hidden', '0') === '1');
  showLook();
  $('pa-video-size').addEventListener('click', () => { save('fretboard-video-mini', box.classList.toggle('mini') ? '1' : '0'); });
  $('pa-video-hide').addEventListener('click', () => { save('fretboard-video-hidden', box.classList.toggle('collapsed') ? '1' : '0'); showLook(); });
  box.querySelector('.pa-vt').addEventListener('click', () => { if (box.classList.contains('collapsed')) $('pa-video-hide').click(); });
  $('pa-video-prev').addEventListener('click', () => stepMatch(-1));
  $('pa-video-next').addEventListener('click', () => stepMatch(1));
}
