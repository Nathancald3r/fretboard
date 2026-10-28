// Keeps the user's own server (server.mjs) running: starts it, starts it again if it stops, pulls new code from
// GitHub, and restarts it when its code changes. A restart waits until no line-up is running, so it never kills a song
// being lined up.
//   node scripts/serve.mjs          (port 8420, or PORT=...)
// Log: %USERPROFILE%\.fretboard\server.log. scripts/autostart.mjs starts this when Windows starts.
import { spawn, execFile } from 'node:child_process';
import { readFileSync, appendFileSync, mkdirSync, statSync, writeFileSync, watchFile, unwatchFile } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOGDIR = join(homedir(), '.fretboard');
const LOG = join(LOGDIR, 'server.log');
const PULL_EVERY_MS = 60 * 60 * 1000;

/** The files `entry` imports from this project, and the files those import (static imports of ./ and ../ paths only). */
export function serverFiles(root, entry = 'server.mjs', read = (p) => readFileSync(p, 'utf8')) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    let text;
    try { text = read(file); } catch { return; }
    seen.add(file);
    const found = [...text.matchAll(/\b(?:import|export)\b[^'";]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g), ...text.matchAll(/\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g)];
    for (const m of found) walk(resolve(dirname(file), m[1]));
  };
  walk(resolve(root, entry));
  return [...seen];
}

/** True when the server's job list has nothing queued or running (the only time a restart is safe). */
export const idle = (jobs) => !(jobs || []).some((j) => j.state === 'queued' || j.state === 'running');

/** Milliseconds to wait before starting a server that stopped; grows while it keeps dying within seconds of starting. */
export const backoff = (quickDeaths) => Math.min(30000, 2000 * 2 ** Math.min(quickDeaths, 4));

const listening = (port) => new Promise((done) => {
  const s = connect({ port, host: '127.0.0.1', timeout: 1000 });
  s.on('connect', () => { s.destroy(); done(true); });
  s.on('error', () => done(false));
  s.on('timeout', () => { s.destroy(); done(false); });
});

const git = (args) => new Promise((done) => {
  execFile('git', args, { cwd: ROOT, timeout: 60000, windowsHide: true }, (err, out, errout) => done({ ok: !err, out: String(out || '').trim(), err: String(errout || err?.message || '').trim() }));
});

async function main() {
  const port = Number(process.env.PORT) || 8420;
  mkdirSync(LOGDIR, { recursive: true });
  try { if (statSync(LOG).size > 1e6) writeFileSync(LOG, ''); } catch { /* no log yet */ }
  const log = (m) => {
    const now = new Date();
    const line = `${new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ')} ${m}`;
    console.log(line);
    try { appendFileSync(LOG, line + '\n'); } catch { /* the log is a convenience */ }
  };
  if (await listening(port)) { log(`port ${port} is already served; nothing to do`); return; }

  let child = null, stopping = false, restarting = false, quick = 0, changed = '', told = false, watched = [];

  const rewatch = () => {
    for (const f of watched) unwatchFile(f);
    watched = serverFiles(ROOT);
    for (const f of watched) watchFile(f, { interval: 2000 }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) { changed = f; told = false; } });
  };

  const start = () => {
    const t0 = Date.now();
    rewatch();
    child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const say = (d) => { for (const l of String(d).split('\n')) if (l.trim()) log(l.trim()); };
    child.stdout.on('data', say);
    child.stderr.on('data', say);
    child.on('exit', (code) => {
      child = null;
      if (stopping) return;
      if (restarting) { restarting = false; start(); return; }
      quick = Date.now() - t0 < 10000 ? quick + 1 : 0;
      const wait = backoff(quick);
      log(`the server stopped (${code}); starting it again in ${wait / 1000} s`);
      setTimeout(start, wait);
    });
  };

  const pull = async () => {
    const r = await git(['pull', '--ff-only', '--quiet']);
    log(r.ok ? 'checked GitHub for new code' : `couldn’t update from GitHub: ${r.err.split('\n')[0]}`);
  };

  setInterval(async () => {
    if (!changed || !child || restarting) return;
    let jobs = [];
    try { jobs = (await (await fetch(`http://127.0.0.1:${port}/api/autosync`, { signal: AbortSignal.timeout(3000) })).json()).jobs; } catch { /* down: nothing to lose */ }
    if (!idle(jobs)) { if (!told) { told = true; log(`${relative(ROOT, changed)} changed; restarting once the line-up is done`); } return; }
    log(`${relative(ROOT, changed)} changed; restarting the server`);
    changed = '';
    restarting = true;
    child.kill();
  }, 5000);

  const stop = () => { stopping = true; child?.kill(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  log(`starting the server on port ${port}`);
  start();
  pull();
  setInterval(pull, PULL_EVERY_MS);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e?.message || e); process.exit(1); });
