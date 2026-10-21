// Pure maths for lining a tab up with a video: tap tempo, tempo ratio, a first guess from the
// durations, and remembering the sync per song + video. No DOM here, so tests/videosync.test.mjs
// can cover it.

/** BPM from tap times (ms): the median gap, so one stray tap hardly matters. null under 3 taps. */
export function bpmFromTaps(times) {
  if (!times || times.length < 3) return null;
  const gaps = times.slice(1).map((t, i) => t - times[i]).filter((g) => g > 0).sort((a, b) => a - b);
  if (!gaps.length) return null;
  const mid = gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
  return 60000 / mid;
}

/** Tapping half or double time is easy: move the BPM by a factor of 2 (or 3/2, 2/3) to the value
 *  closest to the tab's tempo, if that lands within 25%. Otherwise leave it. */
export function foldBpm(bpm, tabBpm) {
  if (!(bpm > 0) || !(tabBpm > 0)) return bpm;
  let best = bpm;
  for (const f of [0.5, 2 / 3, 1.5, 2]) {
    const c = bpm * f;
    if (Math.abs(Math.log(c / tabBpm)) < Math.abs(Math.log(best / tabBpm)) - 1e-9) best = c;
  }
  return Math.abs(Math.log(best / tabBpm)) <= Math.log(1.25) ? best : bpm;
}

/** How the video's tempo compares with the tab's: the ratio, the % speed it implies and a verdict. */
export function tempoCompare(videoBpm, tabBpm) {
  if (!(videoBpm > 0) || !(tabBpm > 0)) return null;
  const ratio = videoBpm / tabBpm;
  const pct = Math.round(ratio * 100);
  const off = Math.abs(ratio - 1);
  const level = off < 0.02 ? 'same' : off < 0.15 ? 'close' : 'far';
  const text = level === 'same' ? 'same tempo as the tab'
    : `${pct}% of the tab's speed (${ratio > 1 ? 'faster' : 'slower'})`;
  return { ratio, pct, level, text };
}

/** A guess at the video's BPM from lengths alone: the tab's length at its written tempo vs the
 *  video's length from where the music starts. Only trusted within 0.6x..1.6x (longer videos
 *  have talking, encores). Returns { bpm, ratio, sure } or null. */
export function guessTempoFromDurations({ tabSeconds, videoSeconds, startSeconds = 0, tabBpm }) {
  if (!(tabSeconds > 0) || !(videoSeconds > 0) || !(tabBpm > 0)) return null;
  const playable = videoSeconds - Math.max(0, startSeconds);
  if (!(playable > 0)) return null;
  const ratio = tabSeconds / playable; // video slower than the tab => ratio < 1
  if (ratio < 0.6 || ratio > 1.6) return { bpm: null, ratio, sure: false };
  // Within 4% the lengths agree: no change needed. Past that it is only a hint (outros, intros).
  return { bpm: tabBpm * ratio, ratio, sure: Math.abs(ratio - 1) < 0.04 };
}

/** One line of "what is synced". */
export function syncSummary({ startText, bpm, tabBpm, points = 0, offsetMs = 0, skips = 0 }) {
  const parts = [];
  parts.push(startText ? `Starts at ${startText}` : 'Start not set');
  const cmp = tempoCompare(bpm, tabBpm);
  if (cmp) parts.push(`video ${bpm.toFixed(1)} BPM = ${cmp.text}`);
  else if (points > 1) parts.push(`tapped bar by bar (${points} bars)`);
  else parts.push('tempo not matched');
  if (offsetMs) parts.push(`nudged ${offsetMs > 0 ? '+' : ''}${offsetMs} ms`);
  if (skips) parts.push(`${skips} skip${skips > 1 ? 's' : ''}`);
  return parts.join(' · ') + '.';
}

const FIELDS = ['syncPoints', 'syncOffset', 'videoMaster', 'videoBpm', 'skips'];

/** Put the current video's sync away under its id (returns the new syncByVideo map). */
export function stashSync(song, videoId) {
  const map = { ...(song.syncByVideo || {}) };
  if (!videoId) return map;
  const has = song.syncPoints?.length || song.syncOffset || song.videoBpm || song.skips?.length;
  if (!has) { delete map[videoId]; return map; }
  map[videoId] = Object.fromEntries(FIELDS.map((k) => [k, structuredClone(song[k] ?? null)]));
  return map;
}

/** The sync fields to apply for a video: what was saved for it, or a clean slate. */
export function restoreSync(song, videoId) {
  const saved = videoId && song.syncByVideo?.[videoId];
  return {
    syncPoints: saved?.syncPoints || [],
    syncOffset: saved?.syncOffset || 0,
    videoMaster: saved?.videoMaster || 0,
    videoBpm: saved?.videoBpm || 0,
    skips: saved?.skips || [],
  };
}
