// The song worker: runs on the computer and fills in songs asked for on the phone.
//
//   node scripts/songworker.mjs              one round, then stop
//   node scripts/songworker.mjs --loop       a round every 5 minutes (--every MIN), until stopped
//   node scripts/songworker.mjs --dry        sync and list what was asked, run nothing
//
// The phone saves "get me this song" as a placeholder in the private GitHub library (js/wanted.js). This
// worker is one more device of that library (the same merge as the app, js/sync.js): it takes each
// placeholder, finds the video (official audio / lyric / music video of the artist), runs
// tests/yt2gp5/fromlink.py (official UG tab, tab -> .gp, sync, QA gate), and when the gate says PASS puts
// the finished song under the placeholder's uid, so the phone's next sync replaces it. Any other result
// leaves a short reason on the placeholder (shown on the phone); nothing half-synced is ever delivered.
//
// One-time setup: %USERPROFILE%\.fretboard\sync.json = { "repo": "owner/name", "token": "..." }, the same
// private repository and fine-grained token (Contents: read and write) as the app's Sync and backup panel.
// Or the environment variables FRETBOARD_SYNC_REPO and FRETBOARD_SYNC_TOKEN.
// To hold the pipeline (it is CPU work), create the file %USERPROFILE%\.fretboard\worker\PAUSE: rounds still
// sync, no song is fetched until the file is deleted.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncLibrary, githubRemote, songRecord, songFromRecord } from '../js/sync.js';
import { nextWanted, wantWorking, wantFailed, wantDone } from '../js/wanted.js';
import { readFretboardFile } from '../js/sharecore.js';
import { rankResults, songQuery } from '../js/ytsearch.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = join(homedir(), '.fretboard');
const DEVICE = 'the computer';

/* ---------- this computer's copy of the library ---------- */

/** The store syncLibrary needs, kept in a folder: songs/<id>.json (the synced form) and meta.json. */
export function fileStore(dir) {
  mkdirSync(join(dir, 'songs'), { recursive: true });
  const metaFile = join(dir, 'meta.json');
  const meta = { nextId: 1, state: {}, setlists: [], sessions: [], ...(existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {}) };
  const save = () => writeFileSync(metaFile, JSON.stringify(meta));
  const songFile = (id) => join(dir, 'songs', `${id}.json`);
  const read = (f) => { const { id, record } = JSON.parse(readFileSync(join(dir, 'songs', f), 'utf8')); return Object.assign(songFromRecord(record), { id }); };
  return {
    get state() { return meta.state; },
    setState(s) { meta.state = s; save(); },
    async listSongs() { return readdirSync(join(dir, 'songs')).filter((f) => f.endsWith('.json')).map(read); },
    async putSong(song) {
      const id = song.id ?? meta.nextId++;
      writeFileSync(songFile(id), JSON.stringify({ id, record: songRecord({ ...song, id }) }));
      save();
      return id;
    },
    async deleteSong(id) { rmSync(songFile(id), { force: true }); },
    async getSetlists() { return meta.setlists; },
    async setSetlists(lists) { meta.setlists = lists; save(); },
    async listSessions() { return meta.sessions; },
    async addSession(s) { meta.sessions.push(s); save(); },
  };
}

/* ---------- one round ---------- */

const REASONS = {
  LISTEN: 'it lined up, but the check isn’t sure: it needs a listen on the computer',
  FAIL: 'the tab and the video don’t line up (the sync check failed)',
};
const reasonOf = (o) => o.reason || REASONS[o.verdict] || 'something went wrong on the computer';

/**
 * Takes every asked song, one at a time. runner({ title, artist }) → { verdict: 'PASS'|'LISTEN'|'FAIL'|'ERROR',
 * file?, reason? }. The phone sees "working" while a song runs and the finished song (or the reason) after.
 * @returns {{ done: number, failed: number, asked: number }}
 */
export async function round({ store, remote, runner, device = DEVICE, log = () => {}, paused = () => false, dry = false }) {
  let state = store.state;
  const pull = async () => {
    const out = await syncLibrary({ store, remote, state, device });
    state = out.state;
    store.setState(state);
    return out;
  };
  await pull();
  const asked = nextWanted(await store.listSongs());
  const out = { done: 0, failed: 0, asked: asked.length };
  log(asked.length ? `${asked.length} song${asked.length > 1 ? 's' : ''} asked for: ${asked.map((s) => `${s.artist ? s.artist + ' - ' : ''}${s.title}`).join(', ')}` : 'nothing asked for');
  if (dry || paused()) { if (paused() && asked.length) log('paused (the PAUSE file is there): leaving them for later'); return out; }
  for (const song of asked) {
    const name = `${song.artist ? song.artist + ' - ' : ''}${song.title}`;
    await store.putSong(wantWorking(song, device));
    await pull(); // the phone shows "your computer is getting it…"
    let result;
    try { result = await runner({ title: song.title, artist: song.artist || '' }); } catch (e) { result = { verdict: 'ERROR', reason: String(e?.message || e) }; }
    let made = null;
    if (result.verdict === 'PASS') {
      try { made = readFretboardFile(readFileSync(result.file, 'utf8'))?.songs[0] || null; } catch { /* reported below */ }
      if (!made) result = { verdict: 'ERROR', reason: 'the finished song file could not be read' };
    }
    if (made) { await store.putSong(wantDone(song, made)); out.done++; log(`${name}: PASS, delivered`); }
    else { await store.putSong(wantFailed(song, reasonOf(result))); out.failed++; log(`${name}: ${result.verdict}: ${reasonOf(result)}`); }
    await pull();
  }
  return out;
}

