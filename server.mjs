// Tiny static file server for local use: `npm start`, then open http://localhost:8420
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAutosync, parseRequest } from './scripts/autosync.mjs';
import { pipelineRunner } from './scripts/songworker.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 8420;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.sf2': 'application/octet-stream',
};

// The song line-up in the background (scripts/autosync.mjs): the app asks after a song comes in from UG.
// It runs programs on this computer, so only this computer's own pages may ask (not another device, not another site).
const autosync = createAutosync({ runner: pipelineRunner() });
const own = (req) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')
  && /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(req.socket.remoteAddress || '')
  && (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`);
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

async function api(req, res, url) {
  if (!own(req)) return json(res, 403, { ok: false });
  if (url.pathname === '/api/autosync/file' && req.method === 'GET') {
    const text = autosync.file(url.searchParams.get('key') || '');
    if (text == null) return json(res, 404, { ok: false });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(text);
  }
  if (url.pathname !== '/api/autosync') return json(res, 404, { ok: false });
  if (req.method === 'GET') return json(res, 200, { ok: true, jobs: autosync.list() });
  if (req.method !== 'POST') return json(res, 405, { ok: false });
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(res, 413, { ok: false }); }
  let want;
  try { want = parseRequest(JSON.parse(body)); } catch { return json(res, 400, { ok: false, why: 'Not JSON.' }); }
  if (want.error) return json(res, 400, { ok: false, why: want.error });
  return json(res, 200, { ok: true, job: autosync.start(want) });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root) || file.includes('node_modules')) throw new Error('forbidden');
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, () => console.log(`Fretboard running at http://localhost:${port}`));
