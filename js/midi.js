// Reads a MIDI file (.mid) and writes it out as MusicXML, which alphaTab then loads like any other
// MusicXML song. MIDI has only key presses in time, so the notes are snapped to a grid (16ths, 32nds
// or triplets, whichever fits the file best), cut into bars by its time signatures and split into
// voices where notes overlap. Guitar and bass tracks get strings and frets, so they show as tab;
// drums (channel 10) become a drum track; a piano track wide enough for two hands gets two staves.

const U = 24; // MusicXML divisions: units in a quarter note (24 holds 32nds and triplets)

const GM = ['Acoustic Grand Piano', 'Bright Piano', 'Electric Grand Piano', 'Honky-tonk Piano', 'Electric Piano', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Nylon Guitar', 'Acoustic Guitar', 'Jazz Guitar', 'Clean Electric Guitar', 'Muted Guitar', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Bass', 'Bass (pick)', 'Fretless Bass', 'Slap Bass', 'Slap Bass 2', 'Synth Bass', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Harp', 'Timpani',
  'Strings', 'Slow Strings', 'Synth Strings', 'Synth Strings 2', 'Choir', 'Voice', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass', 'Synth Brass', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Square Lead', 'Saw Lead', 'Calliope Lead', 'Chiff Lead', 'Charang Lead', 'Voice Lead', 'Fifths Lead', 'Bass Lead',
  'New Age Pad', 'Warm Pad', 'Polysynth Pad', 'Choir Pad', 'Bowed Pad', 'Metallic Pad', 'Halo Pad', 'Sweep Pad',
  'Rain', 'Soundtrack', 'Crystal', 'Atmosphere', 'Brightness', 'Goblins', 'Echoes', 'Sci-fi',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone', 'Helicopter', 'Applause', 'Gunshot'];

// ---- reading the file ----

// { division, tracks: [{ name, channel, program, notes: [{ tick, end, key, vel }] }], tempos, times, keys, title, artist }
export function readMidi(buf) {
  const b = new Uint8Array(buf);
  let i = 0;
  const u32 = () => { const v = (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0; i += 4; return v; };
  const u16 = () => { const v = b[i] << 8 | b[i + 1]; i += 2; return v; };
  const tag = () => { const s = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]); i += 4; return s; };
  // a RIFF MIDI (.rmi) holds a plain one in its "data" chunk
  if (String.fromCharCode(...b.subarray(0, 4)) === 'RIFF') {
    const at = indexOf(b, 'MThd');
    if (at < 0) throw new Error('Not a MIDI file');
    i = at;
  }
  if (tag() !== 'MThd') throw new Error('Not a MIDI file');
  const hlen = u32();
  const format = u16(), count = u16(), division = u16();
  i += hlen - 6;
  if (division & 0x8000) throw new Error('This MIDI file counts time in SMPTE frames, which isn’t supported');
  const text = (s, e) => new TextDecoder('latin1').decode(b.subarray(s, e)).replace(/\0/g, '').trim();
  const tempos = [], times = [], keys = [], texts = [];
  const tracks = [];
  for (let t = 0; t < count && i + 8 <= b.length; t++) {
    const id = tag(), len = u32(), end = Math.min(b.length, i + len);
    if (id !== 'MTrk') { i = end; continue; }
    let tick = 0, status = 0, name = '', instrument = '';
    const byCh = new Map(); // channel → { program, notes, open }
    const ch = (c) => { if (!byCh.has(c)) byCh.set(c, { program: -1, notes: [], open: new Map() }); return byCh.get(c); };
    const vlq = () => { let v = 0, x; do { x = b[i++]; v = v * 128 + (x & 127); } while (x & 128 && i < end); return v; };
    while (i < end) {
      tick += vlq();
      let s = b[i];
      if (s & 0x80) { i++; if (s < 0xf0) status = s; } else s = status; // running status
      if (s === 0xff) {
        const type = b[i++], l = vlq(), at = i;
        i += l;
        if (type === 0x51 && l >= 3) tempos.push({ tick, bpm: 60e6 / (b[at] << 16 | b[at + 1] << 8 | b[at + 2]) });
        else if (type === 0x58 && l >= 2) times.push({ tick, num: b[at], den: 2 ** b[at + 1] });
        else if (type === 0x59 && l >= 2) keys.push({ tick, fifths: (b[at] << 24) >> 24, minor: b[at + 1] === 1 });
        else if (type === 0x03 && !name) name = text(at, at + l);
        else if (type === 0x04 && !instrument) instrument = text(at, at + l);
        else if (type === 0x01 || type === 0x02) texts.push({ track: t, text: text(at, at + l) });
        else if (type === 0x2f) break;
        continue;
      }
      if (s === 0xf0 || s === 0xf7) { const l = vlq(); i += l; continue; }
      const kind = s >> 4, c = s & 15;
      if (kind === 0xc) { const x = ch(c); if (x.program < 0 || !x.notes.length) x.program = b[i]; i += 1; continue; }
      if (kind === 0xd) { i += 1; continue; }
      const k = b[i], v = b[i + 1];
      i += 2;
      if (kind !== 8 && kind !== 9) continue;
      const x = ch(c);
      const stack = x.open.get(k);
      if (kind === 9 && v > 0) { // note on (a second press of a held key ends the first)
        if (stack?.length) for (const n of stack.splice(0)) n.end = tick;
        const n = { tick, end: -1, key: k, vel: v };
        x.notes.push(n);
        x.open.set(k, [n]);
      } else if (stack?.length) stack.shift().end = tick; // note off
    }
    i = end;
    for (const [c, x] of byCh) {
      for (const n of x.notes) if (n.end < 0) n.end = tick;
      const notes = x.notes.filter((n) => n.end > n.tick);
      if (notes.length) tracks.push({ name: name || instrument, trackIndex: t, channel: c, program: Math.max(0, x.program), notes });
    }
    if (t === 0 && name) texts.unshift({ track: t, title: name });
  }
  if (!tracks.length) throw new Error('No notes in this MIDI file');
  // format 1: the first track usually has only the song's name, tempo and time signature
  const firstHasNotes = tracks.some((x) => x.trackIndex === 0);
  const title = (format === 1 && !firstHasNotes) || format === 0 ? texts.find((x) => x.title)?.title || '' : '';
  const by = texts.find((x) => x.text && /^(by|music by|composer:?)\s+/i.test(x.text));
  const artist = by ? by.text.replace(/^(by|music by|composer:?)\s+/i, '').replace(/,?\s*\(?\d{4}\)?\.?$/, '').trim() : '';
  // a track whose name is just the song's name (format 0) is named by its instrument instead
  for (const x of tracks) if (x.name && x.name === title && format === 0) x.name = '';
  return { format, division, tracks, tempos, times, keys, title, artist };
}

