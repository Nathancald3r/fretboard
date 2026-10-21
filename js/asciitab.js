// Converts plain-text (ASCII) guitar tab into alphaTex so alphaTab can play it.
//
// ASCII tab has no rhythm, so timing is guessed from spacing: each bar is treated
// as 4/4 and every note's position within the bar is snapped to a 16th (or 32nd)
// grid. Bars without bar lines fall back to straight eighth notes.

const TAB_CHARS = /[-0-9|hpbrx\/\\~^().<>*=sv:]/i;
const LABEL = /^\s*([A-Ga-g][#b]?)\s*(?=[|:\-])/;
const NOTE_NAMES = { c: 0, 'c#': 1, db: 1, d: 2, 'd#': 3, eb: 3, e: 4, f: 5, 'f#': 6, gb: 6, g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11 };
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Default open-string pitches (MIDI), top line first.
const DEFAULT_TUNINGS = {
  4: [43, 38, 33, 28],
  5: [43, 38, 33, 28, 23],
  6: [64, 59, 55, 50, 45, 40],
  7: [64, 59, 55, 50, 45, 40, 35],
  8: [64, 59, 55, 50, 45, 40, 35, 30],
};
// [fraction of a whole note, alphaTex duration, dotted]
const VALUES = [
  [1, 1, false], [3 / 4, 2, true], [1 / 2, 2, false], [3 / 8, 4, true], [1 / 4, 4, false],
  [3 / 16, 8, true], [1 / 8, 8, false], [3 / 32, 16, true], [1 / 16, 16, false], [1 / 32, 32, false],
];

function isTabLine(line) {
  const body = line.replace(LABEL, '').trim();
  if (body.length < 6 || (body.match(/-/g) || []).length < 4) return false;
  let ok = 0;
  for (const ch of body) if (TAB_CHARS.test(ch) || ch === ' ') ok++;
  return ok / body.length > 0.9;
}

// Groups of consecutive tab lines (one "system" = one line per string).
function findSystems(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const systems = [];
  let current = [];
  const flush = () => {
    if (current.length >= 4 && current.length <= 8) systems.push(current);
    current = [];
  };
  for (const line of lines) {
    if (isTabLine(line)) current.push(line.replace(/\s+$/, ''));
    else flush();
  }
  flush();
  return systems;
}

function splitLabel(line) {
  const m = line.match(LABEL);
  const body = m ? line.slice(m[0].length) : line.replace(/^\s+/, '');
  // Drop notes written after the last bar line, like "|  x4" or "| (repeat)".
  const trimmed = body.replace(/\|([^|]*)$/, (all, tail) => (/\s/.test(tail.trim() ? tail : '') || /[a-z]{2,}|x\d/i.test(tail) ? '|' : all));
  return { label: m ? m[1] : null, body: trimmed };
}

function readTuning(labels, count) {
  const defaults = DEFAULT_TUNINGS[count];
  if (!defaults || labels.some((l) => !l)) return defaults;
  return labels.map((l, i) => {
    const pc = NOTE_NAMES[l.toLowerCase()];
    if (pc === undefined) return defaults[i];
    // Pick the octave closest to the default pitch for that string.
    let best = defaults[i];
    let bestDist = Infinity;
    for (let midi = pc; midi < 100; midi += 12) {
      const d = Math.abs(midi - defaults[i]);
      if (d < bestDist) { best = midi; bestDist = d; }
    }
    return best;
  });
}

const midiName = (midi) => NAMES[midi % 12] + (Math.floor(midi / 12) - 1);

// Reads notes, effects and bar lines from one system.
function parseSystem(lines) {
  const parts = lines.map(splitLabel);
  const width = Math.max(...parts.map((p) => p.body.length));
  const rows = parts.map((p) => p.body.padEnd(width, '-'));
  const bars = [];
  const events = [];

  for (let c = 0; c < width; c++) {
    if (rows.every((r) => r[c] === '|')) { bars.push(c); continue; }
    rows.forEach((row, s) => {
      const ch = row[c];
      const prev = row[c - 1] || '-';
      let fret = null;
      let len = 1;
      if (/\d/.test(ch) && !/\d/.test(prev)) {
        const two = row.slice(c, c + 2);
        if (/^\d\d$/.test(two) && Number(two) <= 24) { fret = Number(two); len = 2; }
        else fret = Number(ch);
      } else if (/x/i.test(ch) && !/[a-z]/i.test(prev) && !/[a-z]/i.test(row[c + 1] || '-')) {
        fret = 'x';
      }
      if (fret === null) return;
      const after = row[c + len] || '';
      const effects = [];
      if (/[hp]/i.test(after)) effects.push('h');
      else if (after === '/' || after === '\\') effects.push('sl');
      else if (after === 'b') effects.push('b (0 4)');
      if (row.slice(c + len, c + len + 3).includes('~')) effects.push('v');
      const note = { string: s + 1, fret, effects };

      // Notes that start in the same (or, after a two-digit fret, the next) column form one chord.
      const last = events[events.length - 1];
      const joins = last && (last.col === c || (last.col === c - 1 && last.wide)) && !last.notes.some((n) => n.string === note.string);
      if (joins) {
        last.notes.push(note);
        last.wide ||= len === 2;
      } else {
        events.push({ col: c, notes: [note], wide: len === 2 });
      }
    });
  }
  return { bars, events, width, labels: parts.map((p) => p.label), count: lines.length };
}

function durationsFor(fraction) {
  // Greedily split a length (in whole notes) into note values; first one carries the note.
  const out = [];
  let left = fraction;
  while (left > 1 / 64) {
    const v = VALUES.find(([f]) => f <= left + 1e-9);
    if (!v) break;
    out.push(v);
    left -= v[0];
  }
  return out.length ? out : [VALUES[VALUES.length - 1]];
}

const dur = ([, value, dotted]) => `.${value}${dotted ? '{d}' : ''}`;

function noteTex(n) {
  const head = n.fret === 'x' ? `x.${n.string}` : `${n.fret}.${n.string}`;
  return n.effects.length ? `${head}{${n.effects.join(' ')}}` : head;
}

function beatTex(notes, d) {
  const body = notes.length === 1 ? noteTex(notes[0]) : `(${notes.map(noteTex).join(' ')})`;
  return body + dur(d);
}

// Turns the events of one bar into alphaTex beats (with rests filling gaps).
function barTex(events, start, end) {
  const span = Math.max(1, end - start - 1);
  const grid = events.length <= 16 ? 16 : 32;
  let slots = events.map((e) => Math.round(((e.col - start - 1) / span) * grid));
  for (let i = 0; i < slots.length; i++) {
    slots[i] = Math.max(0, Math.min(grid - 1, slots[i]));
    if (i && slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1;
  }
  if (slots[slots.length - 1] >= grid) slots = events.map((_, i) => Math.floor((i * grid) / events.length));

  const beats = [];
  if (slots[0] > 0) durationsFor(slots[0] / grid).forEach((d) => beats.push('r' + dur(d)));
  events.forEach((e, i) => {
    const next = i + 1 < slots.length ? slots[i + 1] : grid;
    const [first, ...rest] = durationsFor((next - slots[i]) / grid);
    beats.push(beatTex(e.notes, first));
    rest.forEach((d) => beats.push('r' + dur(d)));
  });
  return beats.join(' ');
}

function systemBars(sys) {
  const { bars, events, width } = sys;
  const edges = [...new Set([-1, ...bars, width])].sort((a, b) => a - b);
  const out = [];
  const hasInnerBars = bars.some((b) => b > 2 && b < width - 3);

  if (!hasInnerBars) {
    // No usable bar lines: straight eighths, 8 per bar.
    for (let i = 0; i < events.length; i += 8) {
      const chunk = events.slice(i, i + 8);
      const beats = chunk.map((e) => beatTex(e.notes, VALUES[6]));
      if (chunk.length < 8) durationsFor((8 - chunk.length) / 8).forEach((d) => beats.push('r' + dur(d)));
      out.push(beats.join(' '));
    }
    return out;
  }
  for (let i = 0; i + 1 < edges.length; i++) {
    const [a, b] = [edges[i], edges[i + 1]];
    if (b - a < 3) continue; // "||" or a tiny edge piece
    const inBar = events.filter((e) => e.col > a && e.col < b);
    out.push(inBar.length ? barTex(inBar, a, b) : 'r.1');
  }
  return out;
}

const quote = (s) => `"${String(s || '').replace(/["\\]/g, '')}"`;

/**
 * @returns {{ tex: string, bars: number, strings: number } | null} null when no tab lines are found.
 */
export function asciiTabToAlphaTex(text, { title = '', artist = '', tempo = 100 } = {}) {
  const systems = findSystems(text).map(parseSystem).filter((s) => s.events.length);
  if (!systems.length) return null;

  // Use the most common string count; skip systems that don't match (e.g. a bass part).
  const counts = {};
  systems.forEach((s) => { counts[s.count] = (counts[s.count] || 0) + 1; });
  const strings = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
  const used = systems.filter((s) => s.count === strings);
  const tuning = readTuning(used[0].labels, strings);

  const bars = used.flatMap(systemBars);
  const header = [
    `\\title ${quote(title)}`,
    artist ? `\\artist ${quote(artist)}` : '',
    `\\tempo ${Math.round(tempo)}`,
    '.',
    `\\track ${quote(title || 'Guitar')}`,
    `\\staff {score tabs}`,
    `\\tuning ${tuning.map(midiName).join(' ')}`,
    strings <= 5 ? '\\instrument 33' : '\\instrument 27',
  ].filter(Boolean).join('\n');
  return { tex: `${header}\n${bars.join(' |\n')}`, bars: bars.length, strings };
}
