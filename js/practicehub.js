// The Practice page: drills (scales, chord changes, rhythm, voice), exercises, and a calendar of
// the days you practised. Time spent in a drill page is logged as a session like a song's.
import { listSessions, addSession, listSongs } from './db.js';
import { formatDuration } from './practice.js';
import { streak } from './log.js';

const $ = (id) => document.getElementById(id);
const DAY = 86400000;
const WEEKS = 18;
const startOfDay = (t) => new Date(new Date(t).toDateString()).getTime();
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const DRILLS = {
  strum: { id: 'drill:strum', title: 'Strum timing', blurb: 'Strum with the click; the mic shows how early or late each strum is, in ms.' },
  scales: { id: 'drill:scales', title: 'Scales', blurb: 'Patterns and positions on the neck, played back at your tempo.' },
  keys: { id: 'drill:keys', title: 'Chord changes', blurb: 'Chord finder, circle of fifths, and the changes in any key.' },
  tools: { id: 'drill:tools', title: 'Rhythm training', blurb: 'Metronome with speed-up and gap trainers, plus the tuner.' },
  vocal: { id: 'drill:vocal', title: 'Vocal training', blurb: 'Hear a note, sing it back, and see how close you are.' },
};

/* ---------- time spent in a drill page ---------- */

let drill = null;
const MIN_SECONDS = 20;
const finish = () => {
  if (!drill) return null;
  const { key, start, seconds } = drill;
  clearInterval(drill.timer);
  drill = null;
  return seconds >= MIN_SECONDS ? { songId: DRILLS[key].id, title: DRILLS[key].title, artist: 'Practice', start, seconds, maxSpeed: null } : null;
};

/** Call on every route change: closes the last drill's session and starts one for `view` if it is a drill. */
export function trackDrill(view) {
  const done = finish();
  if (done) addSession(done);
  if (!DRILLS[view]) return;
  drill = { key: view, start: Date.now(), seconds: 0 };
  drill.timer = setInterval(() => { if (document.visibilityState === 'visible') drill.seconds++; }, 1000);
}

window.addEventListener('pagehide', () => {
  const done = finish();
  if (!done) return;
  try { // saved on the next launch by recoverPendingSessions
    const pending = JSON.parse(localStorage.getItem('fretboard-pending-sessions') || '[]');
    localStorage.setItem('fretboard-pending-sessions', JSON.stringify([...pending, done]));
  } catch { /* lost */ }
});

/* ---------- the page ---------- */

const level = (minutes) => (minutes <= 0 ? 0 : minutes < 10 ? 1 : minutes < 20 ? 2 : minutes < 40 ? 3 : 4);

export function calendarHtml(sessions, now = Date.now()) {
  const today = startOfDay(now);
  const perDay = new Map();
  for (const s of sessions) perDay.set(startOfDay(s.start), (perDay.get(startOfDay(s.start)) || 0) + s.seconds);
  const firstDay = today - (WEEKS * 7 - 1 + new Date(today).getDay()) * DAY; // a Sunday
  let html = '';
  for (let d = firstDay; d <= today; d += DAY) {
    const minutes = (perDay.get(d) || 0) / 60;
    const label = `${new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' })}: ${minutes ? formatDuration(perDay.get(d)) : 'no practice'}`;
    html += `<i class="cal-day l${level(minutes)}" title="${escape(label)}"></i>`;
  }
  return html;
}

function weekBars(sessions, id) {
  const today = startOfDay(Date.now());
  const mins = Array.from({ length: 7 }, (_, i) => sessions.filter((s) => s.songId === id && startOfDay(s.start) === today - (6 - i) * DAY).reduce((n, s) => n + s.seconds, 0) / 60);
  const top = Math.max(10, ...mins);
  return `<span class="mini-bars" aria-hidden="true">${mins.map((m) => `<i style="height:${Math.max(m ? 12 : 4, (m / top) * 100)}%" class="${m ? 'on' : ''}"></i>`).join('')}</span>`;
}

const goalMin = () => { try { return Math.max(5, Math.min(240, Number(localStorage.getItem('fretboard-goal-min')) || 15)); } catch { return 15; } };
function setGoal(m) { try { localStorage.setItem('fretboard-goal-min', String(m)); } catch { /* ignore */ } renderPractice(); }
let goalWired = false;

export async function renderPractice() {
  if (!goalWired) {
    goalWired = true;
    $('pr-goal-minus').addEventListener('click', () => setGoal(goalMin() - 5));
    $('pr-goal-plus').addEventListener('click', () => setGoal(goalMin() + 5));
  }
  const sessions = await listSessions();
  const today = startOfDay(Date.now());
  const sum = (list) => list.reduce((n, s) => n + s.seconds, 0);
  const week = sum(sessions.filter((s) => s.start >= today - 6 * DAY));
  $('pr-stats').innerHTML = [
    ['Today', formatDuration(sum(sessions.filter((s) => s.start >= today)))],
    ['Last 7 days', formatDuration(week)],
    ['Day streak', streak(sessions)],
  ].map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  const todaySec = sum(sessions.filter((s) => s.start >= today));
  const goal = goalMin();
  const pct = Math.min(100, Math.round((todaySec / 60 / goal) * 100));
  $('pr-goal-text').textContent = pct >= 100 ? 'Goal reached today ✓' : `Today: ${formatDuration(todaySec)} of ${goal} min`;
  $('pr-goal-min').textContent = `${goal} min goal`;
  $('pr-goal-fill').style.width = pct + '%';
  $('pr-goal').classList.toggle('done', pct >= 100);
  $('pr-calendar').innerHTML = calendarHtml(sessions);

  $('pr-drills').innerHTML = Object.entries(DRILLS).map(([key, d]) => {
    const mine = sessions.filter((s) => s.songId === d.id);
    const w = sum(mine.filter((s) => s.start >= today - 6 * DAY));
    return `<a class="card drill" href="#${key}"><div class="title">${escape(d.title)}</div>
      <div class="meta">${escape(d.blurb)}</div>
      <div class="drill-foot">${weekBars(sessions, d.id)}<span class="meta">${w ? `${formatDuration(w)} this week` : 'not yet this week'}</span></div></a>`;
  }).join('');

  const exercises = (await listSongs()).filter((s) => s.kind === 'tex');
  $('pr-exercises').innerHTML = exercises.map((s) => `<a class="card" href="#song/${escape(s.id)}"><div class="title">${escape(s.title)}</div>
    <div class="meta">${s.practiceSeconds ? `${formatDuration(s.practiceSeconds)} practiced` : 'Exercise'}${s.bestSpeed ? ` · top ${escape(s.bestSpeed)}%` : ''}</div></a>`).join('')
    || '<div class="empty">No exercises yet.</div>';
}
