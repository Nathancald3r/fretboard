// Counts the seconds you actually practice a song and saves them as a session.
import { addSession, getSong, updateSong } from './db.js';

const MIN_SESSION_SECONDS = 15;
const PENDING_KEY = 'fretboard-pending-sessions';

async function saveSession(done) {
  if (!done) return;
  await addSession(done);
  const current = await getSong(done.songId);
  if (current) {
    await updateSong(done.songId, {
      lastPracticed: done.start + done.seconds * 1000,
      practiceSeconds: (current.practiceSeconds || 0) + done.seconds,
      bestSpeed: Math.max(current.bestSpeed || 0, done.maxSpeed || 0) || null,
    });
  }
}

export async function recoverPendingSessions() {
  let pending = [];
  try {
    pending = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    localStorage.removeItem(PENDING_KEY);
  } catch { return; }
  for (const done of pending) await saveSession(done);
}

export function createPracticeTimer({ isActive, onTick }) {
  let song = null;
  let seconds = 0;
  let maxSpeed = 0;
  let startedAt = 0;
  let interval = null;

  function begin(s) {
    end();
    song = s;
    seconds = 0;
    maxSpeed = 0;
    startedAt = Date.now();
    interval = setInterval(() => {
      if (document.visibilityState === 'visible' && isActive()) {
        seconds++;
        onTick?.(seconds);
      }
    }, 1000);
  }

  function noteSpeed(percent) {
    maxSpeed = Math.max(maxSpeed, percent);
  }

  function takeSession() {
    clearInterval(interval);
    interval = null;
    const done = song && seconds >= MIN_SESSION_SECONDS
      ? { songId: song.id, title: song.title, artist: song.artist, start: startedAt, seconds, maxSpeed: maxSpeed || null }
      : null;
    song = null;
    return done;
  }

  const end = () => saveSession(takeSession());

  // The page may unload before an IndexedDB write finishes, so stash the session
  // synchronously; recoverPendingSessions() saves it on the next launch.
  window.addEventListener('pagehide', () => {
    const done = takeSession();
    if (!done) return;
    try {
      const pending = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
      localStorage.setItem(PENDING_KEY, JSON.stringify([...pending, done]));
    } catch { /* storage unavailable: session is lost */ }
  });

  return { begin, end, noteSpeed, get seconds() { return seconds; } };
}

export function formatDuration(totalSeconds) {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

export function formatClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
