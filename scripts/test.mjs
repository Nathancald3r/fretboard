// Runs every test: node scripts/test.mjs            (all tests/*.test.mjs)
//                    node scripts/test.mjs --round   (also the round-trip import test, ~6 s, needs Python Playwright)
// Prints one line per file and exits 1 if any failed.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(root, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort();
const failed = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [join('tests', f)], { cwd: root, encoding: 'utf8' });
  const ok = r.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f}`);
  if (!ok) { failed.push(f); console.log((r.stdout + r.stderr).trim().split('\n').slice(-15).join('\n')); }
}
if (process.argv.includes('--round')) {
  const r = spawnSync('python', [join('tests', 'roundtrip', 'roundtrip.py')], { cwd: root, encoding: 'utf8' });
  console.log((r.stdout + r.stderr).trim().split('\n').slice(-12).join('\n'));
  if (r.status !== 0) failed.push('roundtrip.py');
}
console.log(failed.length ? `\n${failed.length} FAILED: ${failed.join(', ')}` : `\nall ${files.length} passed`);
process.exit(failed.length ? 1 : 0);
