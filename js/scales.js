// Scale practice: fretboard diagram of a scale position, and a playable exercise
// (saved to the library) for the player's loop and speed trainer.
import { listSongs, putSong, updateSong } from './db.js';
import { NOTES, SCALES, noteName, scalePosition, scaleNeck, scaleTex, scaleTitle } from './theory.js';

const $ = (id) => document.getElementById(id);
const PREFS_KEY = 'fretboard-scale-prefs';
const MAX_FRET = 17;
const FIELDS = ['sc-root', 'sc-scale', 'sc-position', 'sc-labels', 'sc-pattern', 'sc-value', 'sc-tempo'];
const FLAT_ROOTS = [1, 3, 8, 10, 5];

function options() {
  return {
    root: Number($('sc-root').value),
    scale: $('sc-scale').value,
    position: Number($('sc-position').value),
    pattern: $('sc-pattern').value,
    noteValue: Number($('sc-value').value),
    tempo: Math.max(30, Math.min(260, Number($('sc-tempo').value) || 80)),
  };
}

function fillPositions() {
  const count = SCALES[$('sc-scale').value].length;
  const keep = Math.min(Number($('sc-position').value) || 0, count - 1);
  $('sc-position').innerHTML = '';
  for (let i = 0; i < count; i++) $('sc-position').add(new Option(`Position ${i + 1}`, i));
  $('sc-position').value = keep;
}

function drawDiagram() {
  const { root, scale, position } = options();
  const intervals = SCALES[scale];
  const box = scalePosition(root, intervals, position);
  const inBox = new Set(box.notes.map((n) => `${n.string}:${n.fret}`));
  const labelOf = (n) => ($('sc-labels').value === 'note' ? noteName(n.midi % 12, FLAT_ROOTS.includes(root)) : n.degree);

  const left = 34, top = 22, fw = 52, sg = 26;
  const width = left + (MAX_FRET + 0.5) * fw;
  const height = top * 2 + sg * 5 + 14;
  const x = (fret) => (fret === 0 ? left - 16 : left + (fret - 0.5) * fw);
  const y = (string) => top + (5 - string) * sg; // high e on top, like tab

  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${scaleTitle(options())} on the fretboard">`;
  svg += `<rect x="${left + (box.lo - 0.5 > 0 ? box.lo - 1 : 0) * fw}" y="${top - 12}" width="${(box.hi - Math.max(0, box.lo - 1)) * fw}" height="${sg * 5 + 24}" class="fb-window"/>`;
  for (let f = 0; f <= MAX_FRET; f++) {
    svg += `<line x1="${left + f * fw}" x2="${left + f * fw}" y1="${top}" y2="${top + sg * 5}" class="${f === 0 ? 'fb-nut' : 'fb-fret'}"/>`;
    if ([3, 5, 7, 9, 15, 17].includes(f)) svg += `<circle cx="${x(f)}" cy="${top + sg * 2.5}" r="5" class="fb-inlay"/>`;
    if (f === 12) svg += `<circle cx="${x(f)}" cy="${top + sg * 1.5}" r="5" class="fb-inlay"/><circle cx="${x(f)}" cy="${top + sg * 3.5}" r="5" class="fb-inlay"/>`;
    if (f) svg += `<text x="${x(f)}" y="${height - 4}" class="fb-num">${f}</text>`;
  }
  for (let s = 0; s < 6; s++) svg += `<line x1="${left}" x2="${left + MAX_FRET * fw}" y1="${y(s)}" y2="${y(s)}" class="fb-string" style="stroke-width:${1 + (5 - s) * 0.35}"/>`;
  for (const n of scaleNeck(root, intervals, MAX_FRET)) {
    const active = inBox.has(`${n.string}:${n.fret}`);
    const cls = `fb-dot${active ? ' on' : ''}${n.degree === '1' ? ' root' : ''}`;
    svg += `<g class="${cls}"><circle cx="${x(n.fret)}" cy="${y(n.string)}" r="${active ? 11 : 8}"/>`;
    if (active) svg += `<text x="${x(n.fret)}" y="${y(n.string) + 4}">${labelOf(n)}</text>`;
    svg += '</g>';
  }
  $('sc-diagram').innerHTML = svg + '</svg>';
  // On narrow screens the neck scrolls sideways; keep the current position in view.
  const el = $('sc-diagram');
  const px = el.scrollWidth / width;
  el.scrollLeft = ((left + ((box.lo + box.hi) / 2 - 0.5) * fw) * px) - el.clientWidth / 2;
  $('sc-hint').textContent = `Frets ${box.lo}–${box.hi}. Orange = root (1). Faded dots show the rest of the scale across the neck — move up one position to connect them.`;
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(Object.fromEntries(FIELDS.map((id) => [id, $(id).value])))); } catch { /* ignore */ }
}

function loadPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    for (const id of FIELDS) {
      if (id === 'sc-position') continue;
      if (prefs[id] !== undefined) $(id).value = prefs[id];
    }
    fillPositions();
    if (prefs['sc-position'] !== undefined) $('sc-position').value = prefs['sc-position'];
  } catch { fillPositions(); }
}

// Reuses the library entry for the same exercise so its practice history stays together.
async function practice() {
  const opts = options();
  const title = scaleTitle(opts);
  const data = scaleTex(opts);
  const existing = (await listSongs()).find((s) => s.kind === 'tex' && s.title === title);
  let id;
  if (existing) {
    id = existing.id;
    await updateSong(id, { data });
  } else {
    id = await putSong({ kind: 'tex', title, artist: 'Scale', data, added: Date.now() });
  }
  location.hash = `song/${id}`;
}

export const renderScales = drawDiagram;

export function initScales() {
  NOTES.forEach((_, pc) => $('sc-root').add(new Option(noteName(pc, FLAT_ROOTS.includes(pc)), pc)));
  $('sc-root').value = 9; // A
  Object.keys(SCALES).forEach((name) => $('sc-scale').add(new Option(name, name)));
  $('sc-scale').value = 'Minor pentatonic';
  loadPrefs();
  $('sc-scale').addEventListener('change', fillPositions);
  FIELDS.forEach((id) => $(id).addEventListener('change', () => { drawDiagram(); savePrefs(); }));
  $('sc-play').addEventListener('click', practice);
  drawDiagram();
}
