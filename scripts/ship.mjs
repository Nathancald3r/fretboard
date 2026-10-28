// Commit and push your own files to main, with the line-ending check built in:
//   node scripts/ship.mjs -m "message" file1 file2 ...      (only the files named: other sessions share the folder)
//   node scripts/ship.mjs --check file1 ...                 (only the check, no commit)
// For each file it compares the line endings with the last commit (CRLF or LF). A file whose endings flipped
// is put back to its old endings before committing, so a small edit never shows as the whole file changed.
// It refuses out/ folders, APKs and the test scratch folders (_xxx/). It adds the Co-Authored-By line.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
const die = (msg) => { console.error(`STOP: ${msg}`); process.exit(1); };
const CO = 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>';

const args = process.argv.slice(2);
const check = args.includes('--check');
let msg = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-m') msg = args[++i];
  else if (args[i] !== '--check' && args[i] !== '--no-numbers') files.push(args[i].replace(/\\/g, '/'));
}
if (!files.length) die('name the files to commit');
if (!check && !msg) die('give a message with -m');

const banned = (f) => /(^|\/)out\//.test(f) || /\.apk$/i.test(f) || /^_[^/]+\//.test(f) || /(^|\/)(marks|truth)\//.test(f);
for (const f of files) if (banned(f)) die(`${f} is never committed (out/, APKs, _test folders, marks/, truth/)`);

// A change to the sync code needs its numbers (the user: "always update numbers when you make a change to song"):
// run syncreport.py --save "what changed" and ship the history files with it. --no-numbers skips this for an edit that can't move a number.
const SYNC_CODE = /^tests\/yt2gp5\/(wavefit|qa|syncqa|fixsync|listen|fromlink|ladder|truthbench|drumclock|startcal)\.py$/;
if (!args.includes('--no-numbers') && files.some((f) => SYNC_CODE.test(f)) && !files.includes('tests/yt2gp5/history/sync-history.json'))
  die('this changes the sync code, so save its numbers: python tests/yt2gp5/syncreport.py --save "what changed", then ship tests/yt2gp5/history/sync-history.json and dashboard.html with it (--no-numbers if nothing can move)');

const style = (text) => {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? 'CRLF' : lf ? 'LF' : null;
};
for (const f of files) {
  if (!existsSync(join(root, f))) continue; // a deleted file
  const old = git('show', `HEAD:${f}`);
  if (old.status !== 0) { console.log(`new  ${f}`); continue; }
  const was = style(old.stdout);
  const text = readFileSync(join(root, f), 'utf8');
  const now = style(text);
  if (was && now && was !== now) {
    const fixed = was === 'CRLF' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
    writeFileSync(join(root, f), fixed);
    console.log(`fixed ${f}: line endings had flipped to ${now}, back to ${was}`);
  }
  const st = git('diff', '--numstat', 'HEAD', '--', f).stdout.trim();
  if (st) console.log(`     ${f}: +${st.split('\t')[0]} -${st.split('\t')[1]}`);
}
if (check) process.exit(0);

let r = git('add', '--', ...files);
if (r.status !== 0) die(r.stderr);
r = git('commit', '-m', `${msg}\n\n${CO}`, '--', ...files);
if (r.status !== 0) die((r.stdout + r.stderr).trim());
r = git('push', 'origin', 'main');
if (r.status !== 0) die(`committed but the push failed: ${r.stderr.trim()}`);
console.log(git('log', '--oneline', '-1').stdout.trim(), '(pushed)');
