// Practice and Live modes for the player. Practice has every tool (loops, speed, trainer,
// note check, singing). Live is for rehearsals and gigs alike, playing songs through:
// full tempo, no practice tools, the screen kept on, and a setlist that moves on to the
// next song by itself (and can start it, with the count-in if that's on). A page-turner
// pedal works too: Page Down / Page Up move a line, N / P change song.

const $ = (id) => document.getElementById(id);
const KEY = 'fretboard-mode';
const AUTO_KEY = 'fretboard-live-autoplay';
const GAP_MS = 2500; // between songs when the next one starts by itself

let live = false;
let hooks = null; // { enter, leave }
let wakeLock = null;

export const isLive = () => live;
export const liveAutoPlay = () => $('lv-auto').checked;
export const LIVE_GAP_MS = GAP_MS;

async function keepAwake() {
  if (!live || document.hidden || wakeLock || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not allowed (battery saver, etc.) */ }
}

function setMode(want, save = true) {
  live = want === 'live';
  document.body.classList.toggle('live-mode', live);
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === (live ? 'live' : 'practice')));
  if (save) { try { localStorage.setItem(KEY, live ? 'live' : 'practice'); } catch { /* ignore */ } }
  if (live) { hooks.enter(); keepAwake(); } else { hooks.leave(); wakeLock?.release().catch(() => {}); wakeLock = null; }
}

export function initModes(h) {
  hooks = h;
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.addEventListener('visibilitychange', keepAwake);
  try { $('lv-auto').checked = localStorage.getItem(AUTO_KEY) !== '0'; } catch { /* ignore */ }
  $('lv-auto').addEventListener('change', (e) => { try { localStorage.setItem(AUTO_KEY, e.target.checked ? '1' : '0'); } catch { /* ignore */ } });
  let saved = 'practice';
  try { saved = localStorage.getItem(KEY) || 'practice'; } catch { /* ignore */ }
  setMode(saved, false);
}
