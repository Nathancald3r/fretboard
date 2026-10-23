// Converts plain-text (ASCII) guitar tab into alphaTex so alphaTab can play it.
//
// ASCII tab has no rhythm, so timing comes from spacing: every placeholder between two bar lines
// (a dash, a note, a strum) is one 8th, or one 16th in tabs whose bars are mostly 14+ wide.
// Bars without bar lines fall back to straight eighth notes.

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
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  const lines = raw.map(cleanLine);
  const systems = [];
  let current = [];
  let tempo = 0; // a "Tempo: 98" line after the first system: the tempo from the next system on
  const flush = () => {
    if (current.length >= 4 && current.length <= 8) {
      if (tempo && systems.length) current.tempo = tempo;
      systems.push(current);
      tempo = 0;
    }
    current = [];
  };
  for (const [i, line] of lines.entries()) {
    const t = raw[i].match(/^\s*(?:tempo|bpm)\s*[:=]?\s*(\d{2,3})\b/i);
    if (!t && isTabLine(line)) { current.push(line.replace(/\s+$/, '')); continue; }
    flush();
    if (t && Number(t[1]) >= 30 && Number(t[1]) <= 300) tempo = Number(t[1]);
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
// or more digits is strums, and so is a pair when another string starts a note at c+1, or when
// another string has "0d" there (no fret starts with 0, so "-22-" beside "-00-" is two strums).
function single(rows, s, c) {
  const row = rows[s];
  if (!/\d/.test(row[c] || '') || !/\d/.test(row[c + 1] || '')) return false;
  if (/\d/.test(row[c + 2] || '') || /\d/.test(row[c - 1] || '')) return true;
  if (rows.some((r) => r[c] === '0' && /\d/.test(r[c + 1] || '') && !/\d/.test(r[c - 1] || ''))) return true;
  // "22" in a chord of 2s and 0s: no hand reaches fret 22 and fret 2 at once, so it's 2 and 2 again
  const two = Number(row[c] + row[c + 1]);
  const others = rows.filter((r, k) => k !== s && /\d/.test(r[c] || '') && !/\d/.test(r[c - 1] || '')).map((r) => Number(r[c])).filter((f) => f > 0);
  if (two >= 10 && others.length && Math.max(...others) <= two - 8) return true;
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
function barSlots(sys, a, b, inBar, unit = 0) {
  const { rows } = sys;
  // a bar exactly one (or two) 4/4 bars wide is drawn one column per slot, two-digit frets too
  // ("--8-10-8--------" is 16 sixteenths, not 15)
  if (unit && (b - a - 1) % unit === 0) {
    const slot = {};
    for (let c = a + 1; c < b; c++) slot[c] = c - a - 1;
    return { slot, n: b - a - 1 };
  }
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

// One bar timed by its slots, each slot one `unit` (8: an 8th, 16: a 16th). A bar much longer than
// 4/4 goes on into bars of 4/4.
function slotBars(inBar, slot, n, unit) {
  const at = inBar.map((e) => slot[e.col]);
  const sizes = n <= unit * 1.5 ? [n] : Array.from({ length: Math.ceil(n / unit) }, (_, k) => Math.min(unit, n - unit * k));
  const out = [];
  let from = 0;
  for (const size of sizes) {
    const to = from + size;
    const beats = [];
    const here = inBar.map((e, i) => i).filter((i) => at[i] >= from && at[i] < to);
    const first = here.length ? at[here[0]] : to;
    if (first > from) durationsFor((first - from) / unit).forEach((d) => beats.push('r' + dur(d)));
    here.forEach((i, k) => {
      const next = k + 1 < here.length ? at[here[k + 1]] : to;
      const [d, ...rest] = durationsFor((next - at[i]) / unit);
      beats.push(beatTex(inBar[i].notes, d));
      rest.forEach((x) => beats.push('r' + dur(x)));
    });
    // 8 eighths or 16 sixteenths is 4/4; 12 sixteenths is 6/8
    let ts = [size, unit];
    if (size === unit) ts = [4, 4];
    else if (unit === 16 && size % 2 === 0) ts = [size / 2, 8];
    out.push({ ts, tex: beats.join(' ') });
    from = to;
  }
  return out;
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

// The bars of a system: [start, end, events] for each.
function barsOf(sys) {
  const { bars, events, width } = sys;
  const edges = [...new Set([-1, ...bars, width])].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const [a, b] = [edges[i], edges[i + 1]];
    if (b - a < 3) continue; // "||" or a tiny edge piece
    out.push([a, b, events.filter((e) => e.col > a && e.col < b)]);
  }
  return out;
}

// What one placeholder is worth in this tab: an 8th, or a 16th when most bars are exactly 16
// wide (the common "|----------------|" tab drawn on a 16th grid).
function slotUnit(systems) {
  const widths = systems.flatMap((sys) => barsOf(sys).filter(([, , ev]) => ev.length).map(([a, b, ev]) => (b - a - 1 === 16 ? 16 : barSlots(sys, a, b, ev).n)));
  return widths.length && widths.filter((n) => n === 16).length >= widths.length * 0.6 ? 16 : 8;
}

function systemBars(sys, unit = 8) {
  const { bars, events, width } = sys;
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
  // Every placeholder (a dash, a note, a strum) is one slot, strums side by side ("2-22-222") too.
  for (const [a, b, inBar] of barsOf(sys)) {
    if (!inBar.length) { // an empty bar: as many bars of rest as it is wide (a 16-wide bar of 8ths is two)
      const n = b - a - 1;
      for (let k = n > unit * 1.5 ? Math.round(n / unit) : 1; k > 0; k--) out.push('r.1');
      continue;
    }
    const { slot, n } = barSlots(sys, a, b, inBar, unit);
    out.push(...slotBars(inBar, slot, n, unit));
  }
  return out;
}

const quote = (s) => `"${String(s || '').replace(/["\\]/g, '')}"`;

// Reads one text tab: its bars (alphaTex, with \ts marks where the time signature changes),
// tuning, capo and tempo. null when no tab lines are found.
function readTab(text, tempo = null, forceUnit = 0) {
  const systems = findSystems(text).map((l) => Object.assign(parseSystem(l), { tempo: l.tempo || 0 })).filter((s) => s.events.length);
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
  const unit = forceUnit || slotUnit(used);
  const bars = used.flatMap((s) => systemBars(s, unit).map((b, i) => {
    const bar = typeof b === 'string' ? { ts: [4, 4], tex: b } : b;
    return i === 0 && s.tempo ? { ...bar, tempo: s.tempo } : bar; // "Tempo: 98" above a system changes the tempo there
  }));
  return { bars, strings, tuning, capo: head.capo || 0, tempo: tempo || head.tempo || null };
}

// One track's lines: its staff, tuning, sound, then its bars (a \ts mark where the time signature changes).
// Time signatures and tempo changes are song-wide, so only the first track writes them.
function trackTex(name, tab, count = tab.bars.length, tempos = true) {
  let ts = '4 4';
  const bars = Array.from({ length: count }, (_, i) => tab.bars[i] || { ts: [4, 4], tex: 'r.1' }).map((b) => {
    const want = b.ts.join(' ');
    const mark = (tempos && want !== ts ?`\\ts ${want} ` : '') + (tempos && b.tempo ? `\\tempo ${b.tempo} ` : '');
    ts = want;
    return mark + b.tex;
  });
  return [
    `\\track ${quote(name)}`,
    `\\staff {score tabs}`,
    `\\tuning ${tab.tuning.map(midiName).join(' ')}`,
    tab.capo ? `\\capo ${tab.capo}` : '',
    // a picked bass: each note starts with a clear attack, so quick repeated notes stay apart
    tab.strings <= 5 ? '\\instrument 34' : '\\instrument 27',
    bars.join(' |\n'),
  ].filter(Boolean).join('\n');
}

const headerTex = (title, artist, bpm) =>
  [`\\title ${quote(title)}`, artist ? `\\artist ${quote(artist)}` : '', `\\tempo ${bpm}`, '.'].filter(Boolean).join('\n');

/**
 * @returns {{ tex: string, bars: number, strings: number } | null} null when no tab lines are found.
 */
export function asciiTabToAlphaTex(text, { title = '', artist = '', tempo = null } = {}) {
  const tab = readTab(text, tempo);
  if (!tab) return null;
  const bpm = Math.round(tab.tempo || 100);
  const header = headerTex(title, artist, bpm);
  return { tex: `${header}\n${trackTex(title || 'Guitar', tab)}`, bars: tab.bars.length, strings: tab.strings, tempo: bpm, capo: tab.capo };
}

/**
 * Several text tabs of one song (a guitar tab and its bass tab) as one score, a track each.
 * The first tab sets the length: the others are cut or padded with rests to its bar count.
 * The tempo is the one given, else the first tab's that has one.
 * @param {{ name: string, text: string }[]} parts
 */
export function asciiTabsToAlphaTex(parts, { title = '', artist = '', tempo = null } = {}) {
  const first = parts.length && readTab(parts[0].text);
  if (!first) return null;
  const count = first.bars.length;
  // Each other tab is read on the grid (8ths or 16ths) that gives it the first tab's length: a bass tab
  // drawn in 16-wide bars can be one bar each, or two bars of the guitar's 8ths.
  const fit = (text) => [8, 16].map((u) => readTab(text, null, u)).filter(Boolean)
    .sort((a, b) => Math.abs(a.bars.length - count) - Math.abs(b.bars.length - count))[0];
  const tabs = [{ name: parts[0].name, tab: first }, ...parts.slice(1).map((p) => ({ name: p.name, tab: fit(p.text) })).filter((p) => p.tab)];
  const bpm = Math.round(tempo || tabs.find((p) => p.tab.tempo)?.tab.tempo || 100);
  const tracks = tabs.map((p, i) => trackTex(p.name, p.tab, count, i === 0));
  return { tex: `${headerTex(title, artist, bpm)}\n${tracks.join('\n')}`, bars: count, strings: tabs[0].tab.strings, tempo: bpm, capo: tabs[0].tab.capo, tracks: tabs.length };
}