function indexOf(b, s) {
  outer: for (let i = 0; i + s.length <= b.length; i++) {
    for (let j = 0; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

// ---- the grid ----

// The grid step (in units of U per quarter) that fits the note starts best: 16ths unless 32nds or
// triplets fit clearly better. A file from a notation program fits one exactly.
export function pickStep(midi) {
  const at = [];
  for (const t of midi.tracks) for (const n of t.notes) at.push(n.tick * U / midi.division);
  const err = (step) => at.reduce((e, x) => e + Math.abs(x - Math.round(x / step) * step), 0) / at.length;
  const e16 = err(6);
  if (e16 < 0.05) return 6;
  let best = 6, bestErr = e16;
  for (const step of [8, 4, 3]) { // eighth triplets, sixteenth triplets, 32nds
    const e = err(step);
    if (e < bestErr * 0.5 && e < bestErr - 0.3) { best = step; bestErr = e; }
  }
  return best;
}

// ---- durations ----

// [units, type, dots, triplet]
const DUR = [[96, 'whole', 0], [72, 'half', 1], [48, 'half', 0], [36, 'quarter', 1], [32, 'half', 0, 1], [24, 'quarter', 0], [18, 'eighth', 1], [16, 'quarter', 0, 1],
  [12, 'eighth', 0], [9, '16th', 1], [8, 'eighth', 0, 1], [6, '16th', 0], [4, '16th', 0, 1], [3, '32nd', 0], [2, '32nd', 0, 1], [1, '64th', 0, 1]];

// Cuts a length into note values that add up to it, longest first.
function pieces(len) {
  const out = [];
  while (len > 0) {
    const d = DUR.find((x) => x[0] <= len) || DUR[DUR.length - 1];
    out.push(d);
    len -= d[0];
  }
  return out;
}

// ---- strings and frets ----

const GUITAR = [40, 45, 50, 55, 59, 64];
const BASS4 = [28, 33, 38, 43];
const BASS5 = [23, 28, 33, 38, 43];
const MAX_FRET = 24;

// For one chord: { key: string index (0 = lowest) }, near the last hand position and off the strings still ringing.
function fingerChord(keys, tuning, state) {
  const sorted = [...keys].sort((a, b) => b - a);
  let best = null;
  const pick = new Array(sorted.length).fill(-1);
  const used = new Set();
  const walk = (j, cost) => {
    if (best && cost >= best.cost) return;
    if (j === sorted.length) {
      const frets = pick.map((s, q) => (s < 0 ? -1 : sorted[q] - tuning[s])).filter((f) => f > 0);
      const lo = Math.min(...frets), hi = Math.max(...frets);
      let c = cost;
      if (frets.length) {
        c += Math.max(0, hi - lo - 3) * 4 + (hi - lo);
        c += Math.abs((lo + hi) / 2 - state.pos) * 0.4 + lo * 0.05;
      }
      if (!best || c < best.cost) best = { cost: c, pick: [...pick] };
      return;
    }
    for (let s = tuning.length - 1; s >= 0; s--) {
      const f = sorted[j] - tuning[s];
      if (f < 0 || f > MAX_FRET || used.has(s)) continue;
      used.add(s); pick[j] = s;
      walk(j + 1, cost + (state.busy[s] ? 6 : 0));
      used.delete(s); pick[j] = -1;
    }
    walk(j + 1, cost + 40); // leave this note out
  };
  walk(0, 0);
  const out = new Map();
  if (!best) return out;
  best.pick.forEach((s, q) => { if (s >= 0) out.set(sorted[q], s); });
  const frets = [...out].map(([k, s]) => k - tuning[s]).filter((f) => f > 0);
  if (frets.length) state.pos = (Math.min(...frets) + Math.max(...frets)) / 2;
  return out;
}

// Brings a key into the instrument's range by octaves.
function inRange(key, tuning) {
  while (key < tuning[0]) key += 12;
  while (key > tuning[tuning.length - 1] + MAX_FRET) key -= 12;
  return key;
}

// ---- drums ----

// Where each drum sits on the staff (display step and octave), as Guitar Pro and MuseScore draw them.
const DRUM_AT = { 35: 'E4', 36: 'F4', 37: 'C5', 38: 'C5', 39: 'C5', 40: 'C5', 41: 'A4', 42: 'G5', 43: 'A4', 44: 'D4', 45: 'B4', 46: 'G5', 47: 'D5', 48: 'E5',
  49: 'A5', 50: 'F5', 51: 'F5', 52: 'A5', 53: 'F5', 54: 'E5', 55: 'B5', 56: 'D5', 57: 'A5', 59: 'F5' };
const DRUM_NAME = { 35: 'Kick', 36: 'Kick', 37: 'Side stick', 38: 'Snare', 39: 'Clap', 40: 'Snare', 41: 'Low floor tom', 42: 'Hi-hat closed', 43: 'High floor tom', 44: 'Hi-hat pedal',
  45: 'Low tom', 46: 'Hi-hat open', 47: 'Low-mid tom', 48: 'High-mid tom', 49: 'Crash', 50: 'High tom', 51: 'Ride', 52: 'China', 53: 'Ride bell', 54: 'Tambourine',
  55: 'Splash', 56: 'Cowbell', 57: 'Crash 2', 59: 'Ride 2', 69: 'Cabasa', 70: 'Maracas' };

// ---- writing MusicXML ----

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SHARP = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
const FLAT = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];
const DYN = [[24, 'ppp'], [40, 'pp'], [56, 'p'], [72, 'mp'], [88, 'mf'], [104, 'f'], [120, 'ff'], [128, 'fff']];
const dynOf = (vel) => DYN.find(([v]) => vel < v)?.[1] || 'fff';

// Puts the notes of one staff into voices: notes that start and end together share a chord, a
// note that overlaps one still sounding goes into the next free voice (at most four).
function voicesOf(notes) {
  const groups = new Map();
  for (const n of notes) {
    const k = n.s + ':' + n.e;
    if (!groups.has(k)) groups.set(k, { s: n.s, e: n.e, notes: [] });
    const g = groups.get(k);
    if (!g.notes.some((x) => x.key === n.key)) g.notes.push(n);
  }
  const list = [...groups.values()].sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
  const voices = [];
  for (const g of list) {
    let v = voices.find((x) => x.end <= g.s);
    if (!v && voices.length < 4) { v = { end: 0, events: [] }; voices.push(v); }
    if (!v) { // every voice is busy: cut the one that frees up first short at this note
      v = voices.reduce((a, b) => (a.end <= b.end ? a : b));
      const last = v.events[v.events.length - 1];
      if (last.s === g.s) { last.notes.push(...g.notes.filter((n) => !last.notes.some((x) => x.key === n.key))); last.e = Math.min(last.e, g.e); v.end = last.e; continue; }
      last.e = g.s;
    }
    v.events.push(g);
    v.end = g.e;
  }
  return voices.length ? voices : [{ end: 0, events: [] }];
}

// midi → { xml, title, artist, bars, tracks: [names] }
export function midiToMusicXml(buf, opts = {}) {
  const midi = readMidi(buf);
  const step = pickStep(midi);
  const unit = (tick) => tick * U / midi.division;
  const snap = (tick) => Math.round(unit(tick) / step) * step;

  // bars from the time signatures
  const times = [...midi.times].sort((a, b) => a.tick - b.tick);
  if (!times.length || times[0].tick > 0) times.unshift({ tick: 0, num: 4, den: 4 });
  let last = 0;
  for (const t of midi.tracks) for (const n of t.notes) last = Math.max(last, snap(n.end), snap(n.tick) + step);
  const bars = []; // { s, len, num, den }
  let at = 0, ti = 0;
  while (at < last || !bars.length) {
    while (ti + 1 < times.length && Math.round(unit(times[ti + 1].tick)) <= at) ti++;
    const { num, den } = times[ti];
    const len = Math.max(1, Math.round(num * U * 4 / den));
    bars.push({ s: at, len, num, den });
    at += len;
  }
  const barAt = (u) => { let k = 0; while (k + 1 < bars.length && bars[k + 1].s <= u) k++; return k; };

  const tempos = [...midi.tempos].sort((a, b) => a.tick - b.tick).map((t) => ({ u: snap(t.tick), bpm: Math.round(t.bpm * 100) / 100 }));
  if (!tempos.length || tempos[0].u > 0) tempos.unshift({ u: 0, bpm: tempos[0]?.u === 0 ? tempos[0].bpm : 120 });
  const keys = [...midi.keys].sort((a, b) => a.tick - b.tick).map((k) => ({ bar: barAt(snap(k.tick)), fifths: Math.max(-7, Math.min(7, k.fifths)), minor: k.minor }));
  const keyAt = (bar) => { let k = keys.length ? keys[0] : { fifths: 0, minor: false }; for (const x of keys) if (x.bar <= bar) k = x; return k; };

  // the parts
  const used = new Map();
  const parts = midi.tracks.map((t, pi) => {
    const drums = t.channel === 9;
    const guitar = !drums && t.program >= 24 && t.program <= 31;
    const bass = !drums && t.program >= 32 && t.program <= 39;
    let name = t.name || (drums ? 'Drums' : GM[t.program]);
    used.set(name, (used.get(name) || 0) + 1);
    if (used.get(name) > 1) name += ' ' + used.get(name);
    // A note let go a little before the next one starts (notation programs play a half note for
    // 7/8 of its length) is written up to that next note, not as a note and a tiny rest.
    const onsets = [...new Set(t.notes.map((n) => n.tick))].sort((a, b) => a - b);
    const notes = t.notes.map((n) => {
      let lo = 0, hi = onsets.length; // the first start after this one
      while (lo < hi) { const m = (lo + hi) >> 1; if (onsets[m] > n.tick) hi = m; else lo = m + 1; }
      const next = onsets[lo];
      const end = next !== undefined && n.end < next && next - n.end <= (next - n.tick) * 0.2 ? next : n.end;
      const s = snap(n.tick);
      return { s, e: Math.max(s + step, snap(end)), key: n.key, vel: n.vel };
    });
    let tuning = null;
    if (guitar) tuning = GUITAR;
    if (bass) tuning = notes.some((n) => n.key < 28) ? BASS5 : BASS4;
    if (tuning) for (const n of notes) n.key = inRange(n.key, tuning);
    // a piano with both hands on one track: two staves, split at middle C
    const lowShare = notes.filter((n) => n.key < 60).length / notes.length;
    const grand = !drums && !tuning && t.program <= 7 && lowShare > 0.15 && lowShare < 0.85;
    const staves = grand ? [notes.filter((n) => n.key >= 60), notes.filter((n) => n.key < 60)] : [notes];
    const keysSorted = notes.map((n) => n.key).sort((a, b) => a - b);
    const median = keysSorted[keysSorted.length >> 1];
    const clefs = drums ? ['percussion'] : tuning ? ['TAB'] : grand ? ['G', 'F'] : [median < 57 ? 'F' : 'G'];
    return { id: 'P' + (pi + 1), t, name, drums, tuning, staves: staves.map(voicesOf), clefs, notes };
  });

  // strings and frets for guitar and bass, in time order across voices
  for (const p of parts) {
    if (!p.tuning) continue;
    const events = p.staves[0].flatMap((v) => v.events).sort((a, b) => a.s - b.s);
    const state = { pos: 3, busy: new Array(p.tuning.length).fill(false) };
    const ringing = [];
    for (const ev of events) {
      for (let s = 0; s < p.tuning.length; s++) state.busy[s] = ringing.some((r) => r.string === s && r.e > ev.s);
      const map = fingerChord(ev.notes.map((n) => n.key), p.tuning, state);
      ev.notes = ev.notes.filter((n) => map.has(n.key));
      for (const n of ev.notes) { n.string = map.get(n.key); ringing.push({ string: n.string, e: ev.e }); }
    }
    for (const v of p.staves[0]) v.events = v.events.filter((ev) => ev.notes.length);
  }

  const out = [];
  const w = (s) => out.push(s);
  w('<?xml version="1.0" encoding="UTF-8"?>');
  w('<score-partwise version="3.1">');
  const title = (opts.title || midi.title || '').trim();
  if (title) w(`<work><work-title>${esc(title)}</work-title></work>`);
  if (midi.artist) w(`<identification><creator type="composer">${esc(midi.artist)}</creator></identification>`);
  w('<part-list>');
  for (const p of parts) {
    w(`<score-part id="${p.id}"><part-name>${esc(p.name)}</part-name>`);
    if (p.drums) {
      const ks = [...new Set(p.notes.map((n) => n.key))].sort((a, b) => a - b);
      for (const k of ks) w(`<score-instrument id="${p.id}-I${k}"><instrument-name>${esc(DRUM_NAME[k] || 'Drum ' + k)}</instrument-name></score-instrument>`);
      for (const k of ks) w(`<midi-instrument id="${p.id}-I${k}"><midi-channel>10</midi-channel><midi-unpitched>${k + 1}</midi-unpitched></midi-instrument>`);
    } else {
      w(`<score-instrument id="${p.id}-I1"><instrument-name>${esc(GM[p.t.program])}</instrument-name></score-instrument>`);
      w(`<midi-instrument id="${p.id}-I1"><midi-channel>${p.t.channel + 1}</midi-channel><midi-program>${p.t.program + 1}</midi-program></midi-instrument>`);
    }
    w('</score-part>');
  }
  w('</part-list>');

  const spell = (key, fifths) => { const [st, alt] = (fifths < 0 ? FLAT : SHARP)[key % 12]; return { st, alt, oct: Math.floor(key / 12) - 1 }; };
  for (const p of parts) {
    w(`<part id="${p.id}">`);
    let dyn = 'f';
    let lastTime = '';
    for (let bi = 0; bi < bars.length; bi++) {
      const bar = bars[bi], bEnd = bar.s + bar.len;
      w(`<measure number="${bi + 1}">`);
      const key = keyAt(bi);
      const time = bar.num + '/' + bar.den;
      const keyChanged = bi > 0 && keys.some((k) => k.bar === bi && bi > 0);
      if (bi === 0 || time !== lastTime || keyChanged) {
        w('<attributes>');
        if (bi === 0) w(`<divisions>${U}</divisions>`);
        if (!p.drums && (bi === 0 || keyChanged)) w(`<key><fifths>${key.fifths}</fifths><mode>${key.minor ? 'minor' : 'major'}</mode></key>`);
        if (bi === 0 || time !== lastTime) w(`<time><beats>${bar.num}</beats><beat-type>${bar.den}</beat-type></time>`);
        if (bi === 0) {
          if (p.staves.length > 1) w(`<staves>${p.staves.length}</staves>`);
          p.clefs.forEach((c, si) => {
            const n = p.staves.length > 1 ? ` number="${si + 1}"` : '';
            w(c === 'TAB' ? `<clef${n}><sign>TAB</sign><line>5</line></clef>` : c === 'percussion' ? `<clef${n}><sign>percussion</sign></clef>` : `<clef${n}><sign>${c}</sign><line>${c === 'F' ? 4 : 2}</line></clef>`);
          });
          if (p.tuning) {
            w(`<staff-details><staff-lines>${p.tuning.length}</staff-lines>`);
            p.tuning.forEach((k, s) => { const { st, alt, oct } = spell(k, 0); w(`<staff-tuning line="${s + 1}"><tuning-step>${st}</tuning-step>${alt ? `<tuning-alter>${alt}</tuning-alter>` : ''}<tuning-octave>${oct}</tuning-octave></staff-tuning>`); });
            w('</staff-details>');
          }
        }
        w('</attributes>');
        lastTime = time;
      }
      // the bar's loudness, from its notes
      const here = p.notes.filter((n) => n.s >= bar.s && n.s < bEnd);
      if (here.length) {
        const d = dynOf(here.reduce((a, n) => a + n.vel, 0) / here.length);
        if (d !== dyn) { w(`<direction placement="below"><direction-type><dynamics><${d}/></dynamics></direction-type></direction>`); dyn = d; }
      }
      let first = true, voiceNo = 0;
      p.staves.forEach((voices, si) => {
        voices.forEach((v, vi) => {
          voiceNo = si * 4 + vi + 1;
          const evs = v.events.filter((ev) => ev.e > bar.s && ev.s < bEnd);
          const lead = vi === 0; // each staff's first voice fills its bar, rests and all
          if (!evs.length && !lead) return;
          if (!first) w(`<backup><duration>${bar.len}</duration></backup>`);
          first = false;
          const staffTag = p.staves.length > 1 ? `<staff>${si + 1}</staff>` : '';
          let pos = bar.s;
          const tempo = (to) => { // tempo marks up to this point, in the first voice
            if (!(si === 0 && vi === 0)) return;
            for (const t of tempos) if (!t.done && t.u < to) {
              t.done = true;
              w(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(t.bpm)}</per-minute></metronome></direction-type><sound tempo="${t.bpm}"/></direction>`);
            }
          };
          const rest = (len) => {
            for (const [d, type, dots, trip] of pieces(len)) {
              tempo(pos + d);
              w(`<note><rest/><duration>${d}</duration><voice>${voiceNo}</voice><type>${type}</type>${'<dot/>'.repeat(dots)}${trip ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : ''}${staffTag}</note>`);
              pos += d;
            }
          };
          for (const ev of evs) {
            const s = Math.max(ev.s, bar.s), e = Math.min(ev.e, bEnd);
            if (s > pos) rest(s - pos);
            if (s < pos) continue; // overlaps the event before it (cut short elsewhere)
            const segs = pieces(e - s);
            segs.forEach(([d, type, dots, trip], qi) => {
              tempo(pos + d);
              const tieStart = qi < segs.length - 1 || ev.e > bEnd;
              const tieStop = qi > 0 || ev.s < bar.s;
              ev.notes.forEach((n, ni) => {
                let body = ni ? '<chord/>' : '';
                if (p.drums) {
                  const [, st, oc] = (DRUM_AT[n.key] || 'E4').match(/(.)(\d)/);
                  body += `<unpitched><display-step>${st}</display-step><display-octave>${oc}</display-octave></unpitched>`;
                } else {
                  const { st, alt, oct } = spell(n.key, key.fifths);
                  body += `<pitch><step>${st}</step>${alt ? `<alter>${alt}</alter>` : ''}<octave>${oct}</octave></pitch>`;
                }
                body += `<duration>${d}</duration>`;
                if (tieStop) body += '<tie type="stop"/>';
                if (tieStart) body += '<tie type="start"/>';
                if (p.drums) body += `<instrument id="${p.id}-I${n.key}"/>`;
                body += `<voice>${voiceNo}</voice><type>${type}</type>${'<dot/>'.repeat(dots)}`;
                if (trip) body += '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
                if (p.drums && /^(42|44|46|49|51|52|53|55|57|59)$/.test(n.key)) body += '<notehead>x</notehead>';
                body += staffTag;
                const nots = [];
                if (tieStop) nots.push('<tied type="stop"/>');
                if (tieStart) nots.push('<tied type="start"/>');
                if (p.tuning) nots.push(`<technical><string>${p.tuning.length - n.string}</string><fret>${n.key - p.tuning[n.string]}</fret></technical>`);
                if (nots.length) body += `<notations>${nots.join('')}</notations>`;
                w(`<note>${body}</note>`);
              });
              pos += d;
            });
          }
          if (pos < bEnd) rest(bEnd - pos);
        });
      });
      if (bi === bars.length - 1) w('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
      w('</measure>');
    }
    w('</part>');
    for (const t of tempos) delete t.done;
  }
  w('</score-partwise>');
  return { xml: out.join('\n'), title, artist: midi.artist, bars: bars.length, tracks: parts.map((p) => p.name), step };
}
