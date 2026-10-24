// The page side of the YouTube → GP5 quality test (driven by run.py in headless Chromium).
//  renderSong: a Guitar Pro file whose content is known → one audio file per track (alphaTab's synth with
//    Fretboard's soundfont, each track solo) for the busiest stretch of the song, plus the true notes,
//    bar lines, tempo and key of that stretch
//  checkGp5: the notebook's .gp5 loaded the way Fretboard loads it, with every bar checked
import { ownDrumChannels } from '../../js/humanize.js';

const at = window.alphaTab;
const VENDOR = new URL('../../vendor/alphatab/', import.meta.url).href;
let api = null;

async function getApi() {
  if (api) return api;
  const el = document.createElement('div');
  document.body.appendChild(el);
  api = new at.AlphaTabApi(el, {
    core: { fontDirectory: VENDOR + 'font/', scriptFile: VENDOR + 'alphaTab.js', enableLazyLoading: true },
    display: { layoutMode: at.LayoutMode.Horizontal },
    player: { playerMode: at.PlayerMode.EnabledSynthesizer, soundFont: new URL('../../vendor/soundfont/MuseScore_General.sf3', import.meta.url).href },
  });
  await new Promise((resolve, reject) => {
    api.soundFontLoaded.on(resolve);
    api.error.on((e) => reject(new Error(String(e?.message || e))));
  });
  return api;
}

