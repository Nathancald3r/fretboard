// Natural guitar playback. alphaTab starts every note of a chord at the same instant and at the
// same loudness, which sounds like a keyboard. Here, before playback, each guitar chord in the
// MIDI is strummed: its strings sound a few milliseconds apart (low to high on a downstroke,
// high to low on an upstroke), upstrokes a little softer, the first beat of a bar a little
// stronger, and every note's loudness varies slightly, as a player's hand does.
// Only the sound changes: the score and the cursor keep their timing.

export const NOTE_ON = 128; // alphaTab's MidiEventType values
export const NOTE_OFF = 144;
export const PROGRAM = 192;
export const TEMPO = 81;
export const QUARTER = 960; // alphaTab's ticks per quarter note

const isGuitar = (program) => program >= 24 && program <= 31;
const DOWN_MS = 30; // a whole six-string downstroke; an upstroke is quicker (and usually fewer strings)
const UP_MS = 20;

// A small repeatable variation (-1..1) for a note, so a song sounds the same every time it plays.
const wobble = (tick, key) => {
  let h = (tick * 374761393 + key * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) % 2001) / 1000 - 1;
};

/**
 * @param events the MIDI file's events (alphaTab MidiEvent objects or the same shape), changed in place
 * @param barStarts ticks where bars start (for the accent on beat one); optional
 * @returns how many chords were strummed
 */
export function humanize(events, { barStarts = [] } = {}) {
  const tempos = events.filter((e) => e.type === TEMPO).sort((a, b) => a.tick - b.tick);
  const bpmAt = (tick) => {
    let bpm = 120;
    for (const t of tempos) { if (t.tick > tick) break; bpm = t.beatsPerMinute; }
    return bpm || 120;
  };
  const msToTicks = (ms, tick) => (ms * bpmAt(tick) * QUARTER) / 60000;
  const program = new Map(); // channel -> program (the first one set)
  for (const e of events) if (e.type === PROGRAM && !program.has(e.channel)) program.set(e.channel, e.program);
  const bars = new Set(barStarts);

  // each guitar note with where it ends
  const open = new Map();
  const notes = [];
  for (const e of [...events].sort((a, b) => a.tick - b.tick)) {
    if (!isGuitar(program.get(e.channel) ?? -1)) continue;
    const k = e.channel * 128 + e.noteKey;
    if (e.type === NOTE_ON && e.noteVelocity > 0) {
      const n = { on: e, end: Infinity };
      notes.push(n);
      (open.get(k) || open.set(k, []).get(k)).push(n);
    } else if (e.type === NOTE_OFF || (e.type === NOTE_ON && e.noteVelocity === 0)) {
      const n = open.get(k)?.shift();
      if (n) n.end = e.tick;
    }
  }

  const groups = new Map(); // notes struck together on a channel
  for (const n of notes) {
    const g = `${n.on.channel}:${n.on.tick}`;
    (groups.get(g) || groups.set(g, []).get(g)).push(n);
  }
  let strummed = 0;
  for (const g of groups.values()) {
    const tick = g[0].on.tick;
    const len = Math.min(...g.map((n) => n.end - tick));
    const accent = bars.has(tick) ? 6 : 0;
    if (g.length < 3) { // single notes and double stops: only the touch varies
      for (const n of g) n.on.noteVelocity = clampVel(n.on.noteVelocity + accent + 4 * wobble(tick, n.on.noteKey));
      continue;
    }
    // On the beat the hand comes down; between beats it comes back up (sixteenths: every other one).
    const slot = Math.round((tick % QUARTER) / (QUARTER / 4)) % 4;
    const up = slot === 1 || slot === 3 || (slot === 2 && len >= QUARTER / 2);
    const order = [...g].sort((a, b) => (up ? b.on.noteKey - a.on.noteKey : a.on.noteKey - b.on.noteKey));
    const total = Math.min(msToTicks((up ? UP_MS : DOWN_MS) * (order.length - 1) / 5, tick), 0.3 * len);
    const step = total / (order.length - 1);
    order.forEach((n, i) => {
      n.on.tick = Math.round(tick + i * step);
      // an upstroke catches the top strings more lightly; a downstroke digs into the low ones
      const shape = up ? -10 - 2 * i : 3 - i;
      n.on.noteVelocity = clampVel(n.on.noteVelocity + shape + accent + 3 * wobble(tick, n.on.noteKey));
    });
    strummed++;
  }
  return strummed;
}

const clampVel = (v) => Math.max(1, Math.min(127, Math.round(v)));

// Hi-hats and cymbals: alphaTab's drum kit plays them quieter than the drums around them, so
// they get lost under the kick and snare. Each hit on the drum channel is played louder.
// The open hi-hat is loud enough as it is.
const CYMBALS = new Set([42, 44, 49, 51, 52, 53, 55, 57, 59]);
export const DRUM_CHANNEL = 9;

/** Raises the loudness of hi-hat and cymbal hits in place; returns how many changed. */
export function liftCymbals(events, gain = 1.3, add = 10) {
  let n = 0;
  for (const e of events) {
    if (e.type !== NOTE_ON || e.channel !== DRUM_CHANNEL || !e.noteVelocity || !CYMBALS.has(e.noteKey)) continue;
    e.noteVelocity = clampVel(e.noteVelocity * gain + add);
    n++;
  }
  return n;
}
