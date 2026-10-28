// A song asked for on a device that can't fetch it (the phone). The library holds a placeholder
// ({ kind: 'text', want: { state, ... } }); the worker on the computer (scripts/songworker.mjs) turns it
// into the official tab with the official video, lined up, under the same uid, so the phone's next sync
// replaces the placeholder. No DOM here: tested in tests/wanted.test.mjs.

export const WANT_STATES = ['asked', 'working', 'failed'];
const STALE_WORKING = 2 * 60 * 60 * 1000; // a worker that stopped mid-song: ask again after this long

const clip = (v, n) => String(v ?? '').slice(0, n);

/** The placeholder song for "get this song for me". sync = false: the official tab only, no video and no line-up (the user's choice, made when asking). */
export function wantRecord({ title, artist = '', sync = true }, now = Date.now()) {
  return { kind: 'text', title: clip(title, 120).trim(), artist: clip(artist, 120).trim(), data: '', added: now, updated: now, want: { state: 'asked', at: now, ...(sync ? {} : { sync: false }) } };
}

/** The request on a song, cleaned (records come from the sync repository), or null. */
export function cleanWant(w) {
  if (!w || typeof w !== 'object' || !WANT_STATES.includes(w.state)) return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return { state: w.state, at: n(w.at), ...(w.sync === false ? { sync: false } : {}), ...(w.by ? { by: clip(w.by, 60) } : {}), ...(w.reason ? { reason: clip(w.reason, 300) } : {}), ...(w.tried ? { tried: n(w.tried) } : {}) };
}

export const wantOf = (song) => cleanWant(song?.want);
/** Does the request include the official video and the line-up? (yes unless the user chose "tab only") */
export const wantSync = (song) => wantOf(song)?.sync !== false;
const keepChoice = (song) => (wantSync(song) ? {} : { sync: false }); // the choice survives working, failed and "try again"

/** What the library row says about a placeholder ('' for an ordinary song). */
export function wantLabel(song) {
  const w = wantOf(song);
  if (!w) return '';
  if (w.state === 'asked') return w.sync === false ? 'Asked: your computer will get the tab (no video)' : 'Asked: your computer will get it';
  if (w.state === 'working') return 'Your computer is getting it…';
  return `Couldn’t get it${w.reason ? ': ' + w.reason : ''}`;
}

/** Requests the worker should take now, oldest first: asked, or "working" for so long it must have died. */
export function nextWanted(songs, now = Date.now()) {
  return songs
    .filter((s) => {
      const w = wantOf(s);
      return w && (w.state === 'asked' || (w.state === 'working' && now - w.at > STALE_WORKING));
    })
    .sort((a, b) => wantOf(a).at - wantOf(b).at);
}

export const wantWorking = (song, by, now = Date.now()) => ({ ...song, updated: now, want: { state: 'working', at: now, by, ...keepChoice(song) } });
export const wantFailed = (song, reason, now = Date.now()) => ({ ...song, updated: now, want: { state: 'failed', at: wantOf(song)?.at || now, tried: now, reason: clip(reason, 300), ...keepChoice(song) } });
export const wantRetry = (song, now = Date.now()) => ({ ...song, updated: now, want: { state: 'asked', at: now, ...keepChoice(song) } });

/** The finished song (from the .fretboard the pipeline wrote) in place of the placeholder: same uid, same added date. */
export function wantDone(placeholder, made, now = Date.now()) {
  const { want, ...song } = made;
  return { ...song, uid: placeholder.uid, ...(placeholder.id !== undefined ? { id: placeholder.id } : {}), added: placeholder.added || now, updated: now };
}
