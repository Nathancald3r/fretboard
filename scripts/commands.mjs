// Writes the command list as files you can keep: docs/Fretboard commands.md and docs/Fretboard commands.html.
//   node scripts/commands.mjs
// The commands, folders and notes live in docs/commands-page.html (the same page that is published as the
// "Fretboard commands" artifact). Edit the list there, run this, and both files are rebuilt.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(root, 'docs', 'commands-page.html'), 'utf8').replace(/\r\n/g, '\n');
const css = page.match(/<style id="css">([\s\S]*?)<\/style>/)[1];
const script = page.match(/<script>([\s\S]*)<\/script>/)[1];
const code = script.slice(0, script.indexOf('/* page */'));  // the data and the writers; the part after it needs a browser
const ctx = vm.createContext({ document: { getElementById: (id) => (id === 'css' ? { textContent: css } : null) }, navigator: {}, Date, JSON });
vm.runInContext(code, ctx);
const md = vm.runInContext('markdown()', ctx);
const html = vm.runInContext('standalone()', ctx);
writeFileSync(join(root, 'docs', 'Fretboard commands.md'), md);
writeFileSync(join(root, 'docs', 'Fretboard commands.html'), html);
console.log(`docs/Fretboard commands.md (${md.length} chars) and docs/Fretboard commands.html (${html.length} chars)`);
