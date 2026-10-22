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
// Second bug: two different marks on the same beat (a chord name and a swell "<") were put
// on one line, drawn over each other. A line is shared at a beat only by the same kind of mark.
const SLOT = 'if (this.shared.lastBeat === band.firstBeat) return true;';
const SLOT_FIX = 'if (this.shared.lastBeat === band.firstBeat && this.bands.every((b) => b.info.effectId === band.info.effectId)) return true;';
let code = readFileSync(script, 'utf8').replace('return this.loadedMidiInfo;', 'return this._loadedMidiInfo;');
if (!code.includes(SLOT)) throw new Error('alphaTab changed: effect line patch no longer applies');
code = code.replace(SLOT, SLOT_FIX);
// The TAB clef is drawn on the first line only, not at the start of every line.
const CLEF = '\t\t\t\tthis.createStartSpacing();\n\t\t\t\tthis.addPreBeatGlyph(new TabClefGlyph(0, this.getLineY(center)));\n';
if (!code.includes(CLEF)) throw new Error('alphaTab changed: TAB clef patch no longer applies');
code = code.replace(CLEF, '\t\t\t\tif (!this.bar.previousBar) {\n\t' + CLEF.replace('\n\t\t\t\tthis', '\n\t\t\t\t\tthis') + '\t\t\t\t}\n');
writeFileSync(script, code);
console.log('alphaTab copied to vendor/alphatab');
