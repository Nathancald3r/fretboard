// Copies alphaTab's browser build (script, fonts, soundfont) into vendor/ so the
// app can be served as plain static files (local server or GitHub Pages).
import { cpSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@coderline', 'alphatab', 'dist');
const dest = join(root, 'vendor', 'alphatab');

if (!existsSync(src)) {
  console.error('alphaTab not installed. Run "npm install" first.');
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
// Only what the browser build needs: the UMD script (also used for its worker and
// audio worklet), the Bravura music font and the default soundfont.
const keep = ['alphaTab.js', 'font/Bravura.woff2', 'font/Bravura.woff', 'font/Bravura.otf', 'font/Bravura-OFL.txt',
  'soundfont/sonivox.sf2', 'soundfont/LICENSE'];
for (const file of keep) cpSync(join(src, file), join(dest, file));
// alphaTab 1.8.4 bug: the worker player's loadedMidiInfo getter returns itself (endless
// recursion, thrown whenever something subscribes to midiLoaded). Point it at the field.
const script = join(dest, 'alphaTab.js');
writeFileSync(script, readFileSync(script, 'utf8').replace('return this.loadedMidiInfo;', 'return this._loadedMidiInfo;'));
console.log('alphaTab copied to vendor/alphatab');
