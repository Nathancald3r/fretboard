// Music-stand helpers: the screen stays on while a song plays, and the lock screen / Bluetooth pedal
// and earbud buttons can play and pause.
let lock = null;
let wanted = false;

async function acquire() {
  if (!wanted || lock || document.hidden || !navigator.wakeLock) return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
  } catch { /* not allowed here: the screen may dim, nothing else changes */ }
}

/** Hold the screen on while `on` (called when playback starts and stops). */
export function keepScreenOn(on) {
  wanted = on;
  if (on) acquire();
  else if (lock) { lock.release().catch(() => {}); lock = null; }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) acquire(); });

/** Hardware / lock-screen transport. handlers: { play, pause, back }. */
export function initMediaSession({ play, pause, back }) {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ } };
  set('play', play);
  set('pause', pause);
  set('stop', pause);
  set('previoustrack', back);
  set('seekbackward', back);
}

export function describeSong(title, artist) {
  try {
    if (navigator.mediaSession && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title, artist: artist || 'Fretboard' });
  } catch { /* ignore */ }
}
