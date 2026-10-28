// The song line-up in the background: after a song comes in from Ultimate Guitar the computer finds its
// video, lines the tab up with it and checks the result (server.mjs /api/autosync → scripts/autosync.mjs).
// The page keeps working meanwhile: a small pill in the player's header shows the step, and when the line-up
// passes the song is replaced by the synced one (the practice time, loops and setlists stay with the song).
// A song that is open is left alone until you tap the pill (or leave it): the player would not notice the
// change, and a reload would stop the music.
import { listSongs } from './db.js';

const $ = (id) => document.getElementById(id);
const API = '/api/autosync';
const HANDLED = 'fretboard-autosync-handled';

let ctx = null; // { importFiles, toast }
let available = null; // null = not asked yet
let jobs = [];
let timer = 0;
const pending = new Map(); // job key -> { text, job } : a finished song file waiting to go in (its song was open)
const ids = new Map(); // job key -> the library song's id

const handled = () => { try { return new Set(JSON.parse(localStorage.getItem(HANDLED) || '[]')); } catch { return new Set(); } };
const markHandled = (j) => { try { localStorage.setItem(HANDLED, JSON.stringify([...handled(), `${j.key}|${j.finished}`].slice(-100))); } catch { /* fine */ } };
const stamp = (j) => `${j.key}|${j.finished}`;
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const active = (j) => j.state === 'queued' || j.state === 'running';
const openId = () => /^#song\/(\d+)/.exec(location.hash)?.[1] || '';

async function call(path, body) {
  const r = await fetch(API + path, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(String(r.status));
  return r;
}

/** True when this page is served by the computer's own server (the one that can run the line-up). */
export async function autoSyncAvailable() {
  if (available !== null) return available;
  try { available = (await (await call('')).json()).ok === true; } catch { available = false; }
  return available;
}

/** Asks for a song to be lined up with its video. { title, artist, sourceUrl } of a library song. False when it can't. */
export async function requestAutoSync(song) {
  if (!ctx || !song?.title || !(await autoSyncAvailable())) return false;
  try {
    const ug = /-official-\d+/.test(song.sourceUrl || '') ? song.sourceUrl : '';
    const r = await (await call('', { title: song.title, artist: song.artist || '', ug })).json();
    if (!r.ok) { ctx.toast(r.why || 'Couldn’t start the line-up.', 5000); return false; }
    if (song.id) ids.set(r.job.key, String(song.id));
    ctx.toast(`Finding a video for “${song.title}” and lining it up. You can keep practicing: the header says when it’s done.`, 7000);
    poll(1000);
    return true;
  } catch { return false; }
}

/** The library song a job is for (its id is remembered while this page lives, else found by title and artist). */
async function songIdOf(j) {
  if (ids.has(j.key)) return ids.get(j.key);
  const s = (await listSongs()).find((x) => same(x.title, j.title) && same(x.artist, j.artist));
  if (s) ids.set(j.key, String(s.id));
  return s ? String(s.id) : '';
}

async function apply(j, text) {
  const file = new File([text], `${j.title}.fretboard`);
  await ctx.importFiles([file], { replace: true, quietIfEmpty: true });
}

/** A finished job: in at once when its song isn't open, else the pill offers it. A job the pill still offers isn't marked handled, so a reload brings the offer back. */
async function finish(j) {
  const name = `“${j.title}”`;
  if (!j.hasFile) { markHandled(j); ctx.toast(`${name}: couldn’t line it up with a video${j.reason ? ` (${j.reason})` : ''}.`, 9000); return; }
  if (!j.deliver && j.verdict === 'FAIL') { markHandled(j); ctx.toast(`${name}: the tab and the video don’t line up (the sync check failed), so it was left as it is.`, 9000); return; }
  let text = null;
  try { text = await (await call(`/file?key=${encodeURIComponent(j.key)}`)).text(); } catch { /* below */ }
  if (!text) { markHandled(j); ctx.toast(`${name}: the synced file couldn’t be read.`, 7000); return; }
  const id = await songIdOf(j);
  if (id && openId() === id) { pending.set(j.key, { text, job: j }); ctx.toast(`${name} is ${j.deliver ? 'synced' : 'lined up (it needs a listen)'}: tap the header pill to load it. Your practice isn’t interrupted.`, 9000); paint(); return; }
  if (!j.deliver) { pending.set(j.key, { text, job: j }); ctx.toast(`${name} lined up, but the check isn’t sure: open the song and tap the pill to load it and listen.`, 9000); return; }
  markHandled(j);
  await apply(j, text);
  ctx.toast(`${name} is synced with the video ✓${j.timingOnly ? ' (the timing checks pass; the tab’s chords differ a little from the recording)' : ''}`, 8000);
}

/** Songs left in `pending` whose song was open go in once it is closed (delivered ones only). */
async function flushClosed() {
  for (const [key, p] of [...pending]) {
    if (!p.job.deliver) continue;
    const id = await songIdOf(p.job);
    if (id && openId() === id) continue;
    pending.delete(key);
    markHandled(p.job);
    await apply(p.job, p.text);
    ctx.toast(`“${p.job.title}” is synced with the video ✓`, 6000);
  }
  paint();
}

async function takePending(p) {
  pending.delete(p.job.key);
  markHandled(p.job);
  await apply(p.job, p.text);
  location.reload(); // the open player shows the new song
}

/** The pill in the player's header for the open song: the step while it runs, or "tap to load". */
async function paint() {
  const pill = $('pl-autosync');
  if (!pill) return;
  const id = openId();
  let shown = null;
  if (id) {
    for (const j of jobs) if ((await songIdOf(j)) === id && (active(j) || pending.has(j.key))) { shown = j; break; }
  }
  pill.hidden = !shown;
  if (!shown) return;
  const p = pending.get(shown.key);
  pill.className = `pill sync-pill ${p ? (p.job.deliver ? 'synced' : 'progress') : 'progress'}`;
  pill.textContent = p ? (p.job.deliver ? '✓ Synced: tap to load' : '◐ Needs a listen: tap to load') : '◔ Syncing with the video…';
  pill.title = p ? (p.job.deliver ? 'The synced version is ready.' : 'Lined up, but a few places need your ear.') + ' Loading it restarts this song.' : `Lining the tab up with its video: ${shown.step || 'working'}. You can keep practicing.`;
  pill.onclick = p ? () => takePending(p) : null;
  pill.style.cursor = p ? 'pointer' : 'default';
}

async function poll(delay) {
  clearTimeout(timer);
  let list = null;
  try { list = (await (await call('')).json()).jobs; } catch { available = false; return; }
  jobs = list || [];
  const seen = handled();
  for (const j of jobs) if (!active(j) && j.finished && !seen.has(stamp(j)) && !pending.has(j.key)) await finish(j).catch((e) => console.warn('autosync', e));
  await paint();
  timer = setTimeout(() => poll(), delay || (jobs.some(active) ? 3000 : 30000));
}

export async function initAutoSync({ importFiles, toast }) {
  ctx = { importFiles, toast };
  if (!(await autoSyncAvailable())) return;
  window.addEventListener('hashchange', () => { paint(); flushClosed().catch(() => {}); });
  poll(500);
}