// Which Demucs stem a track belongs in.
function category(t) {
  const n = (t.name || '').toLowerCase();
  const prog = t.playbackInfo.program;
  if (t.staves.some((s) => s.isPercussion)) return 'drums';
  if (/vocal|voice|vox|sing|choir|lead vo/.test(n) || [52, 53, 54, 85].includes(prog)) return 'vocals';
  if ((/bass/.test(n) && !/drum/.test(n)) || (prog >= 32 && prog <= 39)) return 'bass';
  if (/guit|gtr|acoustic|electric|dist|overdrive|banjo|mandolin|ukulele/.test(n) || (prog >= 24 && prog <= 31)) return 'guitar';
  if (/piano|keys|rhodes|wurli/.test(n) || prog <= 7) return 'piano';
  return 'other';
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ticks → seconds through the song's tempo changes
function clock(midi) {
  const tempos = midi.events.filter((e) => e instanceof at.midi.TempoChangeEvent).sort((a, b) => a.tick - b.tick);
  const segs = [];
  let t = 0, tick = 0, bpm = tempos.length && tempos[0].tick === 0 ? tempos[0].beatsPerMinute : 120;
  for (const e of tempos) {
    t += (e.tick - tick) / midi.division * 60 / bpm;
    tick = e.tick;
    bpm = e.beatsPerMinute;
    segs.push({ tick, t, bpm });
  }
  if (!segs.length || segs[0].tick > 0) segs.unshift({ tick: 0, t: 0, bpm: 120 });
  const at_ = (k) => {
    let s = segs[0];
    for (const x of segs) if (x.tick <= k) s = x; else break;
    return s;
  };
  return { seconds: (k) => { const s = at_(k); return s.t + (k - s.tick) / midi.division * 60 / s.bpm; }, bpmAt: (k) => at_(k).bpm };
}

//  whole: the whole song as one mix (all tracks together), for scoring a real recording of it
window.renderSong = async (b64, { seconds = 45, start = null, saveTo, whole = false }) => {
  const a = await getApi();
  const score = at.importer.ScoreLoader.loadScoreFromBytes(b64ToBytes(b64), a.settings);
  for (const t of score.tracks) { t.playbackInfo.isMute = false; t.playbackInfo.isSolo = false; }
  ownDrumChannels(score.tracks); // as Fretboard's player does, so a second percussion track sounds
  a.renderScore(score, [0]);
  console.log('[yt2gp5] score loaded: ' + score.title);

  const { notes, bars, tracks } = played(a, score, false);
  const songEnd = Math.max(0, ...notes.map((n) => n.end));

  if (whole) { start = 0; seconds = Math.ceil(songEnd) + 2; }
  // the busiest stretch: most instrument kinds playing, then most guitar and bass notes
  if (start === null) {
    let best = -1;
    start = 0;
    for (let s = 0; s + seconds <= songEnd + 0.01 || s === 0; s += 1) {
      const inside = notes.filter((n) => n.start >= s && n.start < s + seconds && n.track >= 0);
      const kinds = new Set(inside.map((n) => tracks[n.track].category)).size;
      const fretted = inside.filter((n) => ['guitar', 'bass'].includes(tracks[n.track].category)).length;
      const v = kinds * 1e5 + fretted;
      if (v > best) { best = v; start = s; }
      if (s + seconds > songEnd) break;
    }
  }
  const end = start + seconds;
  console.log(`[yt2gp5] ${tracks.length} tracks, ${notes.length} notes, window ${start}-${end} s`);

  // each track solo, saved as raw stereo float32 for run.py
  const rate = 44100;
  const first = Math.floor(start * rate), count = Math.floor(seconds * rate);
  for (const t of whole ? [{ index: -1, name: 'mix', category: 'mix' }] : tracks) {
    const opts = new at.synth.AudioExportOptions();
    opts.sampleRate = rate;
    opts.metronomeVolume = 0;
    score.tracks.forEach((_, i) => opts.trackVolume.set(i, whole || i === t.index ? 1 : 0));
    const exporter = await a.exportAudio(opts);
    const out = new Float32Array(count * 2);
    let done = 0; // stereo frames rendered so far
    let chunk;
    while ((chunk = await exporter.render(2000))) {
      const frames = chunk.samples.length / 2;
      const from = Math.max(first, done), to = Math.min(first + count, done + frames);
      if (to > from) out.set(chunk.samples.subarray((from - done) * 2, (to - done) * 2), (from - first) * 2);
      done += frames;
      if (done >= first + count) break;
    }
    exporter.destroy();
    console.log(`[yt2gp5] track ${t.index} ${t.name} (${t.category}) rendered`);
    // in pieces: one big upload (a whole song is ~170 MB) is more than Playwright's driver can hold
    const piece = 4 * 1024 * 1024; // floats
    for (let i = 0; i < out.length; i += piece) {
      const r = await fetch(`/__save/${saveTo}/${whole ? 'mix' : 'track' + t.index}.f32${i ? '?append' : ''}`,
        { method: 'POST', body: out.subarray(i, i + piece) });
      if (!r.ok) throw new Error('saving track ' + t.index + ' failed: ' + r.status);
    }
  }

  const inWindow = (x) => x >= start - 1e-6 && x < end;
  const atStart = bars.filter((b) => b.time <= start + 1e-6).pop() || bars[0];
  return {
    title: score.title, artist: score.artist, start, seconds, rate, tracks, songEnd,
    notes: notes.filter((n) => n.track >= 0 && inWindow(n.start)).map((n) => ({ ...n, start: n.start - start, end: Math.min(n.end, end) - start })),
    barLines: bars.filter((b) => inWindow(b.time)).map((b) => ({ ...b, time: b.time - start })),
    bpm: atStart.bpm, timeSig: [atStart.num, atStart.den], fifths: atStart.fifths, minor: atStart.minor,
  };
};

// Every note the synth plays and every bar as played (repeats included), in seconds from the song's start,
// for listen.py: the bars give bar numbers (bar = index + 1), the notes are checked against the recording.
window.songNotes = async (b64) => {
  const a = await getApi();
  const score = at.importer.ScoreLoader.loadScoreFromBytes(b64ToBytes(b64), a.settings);
  const { notes, bars, tracks } = played(a, score, true);
  return { tracks, bars, notes: notes.filter((n) => n.track >= 0) };
};

// The true notes, from the same MIDI the synth plays (repeats included). transpose: the sounding pitch
// (as the player plays it), else the written one.
function played(a, score, transpose) {
  const midi = new at.midi.MidiFile();
  const gen = new at.midi.MidiFileGenerator(score, a.settings, new at.midi.AlphaSynthMidiFileHandler(midi));
  gen.applyTranspositionPitches = transpose;
  gen.generate();
  const clk = clock(midi);
  const trackOf = new Map();
  score.tracks.forEach((t, i) => { trackOf.set(t.playbackInfo.primaryChannel, i); trackOf.set(t.playbackInfo.secondaryChannel, i); });
  const open = new Map();
  const notes = [];
  for (const e of midi.events.slice().sort((x, y) => x.tick - y.tick)) {
    const on = e instanceof at.midi.NoteOnEvent && e.noteVelocity > 0;
    const off = e instanceof at.midi.NoteOffEvent || (e instanceof at.midi.NoteOnEvent && e.noteVelocity === 0);
    if (!on && !off) continue;
    const id = e.channel * 128 + e.noteKey;
    if (on) open.set(id, e);
    else if (open.has(id)) {
      const s = open.get(id);
      open.delete(id);
      notes.push({ track: trackOf.get(s.channel) ?? -1, start: clk.seconds(s.tick), end: clk.seconds(e.tick), pitch: s.noteKey, vel: s.noteVelocity });
    }
  }
  const tracks = score.tracks.map((t, i) => ({ index: i, name: t.name, program: t.playbackInfo.program, category: category(t) }));
  const bars = gen.tickLookup.masterBars.map((m) => ({
    time: clk.seconds(m.start), index: m.masterBar.index, section: m.masterBar.section?.text || null, num: m.masterBar.timeSignatureNumerator, den: m.masterBar.timeSignatureDenominator,
    fifths: m.masterBar.keySignature, minor: m.masterBar.keySignatureType === 1, bpm: clk.bpmAt(m.start),
  }));
  return { notes, bars, tracks };
}

window.checkGp5 = async (b64) => {
  const a = await getApi();
  const s = at.importer.ScoreLoader.loadScoreFromBytes(b64ToBytes(b64), a.settings);
  return {
    bars: s.masterBars.length, tempo: s.tempo, fifths: s.masterBars[0]?.keySignature ?? 0,
    tracks: s.tracks.map((t) => ({
      name: t.name, program: t.playbackInfo.program, tuning: t.staves[0].stringTuning.tunings,
      notes: t.staves[0].bars.reduce((n, b) => n + b.voices[0].beats.reduce((m, x) => m + x.notes.length, 0), 0),
      badBars: t.staves[0].bars.filter((b, i) => b.voices[0].beats.reduce((d, x) => d + x.playbackDuration, 0) !== s.masterBars[i].calculateDuration()).length,
    })),
  };
};

// Title, artist and length of a Guitar Pro file (repeats played), for songdb.py.
window.songInfo = async (b64) => {
  const a = await getApi();
  const score = at.importer.ScoreLoader.loadScoreFromBytes(b64ToBytes(b64), a.settings);
  const midi = new at.midi.MidiFile();
  const gen = new at.midi.MidiFileGenerator(score, a.settings, new at.midi.AlphaSynthMidiFileHandler(midi));
  gen.generate();
  const clk = clock(midi);
  const lastTick = Math.max(0, ...midi.events.map((e) => e.tick));
  return {
    title: score.title, artist: score.artist, seconds: Math.round(clk.seconds(lastTick)), bpm: score.tempo,
    tracks: score.tracks.map((t) => ({ name: t.name, category: category(t) })),
  };
};

// A folder of UG part PDFs ("Song - Artist - Part.pdf") → a Guitar Pro 7 file (base64), read the way
// Fretboard's importer reads them (importPdfParts in js/app.js), for songdb.py's answer key.
const PARTS = [
  [53, /vocal|voice|sing/i], [25, /acoustic|nylon/i], [27, /rhythm/i], [29, /lead(?!\s*vocal)|electric/i],
  [0, /piano|keys|keyboard/i], [89, /pad/i], [38, /synth\s*bass/i], [80, /synth/i], [34, /bass/i], [24, /uke/i],
  [0, /drum|shaker|percussion|tambourine|cajon|conga|bongo/i],
];
const drumKind = (name) => (/shaker|maraca/i.test(name) ? 'shaker' : /tambourine/i.test(name) ? 'tambourine' : /drum|percussion|cajon|conga|bongo|toms/i.test(name) ? 'kit' : null);

window.ugFolderToGp = async (files, { title, artist, key, keepOff = false }) => {
  const { pdfToTab } = await import('../../js/pdftab.js');
  const { ugToAlphaTex } = await import('../../js/ugtab.js');
  const parts = [], skipped = [];
  for (const f of files) {
    const name = f.part || f.name.replace(/\.[^.]+$/, '').split(' - ').pop().trim();
    const k = PARTS.findIndex(([, re]) => re.test(name));
    try {
      const r = await pdfToTab(b64ToBytes(f.b64).buffer, () => {}, { title, lyrics: false, dynamics: false, bass: /bass/i.test(name), drums: drumKind(name) });
      if (r.strips?.length) parts.push({ name, program: k >= 0 ? PARTS[k][0] : 0, strips: r.strips, bars: ugToAlphaTex(r.strips, { title, name })?.bars || 0 });
      else skipped.push(name);
    } catch (e) {
      skipped.push(`${name} (${e.message})`);
    }
  }
  const guitar = (p) => (/guitar|acoustic|electric|lead(?!\s*vocal)|rhythm/i.test(p.name) ? 0 : drumKind(p.name) ? 2 : 1);
  parts.sort((x, y) => guitar(x) - guitar(y));
  if (!parts.length) throw new Error('no part could be read');
  // The song's length is the bar count most parts agree on. A part that read more or fewer bars has lost or
  // gained bars somewhere, and ugToAlphaTex would cut or pad it at the end, so everything after the misread
  // plays at the wrong time. Such a part is left out (or kept with keepOff, for a look).
  const votes = new Map();
  for (const p of parts) votes.set(p.bars, (votes.get(p.bars) || 0) + 1);
  const songBars = [...votes].sort((x, y) => y[1] - x[1] || parts.findIndex((p) => p.bars === x[0]) - parts.findIndex((p) => p.bars === y[0]))[0][0];
  const off = parts.filter((p) => p.bars !== songBars);
  const used = keepOff ? parts : parts.filter((p) => p.bars === songBars);
  used.sort((x, y) => (x.bars !== songBars) - (y.bars !== songBars) || guitar(x) - guitar(y));
  const made = ugToAlphaTex(used[0].strips, { title, artist, name: used[0].name, program: used[0].program, extra: used.slice(1), key });
  const a = await getApi();
  const imp = new at.importer.AlphaTexImporter();
  imp.initFromString(made.tex.replace(/\\staff \{tabs\}/g, '\\staff {score tabs}'), a.settings);
  const score = imp.readScore();
  const bytes = new at.exporter.Gp7Exporter().export(score, a.settings);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { gp: btoa(s), bars: made.bars, songBars, parts: used.map((p) => `${p.name}: ${p.bars}`), off: off.map((p) => `${p.name}: ${p.bars} of ${songBars}`), skipped };
};

window.renderReady = true;
