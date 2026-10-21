// Practice log: totals, streak, per-song time and recent sessions.
import { listSessions } from './db.js';
import { formatDuration } from './practice.js';

const $ = (id) => document.getElementById(id);
const DAY = 86400000;
const dayKey = (t) => new Date(t).toDateString();
const startOfDay = (t) => new Date(new Date(t).toDateString()).getTime();
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function streak(sessions) {
  const days = new Set(sessions.map((s) => startOfDay(s.start)));
  let day = startOfDay(Date.now());
  if (!days.has(day)) day -= DAY; // today not practiced yet doesn't break the streak
  let count = 0;
  while (days.has(day)) { count++; day -= DAY; }
  return count;
}

export async function renderLog() {
  const sessions = (await listSessions()).sort((a, b) => b.start - a.start);
  const today = startOfDay(Date.now());
  const sum = (list) => list.reduce((n, s) => n + s.seconds, 0);

  const stats = [
    ['Today', formatDuration(sum(sessions.filter((s) => s.start >= today)))],
    ['Last 7 days', formatDuration(sum(sessions.filter((s) => s.start >= today - 6 * DAY)))],
    ['Day streak', streak(sessions)],
    ['All time', formatDuration(sum(sessions))],
  ];
  $('log-stats').innerHTML = stats.map(([label, value]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`).join('');

  const bySong = new Map();
  for (const s of sessions) {
    const entry = bySong.get(s.songId ?? s.title) ?? { title: s.title, artist: s.artist, seconds: 0, best: 0, count: 0 };
    entry.seconds += s.seconds;
    entry.best = Math.max(entry.best, s.maxSpeed || 0);
    entry.count++;
    bySong.set(s.songId ?? s.title, entry);
  }
  $('log-songs').innerHTML = [...bySong.values()].sort((a, b) => b.seconds - a.seconds).map((e) => `
    <div class="log-row"><span>${escape(e.title)} <span class="muted">${escape(e.artist)}</span></span>
    <span class="muted">${e.count} session${e.count === 1 ? '' : 's'}${e.best ? ` · top speed ${escape(e.best)}%` : ''} · <b>${formatDuration(e.seconds)}</b></span></div>`).join('')
    || '<div class="empty">No practice logged yet. Time is tracked automatically while a song is playing (or while a text tab is open).</div>';

  let lastDay = '';
  $('log-sessions').innerHTML = sessions.slice(0, 60).map((s) => {
    const day = dayKey(s.start);
    const header = day !== lastDay ? `<div class="log-day">${day}</div>` : '';
    lastDay = day;
    const time = new Date(s.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${header}<div class="log-row"><span>${escape(s.title)}</span>
      <span class="muted">${time}${s.maxSpeed ? ` · up to ${escape(s.maxSpeed)}%` : ''} · <b>${formatDuration(s.seconds)}</b></span></div>`;
  }).join('') || '<div class="empty">Nothing yet.</div>';
}
