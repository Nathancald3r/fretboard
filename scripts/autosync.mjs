// Background line-up of a song with its video, for the app on this computer (server.mjs: /api/autosync).
//
// After a song comes in from Ultimate Guitar the app asks here; the pipeline (scripts/songworker.mjs's
// pipelineRunner: find the video, tests/yt2gp5/fromlink.py, the QA gate) runs one song at a time in the
// background, and the app polls each job's state. The app keeps working meanwhile.
import { readFileSync } from 'node:fs';

/** What fromlink.py's numbered lines mean, in words for the app's pill. */
const STEPS = { 1: 'reading the video', 2: 'checking the official tab', 3: 'getting its tracks', 4: 'building the song', 5: 'lining the tab up with the video' };

export const UG_URL = /^https:\/\/(?:tabs\.|www\.)?ultimate-guitar\.com\/tab\/[\w\-./%]+-official-\d+$/i;

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^-+\s*/, '').slice(0, 120);

export const jobKey = (title, artist) => `${artist}|${title}`.toLowerCase();

/** The request body made safe: { title, artist, ug } or { error }. Nothing here reaches a shell, but it does reach a command line. */
export function parseRequest(body) {
  const title = clean(body?.title);
  if (!title) return { error: 'The song needs a title.' };
  const ug = typeof body?.ug === 'string' && body.ug ? body.ug.trim().split(/[?#]/)[0] : '';
  if (ug && !UG_URL.test(ug)) return { error: 'The tab link must be an Official tab on Ultimate Guitar.' };
  return { title, artist: clean(body?.artist), ug };
}

/** The pill's words for one line of the pipeline's output, or '' when the line says nothing new. */
export function stepOf(line) {
  const n = /^\s*([1-5])\.\s/.exec(line);
  if (n) return STEPS[n[1]];
  const v = /^\s*trying (.+?)(?: \(.*\))?$/.exec(line);
  if (v) return `trying “${v[1].slice(0, 60)}”`;
  return '';
}

const shown = (j) => ({ key: j.key, title: j.title, artist: j.artist, state: j.state, step: j.step, verdict: j.verdict, deliver: j.deliver,
  timingOnly: j.timingOnly, reason: j.reason, hasFile: !!j.file, finished: j.finished });

/**
 * runner({ title, artist, ug, sync: true, log }) → { verdict, file?, timingOnly?, reason? } (pipelineRunner's shape).
 * States: queued → running → done (a song file was made) | failed (nothing to offer).
 * deliver = the QA gate passed (PASS, or timing only): the app puts it in the library by itself.
 */
export function createAutosync({ runner, read = (f) => readFileSync(f, 'utf8'), now = Date.now }) {
  const jobs = new Map();
  const queue = [];
  let busy = false;

  async function pump() {
    if (busy) return;
    const job = queue.shift();
    if (!job) return;
    busy = true;
    job.state = 'running';
    job.step = 'finding the video';
    let r;
    try { r = await runner({ title: job.title, artist: job.artist, ug: job.ug, sync: true, log: (l) => { job.step = stepOf(l) || job.step; } }); } catch (e) { r = { verdict: 'ERROR', reason: String(e?.message || e) }; }
    r ||= { verdict: 'ERROR', reason: 'nothing came back' };
    job.verdict = r.verdict;
    job.timingOnly = !!r.timingOnly;
    job.deliver = r.verdict === 'PASS' || !!r.timingOnly;
    job.file = r.file || '';
    job.reason = r.reason || '';
    job.state = job.file ? 'done' : 'failed';
    job.finished = now();
    busy = false;
    pump();
  }

  return {
    /** Queues a song (or returns its job when it is queued or running already). */
    start(req) {
      const key = jobKey(req.title, req.artist);
      const old = jobs.get(key);
      if (old && (old.state === 'queued' || old.state === 'running')) return shown(old);
      const job = { key, ...req, state: 'queued', step: 'waiting its turn', verdict: '', deliver: false, timingOnly: false, reason: '', file: '', finished: 0 };
      jobs.set(key, job);
      queue.push(job);
      pump();
      return shown(job);
    },
    list: () => [...jobs.values()].map(shown),
    /** The finished song file's text (a .fretboard), or null. */
    file(key) {
      const j = jobs.get(key);
      if (!j?.file) return null;
      try { return read(j.file); } catch { return null; }
    },
  };
}
