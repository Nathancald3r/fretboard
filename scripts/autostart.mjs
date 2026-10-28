// Starts the Fretboard server when Windows starts: a hidden launcher in your Startup folder that runs scripts/serve.mjs.
//   node scripts/autostart.mjs install | remove | status
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'Fretboard server.vbs';

const q = (s) => s.replace(/"/g, '""');

/** The launcher's text: runs `node scripts\serve.mjs` in the project folder with no window. */
export function launcherText(node, root) {
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${q(root)}"`,
    `sh.Run """${q(node)}"" scripts\\serve.mjs", 0, False`,
    '',
  ].join('\r\n');
}

const startupDir = () => join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');

function main() {
  const cmd = process.argv[2];
  const file = join(startupDir(), NAME);
  if (!process.env.APPDATA) { console.error('This needs Windows (no APPDATA).'); process.exit(1); }
  if (cmd === 'install') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, launcherText(process.execPath, ROOT));
    console.log(`Installed: ${file}\nThe server starts when you log in to Windows. To start it now without logging out:\n  wscript "${file}"`);
  } else if (cmd === 'remove') {
    if (existsSync(file)) { unlinkSync(file); console.log(`Removed: ${file}`); } else console.log('Not installed.');
  } else if (cmd === 'status') {
    console.log(existsSync(file) ? `Installed: ${file}` : 'Not installed.');
  } else {
    console.log('node scripts/autostart.mjs install | remove | status');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
