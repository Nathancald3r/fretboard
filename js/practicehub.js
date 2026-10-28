// The Practice page: the foundations (warm-ups, scales, chords, rhythm, technique, ear and theory: exercises
// and drills, js/foundations.js), a short daily routine, and a calendar of the days you practised. Songs are not
// here (they live in the library). Time spent in a drill page is logged as a session like a song's.
import { listSessions, addSession, listSongs, putSong, updateSong } from './db.js';
import { formatDuration } from './practice.js';
import { streak } from './log.js';
import { chartType } from './songmeta.js';
import { DEMOS } from './demos.js';
import { EXERCISES, FOUNDATIONS, ROUTINE, routineMinutes, stepsDone, nextStep, stepKey, dayKey } from './foundations.js';

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
let wired = false;

/* ---------- the routine's hand ticks (with the day they were made on, so they reset by themselves) ---------- */

const ROUTINE_KEY = 'fretboard-routine';
const readTicks = () => { try { return JSON.parse(localStorage.getItem(ROUTINE_KEY) || 'null'); } catch { return null; } };
function toggleTick(key) {
  const day = dayKey(Date.now());
  const old = readTicks();
  const keys = new Set(old && old.day === day ? old.keys : []);
  if (keys.has(key)) keys.delete(key); else keys.add(key);
  try { localStorage.setItem(ROUTINE_KEY, JSON.stringify({ day, keys: [...keys] })); } catch { /* ignore */ }
}

/* ---------- an exercise opens in the player ---------- */

/** The exercise as a library entry (kept, so its practice time adds up), then the player. */
async function openExercise(id) {
  const e = EXERCISES[id];
  if (!e) return;
  const data = e.tex();
  const existing = (await listSongs()).find((s) => s.kind === 'tex' && s.title === e.title && chartType(s) === 'exercise');
  let songId;
  if (existing) {
    songId = existing.id;
    if (existing.data !== data) await updateSong(songId, { data });
  } else {
    songId = await putSong({ kind: 'tex', title: e.title, artist: e.artist, data, added: Date.now() });
  }
  location.hash = `song/${songId}`;
}

const openStep = (step) => (step.ex ? openExercise(step.ex) : (location.hash = `#${step.drill}`));

/* ---------- drawing ---------- */

const shortTitle = (t) => t.replace(/^[A-Za-z -]+: /, '');

const drillCard = (sessions, key, today) => {
  const d = DRILLS[key];
  const w = sessions.filter((s) => s.songId === d.id && s.start >= today - 6 * DAY).reduce((n, s) => n + s.seconds, 0);
  return `<a class="card drill" href="#${key}"><div class="title">${escape(d.title)}</div>
      <div class="meta">${escape(d.blurb)}</div>
      <div class="drill-foot">${weekBars(sessions, d.id)}<span class="meta">${w ? `${formatDuration(w)} this week` : 'not yet this week'}</span></div></a>`;
};

const exerciseCard = (id, saved) => {
  const e = EXERCISES[id];
  const mine = saved.get(e.title);
  return `<a class="card fd" href="#" data-ex="${id}"><div class="fd-head"><span class="title">${escape(shortTitle(e.title))}</span><span class="fd-level">${e.level}</span></div>
      <div class="fd-tip">${escape(e.tip)}</div>
      <div class="meta">${e.tempo} BPM · ${mine?.practiceSeconds ? `${formatDuration(mine.practiceSeconds)} practiced` : 'not yet'}${mine?.bestSpeed ? ` · top ${escape(mine.bestSpeed)}%` : ''}</div></a>`;
};

function routineHtml(done) {
  return ROUTINE.map((step) => {
    const key = stepKey(step);
    const name = step.ex ? shortTitle(EXERCISES[step.ex].title) : DRILLS[step.drill].title;
    const on = done.has(key);
    return `<li class="rt-step${on ? ' done' : ''}"><button class="rt-check" data-tick="${escape(key)}" aria-pressed="${on}" aria-label="${on ? 'Done' : 'Mark as done'}: ${escape(name)}">${on ? '✓' : ''}</button>
      <a href="${step.ex ? '#' : `#${step.drill}`}"${step.ex ? ` data-ex="${step.ex}"` : ''}>${escape(name)}</a><span class="muted small-text">${step.minutes} min</span></li>`;
  }).join('');
}

function wire() {
  wired = true;
  $('pr-goal-minus').addEventListener('click', () => setGoal(goalMin() - 5));
  $('pr-goal-plus').addEventListener('click', () => setGoal(goalMin() + 5));
  $('view-practice').addEventListener('click', (ev) => {
    const tick = ev.target.closest('[data-tick]');
    if (tick) { toggleTick(tick.dataset.tick); renderPractice(); return; }
    const ex = ev.target.closest('[data-ex]');
    if (ex) { ev.preventDefault(); openExercise(ex.dataset.ex); }
  });
  $('pr-routine-go').addEventListener('click', async () => {
    const step = nextStep(stepsDone({ sessions: await listSessions(), ticks: readTicks(), drillId: (k) => DRILLS[k].id }));
    if (step) openStep(step);
  });
}

export async function renderPractice() {
  if (!wired) wire();
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

  const exercises = (await listSongs()).filter((s) => chartType(s) === 'exercise'); // never a song: those are in the library
  const saved = new Map(exercises.map((s) => [s.title, s]));

  const done = stepsDone({ sessions, ticks: readTicks(), drillId: (k) => DRILLS[k].id });
  const left = ROUTINE.filter((s) => !done.has(stepKey(s))).reduce((n, s) => n + s.minutes, 0);
  $('pr-routine').innerHTML = routineHtml(done);
  $('pr-routine-sum').textContent = left
    ? `About ${routineMinutes()} minutes, in this order. ${done.size ? `${left} min to go.` : 'Each step checks itself when you have practised it.'}`
    : 'All done today. Nice work.';
  $('pr-routine-go').textContent = left ? (done.size ? 'Continue' : 'Start') : 'Done today ✓';
  $('pr-routine-go').disabled = !left;

  $('pr-foundations').innerHTML = FOUNDATIONS.map((cat) => `<section class="panel fd-cat">
      <h2>${escape(cat.title)}</h2><p class="muted small-text">${escape(cat.blurb)}</p>
      <div class="cards">${cat.items.map((it) => (typeof it === 'string' ? exerciseCard(it, saved)
        : it.drill ? drillCard(sessions, it.drill, today)
          : `<a class="card drill" href="${escape(it.href)}"><div class="title">${escape(it.title)}</div><div class="meta">${escape(it.blurb)}</div></a>`)).join('')}</div>
    </section>`).join('');

  // Exercises you made yourself (a scale from the Scales page, a backing track), kept apart from the ready-made ones.
  const ready = new Set([...Object.values(EXERCISES), ...DEMOS].map((e) => e.title)); // the first launch's two demos are in the list above too
  const own = exercises.filter((s) => !ready.has(s.title));
  $('pr-mine').hidden = !own.length;
  $('pr-exercises').innerHTML = own.map((s) => `<a class="card" href="#song/${escape(s.id)}"><div class="title">${escape(s.title)}</div>
    <div class="meta">${s.practiceSeconds ? `${formatDuration(s.practiceSeconds)} practiced` : 'Exercise'}${s.bestSpeed ? ` · top ${escape(s.bestSpeed)}%` : ''}</div></a>`).join('');
}
