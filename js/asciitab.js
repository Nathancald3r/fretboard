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
  if (!LABEL.test(line) && !/[|\d]/.test(body)) return false; // only dashes: a "palm mute---" line, not a string
  let ok = 0;
  for (const ch of body) if (TAB_CHARS.test(ch) || ch === ' ') ok++;
  return ok / body.length > 0.9;
}

// Words written on a string line ("2~~~~ let ring---") become dashes, so the line still reads as
// tab and its columns stay in place; a repeat sign between bars ("| x2  --0--|") becomes spaces.
// The string name at the start and runs of x (muted strums) stay.
function cleanLine(line) {
  const m = line.match(LABEL);
  const head = m ? m[0] : '';
  const body = line.slice(head.length)
    .replace(/(^|[\s|])(x\d+)(?=\s|$)/gi, (all, pre, x) => pre + ' '.repeat(x.length))
    .replace(/[A-Za-z]{2,}(?: [A-Za-z]{2,})*/g, (w) => (/^x+$/i.test(w) ? w : '-'.repeat(w.length)));
  return head + body;
}

// Groups of consecutive tab lines (one "system" = one line per string).
function findSystems(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(cleanLine);
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

const pcGap = (a, b) => Math.min((a - b + 12) % 12, (b - a + 12) % 12);

// Tempo, capo and tuning written above the tab: "Tempo: 196 (98)", "Capo on the 1st fret",
// "Tuning: Capo on the 1st fret (F, Bb, Eb, Ab, C, f)", "Tuning: Drop D".
function readHeader(text, strings, labels) {
  const out = {};
  const lines = text.split(/\r?\n/).filter((l) => !isTabLine(l));
  for (const line of lines) {
    const t = line.match(/\b(?:tempo|bpm)\b\s*[:=-]?\s*(\d{2,3})(?:\s*\(\s*(\d{2,3})\s*\))?/i) || line.match(/\b(\d{2,3})\s*bpm\b/i);
    if (t && out.tempo == null) {
      const a = Number(t[1]);
      const b = t[2] ? Number(t[2]) : 0;
      // "196 (98)": the first number is the tempo
      out.tempo = a;
    }
    const c = line.match(/\bcapo\b[^\d\n]{0,20}?(\d{1,2})/i);
    if (c && out.capo == null && Number(c[1]) <= 12) out.capo = Number(c[1]);
  }
  const defaults = DEFAULT_TUNINGS[strings];
  if (!defaults) return out;
  const shapes = (readTuning(labels, strings) || defaults).map((m) => m % 12); // top line first
  for (const line of lines) {
    const at = line.search(/\btuning\b/i);
    if (at < 0) continue;
    const rest = line.slice(at + 6);
    const drop = rest.match(/\bdrop\s*([A-G][#b]?)/i);
    const paren = rest.match(/\(([^)]*)\)/);
    const names = [...(paren ? paren[1] : rest).matchAll(/(?<![A-Za-z])([A-Ga-g](?:#|b(?![a-z]))?)(?![A-Za-z#])/g)].map((m) => m[1].toLowerCase());
    let pcs = null;
    if (names.length === strings && names.every((n) => NOTE_NAMES[n] !== undefined)) {
      // written low to high or high to low: take the order that fits the tab's strings best
      const asis = names.map((n) => NOTE_NAMES[n]);
      const flip = [...asis].reverse();
      const cost = (p) => p.reduce((s, x, i) => s + pcGap(x, shapes[i]), 0);
      pcs = cost(flip) <= cost(asis) ? flip : asis;
    } else if (drop && NOTE_NAMES[drop[1].toLowerCase()] !== undefined) {
      pcs = [...shapes];
      pcs[strings - 1] = NOTE_NAMES[drop[1].toLowerCase()];
    }
    if (pcs) { out.tuning = readTuning(pcs.map((x) => NAMES[x]), strings); break; }
  }
  return out;
}

// Whether the digits at columns c and c+1 of string s are two strums, not one two-digit fret.
// Strummed chords are often written with no dashes between strums ("000-00000000"): a run of three
// or more digits is strums, and so is a pair when another string starts a note at c+1.
function single(rows, s, c) {
  const row = rows[s];
  if (!/\d/.test(row[c] || '') || !/\d/.test(row[c + 1] || '')) return false;
  if (/\d/.test(row[c + 2] || '') || /\d/.test(row[c - 1] || '')) return true;
  return rows.some((r, k) => k !== s && /\d/.test(r[c + 1] || '') && !/\d/.test(r[c] || ''));
}

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
      if (/\d/.test(ch) && (!/\d/.test(prev) || single(rows, s, c - 1))) {
        const two = row.slice(c, c + 2);
        if (/^\d\d$/.test(two) && Number(two) <= 24 && !single(rows, s, c)) { fret = Number(two); len = 2; }
        else fret = Number(ch);
      } else if (/x/i.test(ch) && !/[a-wyz]/i.test(prev) && !/[a-wyz]/i.test(row[c + 1] || '-')) {
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
  return { bars, events, width, rows, labels: parts.map((p) => p.label), count: lines.length };
}

// Every column between two bar lines is one time slot ("|-2---2--|" is 8), except the second digit
// of a two-digit fret (12 is one slot) and a joining letter on its own between two notes ("5h7",
// "5/7", "7b9": the h is not a beat). Returns the slot of each column, and the slot count.
function barSlots(sys, a, b, inBar) {
  const { rows } = sys;
  const skip = new Set();
  for (const e of inBar) if (e.wide) skip.add(e.col + 1);
  for (let c = a + 1; c < b; c++) {
    const col = rows.map((r) => r[c] || '-');
    const joins = col.some((ch, s) => /[hpbrs\/\\]/i.test(ch) && /\d/.test(rows[s][c - 1] || '') && /\d/.test(rows[s][c + 1] || ''));
    if (joins && col.every((ch) => /[-hpbrs\/\\]/i.test(ch))) skip.add(c);
  }
  const slot = {};
  let n = 0;
  for (let c = a + 1; c < b; c++) if (!skip.has(c)) slot[c] = n++;
  return { slot, n };
}

// One bar timed by its slots: each slot an 8th (a 16th when the bar has more than 12).
function slotBar(inBar, slot, n) {
  const unit = n > 12 ? 16 : 8;
  const at = inBar.map((e) => slot[e.col]);
  const beats = [];
  if (at[0] > 0) durationsFor(at[0] / unit).forEach((d) => beats.push('r' + dur(d)));
  inBar.forEach((e, i) => {
    const next = i + 1 < at.length ? at[i + 1] : n;
    const [first, ...rest] = durationsFor((next - at[i]) / unit);
    beats.push(beatTex(e.notes, first));
    rest.forEach((d) => beats.push('r' + dur(d)));
  });
  // 8 eighths or 16 sixteenths is 4/4; 12 sixteenths is 6/8
  let ts = [n, unit];
  if (n === unit) ts = [4, 4];
  else if (unit === 16 && n % 2 === 0) ts = [n / 2, 8];
  return { ts, tex: beats.join(' ') };
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
    // strums written side by side ("000-00000000"): every strum is an 8th and the dashes between
    // them only separate groups, so the bar is as long as its strums (11 strums: 11/8). A long run
    // goes on into bars of 8.
    // (side by side on the same string: notes next to each other on different strings are just tight spacing)
    const close = inBar.filter((e, k) => k && e.col - inBar[k - 1].col === 1
      && e.notes.some((x) => inBar[k - 1].notes.some((y) => y.string === x.string))).length;
    if (inBar.length > 2 && close >= inBar.length / 2) {
      const n = inBar.length;
      const sizes = n <= 16 ? [n] : Array.from({ length: Math.ceil(n / 8) }, (_, k) => Math.min(8, n - 8 * k));
      let at = 0;
      for (const size of sizes) {
        out.push({ ts: [size, 8], tex: inBar.slice(at, at + size).map((e) => beatTex(e.notes, VALUES[6])).join(' ') });
        at += size;
      }
      continue;
    }
    if (!inBar.length) { out.push('r.1'); continue; }
    const { slot, n } = barSlots(sys, a, b, inBar);
    out.push(n <= 24 ? slotBar(inBar, slot, n) : barTex(inBar, a, b)); // a very long bar: spacing as a 16th grid
  }
  return out;
}

const quote = (s) => `"${String(s || '').replace(/["\\]/g, '')}"`;

/**
 * @returns {{ tex: string, bars: number, strings: number } | null} null when no tab lines are found.
 */
export function asciiTabToAlphaTex(text, { title = '', artist = '', tempo = null } = {}) {
  const systems = findSystems(text).map(parseSystem).filter((s) => s.events.length);
  if (!systems.length) return null;

  // Use the most common string count; skip systems that don't match (e.g. a bass part).
  const counts = {};
  systems.forEach((s) => { counts[s.count] = (counts[s.count] || 0) + 1; });
  const strings = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
  const used = systems.filter((s) => s.count === strings);
  const head = readHeader(text, strings, used[0].labels);
  let tuning = head.tuning || readTuning(used[0].labels, strings);
  // With a capo, the string names are often what sounds (capo 1 on standard: F C Ab Eb Bb F).
  // The guitar is then in the tuning a capo's worth lower, or the capo would count twice.
  const std = DEFAULT_TUNINGS[strings];
  if (head.capo && std) {
    const off = (t) => t.reduce((s, m, i) => s + pcGap(m % 12, std[i] % 12), 0);
    const down = tuning.map((m) => m - head.capo);
    if (off(down) < off(tuning)) tuning = down;
  }
  const bpm = Math.round(tempo || head.tempo || 100);

  // a bar of strums sets its own time signature; the bars after it go back to 4/4
  let ts = '4 4';
  const bars = used.flatMap(systemBars).map((b) => {
    const want = typeof b === 'string' ? '4 4' : b.ts.join(' ');
    const tex = typeof b === 'string' ? b : b.tex;
    const mark = want !== ts ? `\\ts ${want} ` : '';
    ts = want;
    return mark + tex;
  });
  const header = [
    `\\title ${quote(title)}`,
    artist ? `\\artist ${quote(artist)}` : '',
    `\\tempo ${bpm}`,
    '.',
    `\\track ${quote(title || 'Guitar')}`,
    `\\staff {score tabs}`,
    `\\tuning ${tuning.map(midiName).join(' ')}`,
    head.capo ? `\\capo ${head.capo}` : '',
    strings <= 5 ? '\\instrument 33' : '\\instrument 27',
  ].filter(Boolean).join('\n');
  return { tex: `${header}\n${bars.join(' |\n')}`, bars: bars.length, strings, tempo: bpm, capo: head.capo || 0 };
}
