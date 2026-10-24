// Reads Power Tab (.ptb) files and builds alphaTex: one track per guitar, with its own name, sound and
// tuning. The file layout and its timing rules follow TuxGuitar's PTB reader (LGPL), ported to JS.

const Q = 960; // ticks in a quarter note

const GM = { 0: 'Piano', 1: 'Piano', 4: 'Electric Piano', 5: 'Electric Piano', 16: 'Organ', 48: 'Strings', 49: 'Strings', 52: 'Choir', 53: 'Voice', 54: 'Synth Voice', 24: 'Nylon Guitar', 25: 'Acoustic Guitar', 26: 'Jazz Guitar', 27: 'Clean Electric Guitar', 28: 'Muted Guitar', 29: 'Overdriven Guitar', 30: 'Distortion Guitar', 31: 'Guitar Harmonics', 32: 'Acoustic Bass', 33: 'Bass', 34: 'Bass (pick)', 35: 'Fretless Bass', 36: 'Slap Bass', 37: 'Slap Bass', 38: 'Synth Bass', 39: 'Synth Bass' };

const GROUPS = ['Piano', 'Bells', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass', 'Reed', 'Pipe', 'Synth Lead', 'Synth Pad', 'Synth Effects', 'Ethnic', 'Percussion', 'Sound Effects'];

class Reader {
  constructor(buf) { this.b = new Uint8Array(buf); this.i = 0; }
  byte() { return this.b[this.i++] ?? 0; }
  short() { const v = this.b[this.i] | (this.b[this.i + 1] << 8); this.i += 2; return v; }
  int() { const v = this.b[this.i] | (this.b[this.i + 1] << 8) | (this.b[this.i + 2] << 16) | (this.b[this.i + 3] << 24); this.i += 4; return v; }
  skip(n) { this.i += n; }
  text(n) { const s = new TextDecoder('latin1').decode(this.b.subarray(this.i, this.i + n)); this.i += n; return s; }
  str() { const n = this.byte(); return this.text(n < 0xff ? n : this.short()); }
  // an MFC list: its count, then a class header the first time a class is written
  head() {
    const n = this.short();
    if (n) {
      if (this.short() === 0xffff) {
        if (this.short() !== 1) throw new Error('Unsupported Power Tab list');
        this.text(this.short());
      }
    }
    return n;
  }
  list(read) { const n = this.head(); for (let j = 0; j < n; j++) { read(j); if (j < n - 1) this.short(); } }
}

const sectionAt = (t, n) => { while (t.sections.length <= n) t.sections.push({ staffs: 0, at: new Map() }); return t.sections[n]; };
const at = (s, p) => { if (!s.at.has(p)) s.at.set(p, []); return s.at.get(p); };

function readBarLine(r, sec) {
  const pos = r.byte();
  const type = r.byte();
  r.byte(); // key
  const data = r.int() >> 24;
  r.byte(); // pulses
  r.byte(); r.str(); // rehearsal sign
  at(sec, pos).push({ k: 'bar', start: type >>> 5 === 3, close: type >>> 5 === 4 ? type - 128 : 0, num: ((data - (data % 8)) / 8) + 1, den: 2 ** (data % 8) });
}

function readPosition(r, sec, staff, voice) {
  const pos = r.byte();
  let beaming = r.byte();
  if (beaming >= 128) beaming -= 128;
  r.byte();
  const d1 = r.byte();
  r.byte();
  const d3 = r.byte();
  const value = r.byte();
  let rest = 1;
  for (let n = r.byte(), i = 0; i < n; i++) {
    const count = r.short(); r.byte();
    if (r.byte() & 0x08) rest = count;
  }
  const notes = [];
  r.list(() => {
    const p = r.byte();
    const simple = r.short();
    const note = { fret: p & 0x1f, string: ((p & 0xe0) >> 5) + 1, tied: !!(simple & 1), dead: !!(simple & 2), bend: 0, slide: false };
    for (let n = r.byte(), i = 0; i < n; i++) {
      r.byte(); r.byte();
      const a = r.byte(); const b = r.byte();
      if (b === 101) note.bend = a / 16 + 1;
      if (b === 100) note.slide = true;
    }
    notes.push(note);
  });
  at(sec, pos).push({
    k: 'beat', staff, voice, notes, value, rest: notes.length ? 1 : rest,
    dotted: !!(d1 & 1), dd: !!(d1 & 2), vib: !!(d1 & 0x18), grace: !!(d3 & 1),
    enters: ((beaming - (beaming % 8)) / 8) + 1, times: (beaming % 8) + 1,
  });
}

function readSection(r, sec) {
  r.skip(16);
  const last = r.byte();
  r.skip(4);
  readBarLine(r, sec);
  r.list(() => { const pos = r.byte(); for (let n = r.byte(), i = 0; i < n; i++) { const d = r.short(); at(sec, pos).push({ k: 'dir', dir: d >> 8, active: (d & 0xc0) >> 6, repeat: d & 0x1f }); } });
  r.list(() => { r.byte(); r.short(); r.byte(); r.short(); r.byte(); }); // chord names
  r.list(() => { r.byte(); r.byte(); r.int(); }); // rhythm slashes
  sec.staffs = r.head();
  for (let s = 0; s < sec.staffs; s++) {
    r.skip(5);
    for (let v = 0; v < 2; v++) r.list(() => readPosition(r, sec, s, v));
    if (s < sec.staffs - 1) r.short();
  }
  r.list(() => readBarLine(r, sec));
  const next = sec.at.size ? Math.max(...sec.at.keys()) + 1 : 0;
  at(sec, next).push({ k: 'bar', start: false, close: last >>> 5 === 4 ? last - 128 : 0, num: 0, den: 0 });
}

function readScore(r) {
  const t = { infos: [], sections: [] };
  r.list(() => {
    const info = { number: r.byte(), name: r.str(), program: r.byte(), volume: r.byte(), balance: r.byte() };
    r.skip(4); // reverb, chorus, tremolo, phaser
    info.capo = r.byte();
    info.tuningName = r.str();
    r.byte();
    info.strings = Array.from({ length: r.byte() }, () => r.byte()); // highest string first
    t.infos.push(info);
  });
  r.list(() => { r.short(); r.byte(); r.short(); r.byte(); r.byte(); r.skip(r.byte()); }); // chord diagrams
  r.list(() => { r.str(); r.skip(17); r.str(); r.skip(15); }); // floating text
  r.list(() => { const s = r.short(); const staff = r.byte(); const p = r.byte(); r.skip(1); at(sectionAt(t, s), p).push({ k: 'in', staff, mask: r.byte() }); });
  r.list(() => {
    const s = r.short(); const p = r.byte(); const bpm = r.short(); r.short(); r.str();
    if (bpm > 0) at(sectionAt(t, s), p).push({ k: 'tempo', bpm });
  });
  r.list(() => { r.short(); r.byte(); r.byte(); r.short(); }); // dynamics
  r.list(() => { const s = r.short(); const p = r.byte(); at(sectionAt(t, s), p).push({ k: 'sym', end: r.int() >> 16 }); });
  r.list((j) => readSection(r, sectionAt(t, j)));
  // positions in order; directions last within a position
  for (const s of t.sections) s.list = [...s.at.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => [...c.filter((x) => x.k !== 'dir'), ...c.filter((x) => x.k === 'dir')]);
  return t;
}

export function readPtb(buf) {
  const r = new Reader(buf);
  if (r.text(4) !== 'ptab') throw new Error('Not a Power Tab file');
  r.short(); // version
  const info = {};
  const kind = r.byte();
  if (kind === 0) {
    r.skip(1);
    info.title = r.str(); info.artist = r.str();
    const release = r.byte();
    if (release === 0) { r.byte(); info.album = r.str(); r.short(); r.byte(); }
    else if (release === 1) { info.album = r.str(); r.byte(); }
    else if (release === 2) { info.album = r.str(); r.skip(6); }
    if (r.byte() === 0) { info.author = r.str(); r.str(); }
    for (let i = 0; i < 7; i++) r.str(); // arranger, transcribers, copyright, lyrics, instructions
  } else if (kind === 1) {
    info.title = r.str(); info.album = r.str(); r.short(); r.byte(); info.author = r.str(); r.str(); r.str();
  }
  return { info, scores: [readScore(r), readScore(r)] };
}

// Repeats, endings, D.C./D.S. and codas played out in order (TuxGuitar's PTSongSynchronizerUtil):
// the result is a list of sections, each a list of positions' components.
function unroll(t) {
  const out = [];
  const rd = { repeatStart: null, inProgress: false, number: 0, alt: false, skip: false, find: 0 };
  const used = new Set();
  const use = (d) => (used.has(d) ? false : (used.add(d), true));
  const find = (dir, sEnd, pEnd) => {
    for (let s = 0; s < (sEnd >= 0 ? sEnd + 1 : t.sections.length); s++) {
      const list = t.sections[s].list;
      for (let p = 0; p < (s === sEnd ? pEnd + 1 : list.length); p++) {
        for (const c of list[p]) if (c.k === 'dir' && c.dir === dir && use(c)) return [s, p, 0];
      }
    }
    return null;
  };
  let guard = 0;
  const walk = ([s0, p0, c0]) => {
    if (++guard > 500) return; // a broken jump loop
    for (let s = s0; s < t.sections.length; s++) {
      const sec = t.sections[s];
      const dst = { staffs: sec.staffs, list: [] };
      out.push(dst);
      for (let p = s === s0 ? p0 : 0; p < sec.list.length; p++) {
        const comps = sec.list[p];
        const dp = [];
        dst.list.push(dp);
        for (let c = s === s0 && p === p0 ? c0 : 0; c < comps.length; c++) {
          const x = comps[c];
          if (!rd.skip) dp.push(x);
          if (x.k === 'bar') {
            if (x.close > 0 && rd.repeatStart) {
              rd.number++; rd.inProgress = true; rd.alt = false; rd.skip = false;
              if (rd.number < x.close) return walk(rd.repeatStart);
              rd.repeatStart = null; rd.number = 0;
            }
            if (x.start) { rd.repeatStart = [s, p, c]; if (!rd.inProgress) rd.number = 0; rd.inProgress = false; }
          } else if (x.k === 'sym') {
            rd.skip = false;
            if (!rd.alt && (x.end & 1)) {
              if (rd.number > 0 && !(x.end & (1 << rd.number))) rd.skip = true;
              rd.alt = true;
            }
          } else if (x.k === 'dir') {
            const okRepeat = x.repeat === 0 || (rd.repeatStart && rd.number + 1 === x.repeat);
            if (x.active !== rd.find || !okRepeat) continue;
            rd.find = 0;
            const d = x.dir;
            const segno = d === 6 || d === 12 || d === 13 || d === 17 ? 2 : d === 7 || d === 14 || d === 15 || d === 18 ? 3 : 0;
            if (d === 4) { if (use(x)) return; }
            else if (d === 5 || d === 10 || d === 11 || d === 16) {
              if (use(x)) { if (d !== 5) rd.find = 1; return walk([0, 0, 0]); }
            } else if (segno) {
              if (d === 17 || d === 18 || use(x)) {
                const to = find(segno, s, p);
                if (to) { if (d > 7) rd.find = segno; return walk(to); }
              }
            } else if (d === 8 || d === 9) {
              if (use(x)) { const to = find(d === 8 ? 0 : 1, -1, -1); if (to) return walk(to); }
            }
          }
        }
      }
    }
  };
  walk([0, 0, 0]);
  return out;
}

const fix = (v) => (((v % (Q / 2)) + 10 > Q / 2) ? v + (Q / 2 - (v % (Q / 2))) : v); // to the nearest eighth
const beatTicks = (b) => {
  let t = (Q * 4) / b.value;
  if (b.dd) t *= 1.75; else if (b.dotted) t *= 1.5;
  return Math.round((t * b.times) / b.enters);
};

// Places every beat in time per guitar (TuxGuitar's PTSongParser): returns the bar lines, tempo
// changes and, per guitar, its beats with start times.
function timeline(t) {
  const secs = unroll(t);
  const bars = [];
  const tempos = [];
  const beats = new Map(); // guitar number → beats
  const staffGuitars = [];
  const def = t.infos.reduce((a, b) => (!a || b.number < a.number ? b : a), null);
  let start = 0;
  let maxV = 0;
  for (const sec of secs) {
    const n = Math.max(1, sec.staffs);
    let v = Array.from({ length: n }, () => [start, start]);
    let empty = true; let rest = false; let barStart = 0; let barLen = 0;
    const maxStart = () => {
      let m = 0;
      for (const s of v) m = Math.max(m, s[0], s[1]);
      if (rest && empty) m = Math.max(m, barStart + barLen);
      return fix(m);
    };
    const init = (x) => { v = v.map(() => [fix(x), fix(x)]); empty = true; rest = false; };
    init(start);
    for (const comps of sec.list) {
      for (const c of comps) {
        if (c.k === 'bar') {
          const m = maxStart();
          init(m);
          if (c.num > 0 && c.den > 0) { barStart = m; barLen = Math.round(c.num * Q * (4 / c.den)); bars.push({ t: m, num: c.num, den: c.den }); }
          else bars.push({ t: m });
        } else if (c.k === 'in') {
          const g = t.infos.filter((i) => (1 << i.number) & c.mask);
          if (g.length) staffGuitars[c.staff] = g;
        } else if (c.k === 'tempo') {
          tempos.push({ t: maxStart(), bpm: c.bpm });
        } else if (c.k === 'beat') {
          if (c.grace || c.staff >= v.length) continue;
          if (c.rest > 1) { v[c.staff][c.voice] = fix(barStart + c.rest * barLen); continue; }
          const s = v[c.staff][c.voice];
          let len = beatTicks(c);
          const isRest = !c.notes.length;
          empty = empty && isRest; rest = true;
          if (isRest && s === barStart && len > barLen) len = barLen;
          v[c.staff][c.voice] = fix(s + len);
          if (c.voice) maxV++;
          for (const g of staffGuitars[c.staff] || [def]) {
            if (!g) continue;
            if (!beats.has(g.number)) beats.set(g.number, []);
            beats.get(g.number).push({ ...c, t: s, len });
          }
        }
      }
    }
    start = maxStart();
  }
  return { bars, tempos, beats, end: start, secondVoice: maxV };
}

// ---------- alphaTex ----------

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitch = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
const VALUES = [1, 2, 4, 8, 16, 32, 64];
// a gap of ticks as rests, longest first
function restFill(ticks) {
  const out = [];
  for (let left = ticks; left >= Q / 16;) {
    let done = false;
    for (const v of VALUES) {
      const t = (Q * 4) / v;
      if (t * 1.5 <= left && v < 64) { out.push(`r.${v}{d}`); left -= t * 1.5; done = true; break; }
      if (t <= left) { out.push(`r.${v}`); left -= t; done = true; break; }
    }
    if (!done) break;
  }
  return out;
}

function beatTex(b, strings) {
  const fx = [b.dd ? 'dd' : b.dotted ? 'd' : '', b.enters > 1 && b.enters !== b.times ? `tu ${b.enters}` : ''].filter(Boolean).join(' ');
  const d = `${b.value}${fx ? `{${fx}}` : ''}`;
  const notes = b.notes.filter((n) => n.string <= strings).map((n) => {
    const own = [b.vib && !n.tied ? 'v' : '', n.slide ? 'sl' : '', n.bend ? 'b (0 4 4)' : ''].filter(Boolean).join(' ');
    return `${n.tied ? '-' : n.dead ? 'x' : n.fret}.${n.string}${own ? `{${own}}` : ''}`;
  });
  if (!notes.length) return `r.${d}`;
  return notes.length === 1 ? `${notes[0]}.${d}` : `(${notes.join(' ')}).${d}`;
}

const trackName = (g, used) => {
  const sound = GM[g.program] || GROUPS[g.program >> 3];
  const own = g.name && !/^untitled$/i.test(g.name.trim()) ? g.name.trim() : '';
  let name = own ? `${own} (${sound})` : sound;
  for (let k = 2; used.has(name); k++) name = `${own || sound} ${k}`;
  used.add(name);
  return name;
};

export function ptbToAlphaTex(buf) {
  const song = readPtb(buf);
  const lines = song.scores.map((s) => (s.sections.length ? timeline(s) : null));
  const main = lines[0] || lines[1];
  // bar starts from the guitar score; a gap longer than a bar is filled with bars of the same length
  const marks = [];
  for (const b of main.bars) if (b.num && !marks.some((m) => m.t === b.t)) marks.push(b);
  marks.sort((a, b) => a.t - b.t);
  const grid = [];
  marks.forEach((m, i) => {
    const len = Math.round(m.num * Q * (4 / m.den));
    const next = marks[i + 1]?.t ?? main.end;
    for (let t = m.t; t < next - Q / 8; t += len) grid.push({ t, len, num: m.num, den: m.den });
  });
  const tracks = [];
  const used = new Set();
  song.scores.forEach((s, k) => {
    if (!lines[k]) return;
    for (const g of s.infos) {
      const list = (lines[k].beats.get(g.number) || []).filter((b) => b.voice === 0);
      if (!list.some((b) => b.notes.length)) continue;
      tracks.push({ g, list, name: trackName(g, used) });
    }
  });
  const tempoAt = (i) => main.tempos.filter((x) => x.t >= grid[i].t && x.t < grid[i].t + grid[i].len).pop()?.bpm;
  const firstTempo = main.tempos[0]?.bpm || 120;
  const out = [
    `\\title ${JSON.stringify(song.info.title || 'Power Tab')}`,
    song.info.artist ? `\\artist ${JSON.stringify(song.info.artist)}` : '',
    `\\tempo ${firstTempo}`,
    '.',
  ].filter(Boolean);
  let bad = 0;
  tracks.forEach((tr, k) => {
    out.push(`\\track ${JSON.stringify(tr.name)}`, '\\staff {score tabs}', `\\tuning ${tr.g.strings.map(pitch).join(' ')}`, `\\instrument ${tr.g.program}`);
    if (tr.g.capo) out.push(`\\capo ${tr.g.capo}`);
    let j = 0;
    let lastTempo = firstTempo;
    const bars = grid.map((bar, i) => {
      const head = [];
      if (k === 0) {
        if (i === 0 || grid[i - 1].num !== bar.num || grid[i - 1].den !== bar.den) head.push(`\\ts ${bar.num} ${bar.den}`);
        const tp = tempoAt(i);
        if (tp && tp !== lastTempo && i) { head.push(`\\tempo ${tp}`); lastTempo = tp; }
      } else if (i === 0 || grid[i - 1].num !== bar.num || grid[i - 1].den !== bar.den) head.push(`\\ts ${bar.num} ${bar.den}`);
      const end = bar.t + bar.len;
      const parts = [];
      let at = bar.t;
      while (j < tr.list.length && tr.list[j].t < end) {
        const b = tr.list[j++];
        if (b.t < at) { bad++; continue; } // overlaps the beat before it
        if (b.t > at) parts.push(...restFill(b.t - at));
        const len = Math.min(b.len, end - b.t);
        parts.push(len < b.len && !b.notes.length ? restFill(len).join(' ') : beatTex(b, tr.g.strings.length));
        at = b.t + b.len;
      }
      if (at < end) parts.push(...restFill(end - at));
      return `${head.join(' ')} ${parts.join(' ')}`.trim();
    });
    out.push(bars.join(' |\n'));
  });
  return { tex: out.join('\n'), title: song.info.title || '', artist: song.info.artist || '', bars: grid.length, tracks: tracks.map((t) => t.name), skipped: bad };
}