/* ---------- the pipeline (Python) ---------- */

function exec(cmd, args, { cwd = ROOT, timeoutMs = 45 * 60 * 1000, log = () => {} } = {}) {
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, windowsHide: true });
    let text = '';
    const take = (b) => { const s = b.toString('utf8'); text += s; for (const l of s.split(/\r?\n/)) if (l.trim()) log('    ' + l); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    const timer = setTimeout(() => { text += '\n(stopped: took too long)'; p.kill(); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); done({ code: 1, text: String(e.message) }); });
    p.on('close', (code) => { clearTimeout(timer); done({ code: code ?? 1, text }); });
  });
}

const lastLine = (t) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';

/** Candidate videos, best first: the artist's own, official audio / lyric before the music video (music videos often have an intro the tab lacks). */
export function candidates(found, { title, artist }) {
  const want = { ...songQuery({ title, artist }), hints: { words: [], flags: {} } };
  const rank = (r) => r.score + (/\b(official )?(audio|lyrics?)\b/i.test(r.title) ? 1.5 : 0);
  return rankResults(found, want)
    .filter((r) => r.cat === 'official' || r.cat === 'artist')
    .filter((r) => r.score >= 4)
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 3);
}

/** The real runner: find the videos, try them in order until one lines up (PASS), else report the best try. */
export function pipelineRunner({ python = 'python', log = () => {} } = {}) {
  return async ({ title, artist }) => {
    const search = await exec(python, ['tests/yt2gp5/ytfind.py', `${artist} ${title} official audio`], { timeoutMs: 120000 });
    let found;
    try { found = JSON.parse(search.text.slice(search.text.indexOf('['))); } catch { return { verdict: 'ERROR', reason: 'YouTube search failed: ' + lastLine(search.text) }; }
    const list = candidates(found, { title, artist });
    if (!list.length) return { verdict: 'ERROR', reason: 'no official video found on YouTube' };
    let best = null;
    for (const c of list) {
      log(`  trying ${c.title} (${c.author})`);
      const r = await exec(python, ['tests/yt2gp5/fromlink.py', `https://www.youtube.com/watch?v=${c.id}`, ...(title ? ['--title', title] : []), ...(artist ? ['--artist', artist] : [])], { log });
      const file = /^Done: (.+)$/m.exec(r.text)?.[1]?.trim();
      const verdict = { 0: 'PASS', 2: 'LISTEN', 3: 'FAIL' }[r.code] || 'ERROR';
      if (verdict === 'PASS' && file) return { verdict, file, video: c.id };
      if (verdict === 'ERROR') {
        if (/no Official tab/i.test(r.text)) return { verdict, reason: 'no official tab on Ultimate Guitar' }; // another video won't change that
        best ||= { verdict, reason: lastLine(r.text) };
        continue;
      }
      if (!best || best.verdict === 'ERROR' || (verdict === 'LISTEN' && best.verdict === 'FAIL')) best = { verdict, file, video: c.id };
    }
    return best;
  };
}

/* ---------- command line ---------- */

function config() {
  const f = join(HOME, 'sync.json');
  const c = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')) : {}; // PowerShell 5.1 writes a BOM
  const repo = process.env.FRETBOARD_SYNC_REPO || c.repo;
  const token = process.env.FRETBOARD_SYNC_TOKEN || c.token;
  if (!repo || !token) throw new Error(`No sync settings. Put { "repo": "owner/name", "token": "..." } in ${f} (the same private repository and token as the app's Sync and backup panel).`);
  return { repo, token };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function main() {
  const args = process.argv.slice(2);
  const dir = join(HOME, 'worker');
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, 'worker.log');
  const log = (m) => { const line = `${new Date().toISOString().slice(0, 19).replace('T', ' ')}  ${m}`; console.log(line); try { appendFileSync(logFile, line + '\n'); } catch { /* ignore */ } };
  const remote = githubRemote(config());
  const lock = join(dir, 'lock');
  if (existsSync(lock) && alive(Number(readFileSync(lock, 'utf8')))) { console.error('Another song worker is running already (it shares the collector Chrome).'); process.exit(1); }
  writeFileSync(lock, String(process.pid));
  const unlock = () => rmSync(lock, { force: true });
  process.on('exit', unlock);
  process.on('SIGINT', () => process.exit(130));
  const store = fileStore(join(dir, 'library'));
  const runner = pipelineRunner({ log });
  const every = (Number(args[args.indexOf('--every') + 1]) || 5) * 60 * 1000;
  for (;;) {
    try { await round({ store, remote, runner, log, dry: args.includes('--dry'), paused: () => existsSync(join(dir, 'PAUSE')) }); } catch (e) { log('round failed: ' + (e?.message || e)); if (!args.includes('--loop')) process.exitCode = 1; }
    if (!args.includes('--loop')) break;
    await new Promise((r) => setTimeout(r, every));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e?.message || e); process.exit(1); });
