// The server keeper (scripts/serve.mjs) and its Windows launcher (scripts/autostart.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { serverFiles, idle, backoff } from '../scripts/serve.mjs';
import { launcherText } from '../scripts/autostart.mjs';

test('the watched files are the ones the server imports, and theirs', () => {
  const root = resolve('/p');
  const files = {
    [resolve(root, 'server.mjs')]: `import { createServer } from 'node:http';\nimport { a } from './scripts/a.mjs';\nimport {\n  b,\n  c } from "./scripts/b.mjs";`,
    [resolve(root, 'scripts/a.mjs')]: `export { x } from './deep/x.mjs'; import './side.mjs';`,
    [resolve(root, 'scripts/b.mjs')]: `import { a } from './a.mjs'; // a cycle\nimport fs from 'node:fs';`,
    [resolve(root, 'scripts/deep/x.mjs')]: `export const x = 1;`,
    [resolve(root, 'scripts/side.mjs')]: ``,
  };
  const got = serverFiles(root, 'server.mjs', (p) => { if (!(p in files)) throw new Error('missing'); return files[p]; });
  assert.deepEqual(got.map((p) => p.slice(root.length + 1).replace(/\\/g, '/')).sort(), ['scripts/a.mjs', 'scripts/b.mjs', 'scripts/deep/x.mjs', 'scripts/side.mjs', 'server.mjs']);
});

test('a missing import does not stop the walk', () => {
  const root = resolve('/p');
  const got = serverFiles(root, 'server.mjs', (p) => { if (p.endsWith('server.mjs')) return `import './gone.mjs';`; throw new Error('missing'); });
  assert.equal(got.length, 1);
});

test('a restart is safe only when nothing is queued or running', () => {
  assert.equal(idle([]), true);
  assert.equal(idle(undefined), true);
  assert.equal(idle([{ state: 'done' }, { state: 'failed' }]), true);
  assert.equal(idle([{ state: 'done' }, { state: 'running' }]), false);
  assert.equal(idle([{ state: 'queued' }]), false);
});

test('a server that keeps dying is started again more slowly, up to 30 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(backoff), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('the launcher runs node in the project folder with no window', () => {
  const t = launcherText('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\natha\\Desktop\\[4] Project Database\\Claude\\Song star');
  assert.match(t, /sh\.CurrentDirectory = "C:\\Users\\natha\\Desktop\\\[4\] Project Database\\Claude\\Song star"/);
  assert.match(t, /sh\.Run """C:\\Program Files\\nodejs\\node\.exe"" scripts\\serve\.mjs", 0, False/);
  assert.ok(t.includes('\r\n'));
});
