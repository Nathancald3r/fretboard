// Sharing songs and setlists with other musicians and their apps (MusicStand, OnSong, SongbookPro…):
// - a chord chart or text tab as ChordPro, the format those apps read best, in the key you play it in
// - a tab or score as a PDF of its pages, with the whole song inside it (an attached .fretboard file),
//   so another Fretboard reads it back exactly
// - several files as one .zip (stored, no compression), with Setlist.txt for a setlist
// - songs and setlists as one .fretboard file (everything, for another Fretboard)
// Pure (no DOM): tested in tests/share.test.mjs.
import { shiftChordName } from './transpose.js';
import { pitchClass, noteName } from './theory.js';

/* ---------- keys ---------- */

const FLAT_MAJORS = [5, 10, 3, 8, 1]; // F Bb Eb Ab Db
const keyOf = (name) => (name && /^[A-G][#b]?m?$/.test(name) ? { tonic: pitchClass(name.replace(/m$/, '')), minor: /m$/.test(name) } : null);
const flatKey = (k) => FLAT_MAJORS.includes(k.minor ? (k.tonic + 3) % 12 : k.tonic);
const keyText = (k) => noteName(k.tonic, flatKey(k)) + (k.minor ? 'm' : '');

/** A key name moved by semitones: 'G' +2 → 'A', 'Bb' -1 → 'A', 'Em' +1 → 'Fm'. */
export function shiftKey(name, semitones) {
  const k = keyOf(name);
  if (!k) return name || '';
  if (!semitones) return name;
  return keyText({ tonic: (((k.tonic + semitones) % 12) + 12) % 12, minor: k.minor });
}

/** The written key of a song, when it says one: a chord chart's "Key: Bb" line, a read tab's \ks. */
export function writtenKey(song) {
  if (song.kind === 'text') return /\bKey:\s*([A-G][#b]?m?)(?![\w#])/.exec(String(song.data || '').slice(0, 400))?.[1] || '';
  if (song.kind === 'tex') return /\\ks\s+([A-G][#b]?m?)\b/.exec(String(song.data || ''))?.[1] || '';
  return '';
}

/** The key to play a song in: its written key moved by the song's own transpose (your key). */
export function playKey(song) {
  const shift = song.transpose || 0;
  const key = writtenKey(song);
  if (key) return { key: shiftKey(key, shift), written: key, shift };
  return { key: '', written: '', shift };
}

/* ---------- chord sheet → ChordPro ---------- */

const CHORD = /^\(?[A-G][#b♯♭]?(?:maj|min|dim|aug|sus|add|no|m|M|\+|°|ø|-|\d|\(|\)|#|b)*(?:\/[A-G][#b♯♭]?)?\)?$/;
const EXTRA = /^(\(?x\d+\)?|\(?\d+x\)?|\|+|:?\|\|?:?|-+|N\.?C\.?|%|\/|\.+)$/i;
const TAB_LINE = /^\s*[A-Ga-g]?[#b]?\s*[|:]?[-0-9|hpbrx/\\~^().<>*=sv ]*-{3,}[-0-9|hpbrx/\\~^().<>*=sv ]*$/;
const SECTION = /^\s*\[([^\]]{1,40})\]\s*$/;
const FACTS = /(^|·\s*)(Chords|Tab|Key:|Capo:|Tuning:|Tempo:|Time:)/;

const tokensOf = (line) => [...line.matchAll(/\S+/g)].map((m) => ({ text: m[0], at: m.index }));
function isChordLine(line) {
  const t = tokensOf(line);
  return t.some((x) => CHORD.test(x.text)) && t.every((x) => CHORD.test(x.text) || EXTRA.test(x.text));
}
const isTab = (line) => TAB_LINE.test(line) && /-{3,}/.test(line);

/** The head of a Fretboard chord sheet ("Title - Artist", the facts line, "From: url") and its body. */
export function splitSheet(text) {
  const lines = String(text || '').replace(/\[\/?(ch|tab)\]/g, '').replace(/\r\n?/g, '\n').split('\n');
  let n = 0;
  if (FACTS.test(lines[1] || '') && !SECTION.test(lines[0] || '')) n = 2;
  else if (FACTS.test(lines[0] || '') && /·|^Chords\b/.test(lines[0])) n = 1;
  if (n && /^From:\s*https?:/.test(lines[n] || '')) n++;
  const head = lines.slice(0, n).join('\n');
  const num = (re) => Number(re.exec(head)?.[1]) || 0;
  return {
    key: /\bKey:\s*([A-G][#b]?m?)(?![\w#])/.exec(head)?.[1] || '',
    capo: num(/\bCapo:\s*(\d+)/),
    tempo: num(/\bTempo:\s*(\d+)/),
    time: /\bTime:\s*(\d+\/\d+)/.exec(head)?.[1] || '',
    tuning: (/\bTuning:\s*([^·\n]+)/.exec(head)?.[1] || '').trim(),
    url: /^From:\s*(https?:\S+)/m.exec(head)?.[1] || '',
    body: lines.slice(n),
  };
}

// a lyric line must not read as ChordPro: [ ] would be chords, { } a directive
const plain = (s) => s.replace(/\[/g, '(').replace(/\]/g, ')').replace(/^(\s*)\{/, '$1(').replace(/^#/, ' #');

/**
 * A Fretboard chord sheet (or text tab) as ChordPro text, the chords moved by `shift` semitones
 * (the key you play it in). parts: more tabs to add at the end ([{ name, data }]).
 */
export function sheetToChordPro(text, { title = '', artist = '', tempo = 0, shift = 0, parts = [] } = {}) {
  const sheet = splitSheet(text);
  const key = sheet.key ? shiftKey(sheet.key, shift) : '';
  const flats = key ? flatKey(keyOf(key)) : /[A-G]b/.test(sheet.body.join(' '));
  const move = (c) => {
    if (!shift || !CHORD.test(c)) return c;
    const paren = /^\((.*)\)$/.exec(c);
    return paren ? `(${shiftChordName(paren[1], shift, flats)})` : shiftChordName(c, shift, flats);
  };
  const out = [];
  if (title) out.push(`{title: ${title}}`);
  if (artist) out.push(`{artist: ${artist}}`);
  if (key) out.push(`{key: ${key}}`);
  if (sheet.capo) out.push(`{capo: ${sheet.capo}}`);
  if (sheet.tempo || tempo) out.push(`{tempo: ${sheet.tempo || tempo}}`);
  if (sheet.time) out.push(`{time: ${sheet.time}}`);
  if (sheet.tuning && !/^E A D G B E$/i.test(sheet.tuning)) out.push(`{comment: Tuning ${sheet.tuning}}`);
  if (shift && sheet.key) out.push(`# Fretboard: moved ${shift > 0 ? '+' : ''}${shift} from ${sheet.key}`);
  out.push('');

  let open = null; // the {start_of_…} block we're in
  let named = false; // a [… tab] section: everything in it is tab, kept as it is
  const close = () => {
    if (open) { const blank = out[out.length - 1] === ''; if (blank) out.pop(); out.push(`{end_of_${open}}`); if (blank) out.push(''); }
    open = null; named = false;
  };
  const body = sheet.body;
  for (let i = 0; i < body.length; i++) {
    const line = body[i].replace(/\s+$/, '');
    if (open === 'tab' && named && line.trim() && !SECTION.test(line)) { out.push(line); continue; } // a [… tab] section, as written, up to a blank line
    if (!line.trim()) {
      if (open === 'tab') close();
      if (out[out.length - 1] !== '') out.push('');
      continue;
    }
    const sec = SECTION.exec(line);
    if (sec) {
      close();
      const name = sec[1].trim();
      const kind = /\btab\b/i.test(name) ? 'tab' : /chorus/i.test(name) ? 'chorus' : /bridge/i.test(name) ? 'bridge' : /verse/i.test(name) ? 'verse' : null;
      if (kind) { out.push(`{start_of_${kind}: ${name}}`); open = kind; named = kind === 'tab'; } else out.push(`{comment: ${name}}`);
      continue;
    }
    if (isTab(line)) {
      if (open !== 'tab') { close(); out.push('{start_of_tab}'); open = 'tab'; }
      out.push(line);
      continue;
    }
    if (open === 'tab') close();
    const t = line.trim();
    if (t.startsWith('✎')) { out.push(`{comment: ${t}}`); continue; }
    const ccli = /^CCLI Song #\s*(\d+)/i.exec(t);
    if (ccli) { out.push(`{ccli: ${ccli[1]}}`); continue; }
    const copy = /^©\s*(.+)$/.exec(t);
    if (copy) { out.push(`{copyright: ${copy[1]}}`); continue; }
    if (isChordLine(line)) {
      const next = (body[i + 1] || '').replace(/\s+$/, '');
      const words = next.trim() && !isChordLine(next) && !SECTION.test(next) && !isTab(next) && !next.trim().startsWith('✎');
      out.push(words ? merge(line, next, move) : tokensOf(line).reduceRight((s, x) => s.slice(0, x.at) + (CHORD.test(x.text) ? `[${move(x.text)}]` : x.text) + s.slice(x.at + x.text.length), line));
      if (words) i++;
      continue;
    }
    out.push(plain(line));
  }
  close();
  for (const p of parts) {
    if (!String(p.data || '').trim()) continue;
    if (out[out.length - 1] !== '') out.push('');
    out.push(`{start_of_tab: ${p.name} tab}`, ...String(p.data).replace(/\r\n?/g, '\n').replace(/\[\/?(ch|tab)\]/g, '').split('\n').map((l) => l.replace(/\s+$/, '')), '{end_of_tab}');
  }
  while (out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

// "G      C" over "Amazing grace how sweet" → "[G]Amazing g[C]race how sweet"
function merge(chords, words, move) {
  let s = plain(words);
  const extras = [];
  const t = tokensOf(chords);
  for (let j = t.length - 1; j >= 0; j--) {
    const x = t[j];
    if (!CHORD.test(x.text)) { extras.unshift(x.text); continue; }
    s = s.padEnd(x.at);
    s = s.slice(0, x.at) + `[${move(x.text)}]` + s.slice(x.at);
  }
  return (s.replace(/\s+$/, '') + (extras.length ? `  ${extras.join(' ')}` : ''));
}

/** A song as ChordPro text (a chord chart or text tab), in the key you play it in. */
export function songToChordPro(song, { data = song.data } = {}) {
  return sheetToChordPro(data, { title: song.title, artist: song.artist, tempo: song.tempo || 0, shift: song.transpose || 0, parts: data === song.data ? song.parts || [] : [] });
}

/* ---------- .fretboard files: songs (and setlists) for another Fretboard ---------- */

// Kept on this device: practice history, rankings, folders, ids.
const PRIVATE = ['id', 'uid', 'practiceSeconds', 'rating', 'folder', 'lastOpened', 'lastPracticed', 'bestSpeed', 'updated', 'deleted'];

export const toBase64 = (bytes) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromBase64 = (b64) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

function pack(v) {
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return { $bytes: toBase64(bytes) };
  }
  if (Array.isArray(v)) return v.map(pack);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pack(x)]));
  return v;
}

function unpack(v) {
  if (Array.isArray(v)) return v.map(unpack);
  if (v && typeof v === 'object') {
    if (typeof v.$bytes === 'string') return fromBase64(v.$bytes).buffer;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpack(x)]));
  }
  return v;
}

/**
 * The text of a .fretboard file. setlists: [{ name, date, songIds }] whose ids are among the songs';
 * each is saved by its songs' places in the file.
 */
export function fretboardFile(songs, { setlists = [] } = {}) {
  const out = songs.map((s) => { const c = { ...s }; for (const k of PRIVATE) delete c[k]; return pack(c); });
  const lists = setlists.map((l) => ({
    name: l.name,
    ...(l.date ? { date: l.date } : {}),
    songs: l.songIds.map((id) => songs.findIndex((s) => s.id === id)).filter((i) => i >= 0),
  }));
  return JSON.stringify({ format: 'fretboard-songs', version: 1, created: new Date().toISOString(), songs: out, ...(lists.length ? { setlists: lists } : {}) });
}

/** A .fretboard file read: { songs, setlists: [{ name, date, songs: [indexes] }] }, or null when it isn't one. */
export function readFretboardFile(text) {
  let f;
  try { f = JSON.parse(text); } catch { return null; }
  if (f?.format !== 'fretboard-songs' || !Array.isArray(f.songs)) return null;
  const valid = f.songs.map((s) => (s && typeof s.title === 'string' && s.kind ? s : null));
  const at = []; // index in the file → index among the songs kept
  const songs = [];
  valid.forEach((s, i) => { if (s) { at[i] = songs.length; songs.push({ ...unpack(s), added: Date.now() }); } });
  const setlists = (Array.isArray(f.setlists) ? f.setlists : []).filter((l) => l && typeof l.name === 'string' && Array.isArray(l.songs)).map((l) => ({
    name: l.name.slice(0, 60),
    date: /^\d{4}-\d{2}-\d{2}$/.test(l.date || '') ? l.date : '',
    songs: l.songs.map((i) => at[i]).filter((i) => i !== undefined),
  }));
  return { songs, setlists };
}

/** The songs in a shared .fretboard file, ready to save (null: not one). */
export const readShared = (text) => readFretboardFile(text)?.songs || null;

/* ---------- setlists ---------- */

/** "Sunday service · 2026-10-25" style file names: safe on every system. */
export const safeName = (s) => String(s || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled';

/** "Sunday 25 October 2026" for a date "2026-10-25" ('' when there is none). */
export function dateText(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Setlist.txt, for people and for Fretboard: the name, the date, and each song in order with its key.
 * entries: [{ title, artist, key, file }].
 */
export function setlistText(list, entries) {
  const lines = [`Setlist: ${list.name}`];
  if (list.date) lines.push(`Date: ${list.date}${dateText(list.date) ? ` (${dateText(list.date)})` : ''}`);
  lines.push('');
  entries.forEach((e, i) => {
    lines.push(`${i + 1}. ${e.title}${e.artist ? ` - ${e.artist}` : ''}${e.key ? ` · Key: ${e.key}` : ''}${e.file ? ` · ${e.file}` : ''}`);
  });
  lines.push('', 'Made with Fretboard. Each song is its own file, numbered in setlist order.');
  return lines.join('\n') + '\n';
}

/** Setlist.txt read back: { name, date, files: [file names in order] }, or null. */
export function readSetlistText(text) {
  const name = /^Setlist:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (!name) return null;
  const date = /^Date:\s*(\d{4}-\d{2}-\d{2})/m.exec(text)?.[1] || '';
  const files = [...String(text).matchAll(/^\d+\.\s.*·\s([^·\n]+\.\w+)\s*$/gm)].map((m) => m[1].trim());
  return { name: name.slice(0, 60), date, files };
}

/* ---------- zip (stored) ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const asBytes = (d) => (typeof d === 'string' ? new TextEncoder().encode(d) : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength));

/** files: [{ name, data (string, ArrayBuffer or bytes) }] → the bytes of a .zip holding them. */
export function makeZip(files, when = new Date()) {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = asBytes(f.data);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, date, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of chunks) { out.set(b, at); at += b.length; }
  return out;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files in a .zip (stored or deflated): [{ name, data: Uint8Array }]. Folders and Mac extras left out. */
export async function readZip(buf) {
  const b = asBytes(buf);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('Not a zip file');
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const out = [];
  const utf8 = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = utf8.decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || /(^|\/)(__MACOSX|\.DS_Store)/.test(name)) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = b.subarray(start, start + size);
    if (method === 0) out.push({ name, data: raw.slice() });
    else if (method === 8) out.push({ name, data: await inflate(raw) });
  }
  return out;
}

/* ---------- PDF: page pictures, with the song attached ---------- */

const ATTACH_TYPE = '/application#2Fvnd.fretboard#2Bjson';

// a PDF text string: UTF-16BE in hex, so any title works
const pdfText = (s) => '<FEFF' + [...String(s)].map((ch) => {
  const c = ch.codePointAt(0);
  if (c < 0x10000) return c.toString(16).padStart(4, '0');
  const u = c - 0x10000;
  return ((0xd800 | (u >> 10)).toString(16) + (0xdc00 | (u & 0x3ff)).toString(16));
}).join('').toUpperCase() + '>';

/**
 * A PDF with one picture (JPEG bytes) per page, each page sized to its picture, A4 wide.
 * attach: { name, data } — a file kept inside it (another Fretboard reads the song back from it).
 */
export function makePdf(pages, { title = '', attach = null } = {}) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let len = 0;
  const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); len += b.length; };
  const obj = (n, dict, stream = null) => {
    offsets[n] = len;
    put(`${n} 0 obj\n${dict}\n`);
    if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
    put('endobj\n');
  };
  put(concat([enc.encode('%PDF-1.4\n%'), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3, 0x0a])])); // binary marker
  const first = attach ? 6 : 4; // object number of the first page
  const kids = pages.map((_, i) => `${first + i * 3} 0 R`).join(' ');
  const fileName = safeName(attach?.name || '').replace(/[^\x20-\x7e]/g, '_').replace(/[()\\]/g, '');
  obj(1, `<< /Type /Catalog /Pages 2 0 R${attach ? ` /Names << /EmbeddedFiles << /Names [(${fileName}) 5 0 R] >> >>` : ''} >>`);
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  obj(3, `<< /Title ${pdfText(title)} /Producer (Fretboard) >>`);
  if (attach) {
    const data = asBytes(attach.data);
    obj(4, `<< /Type /EmbeddedFile /Subtype ${ATTACH_TYPE} /Length ${data.length} >>`, data);
    obj(5, `<< /Type /Filespec /F (${fileName}) /UF ${pdfText(attach.name)} /EF << /F 4 0 R >> /Desc (The song, for Fretboard) >>`);
  }
  pages.forEach((p, i) => {
    const n = first + i * 3;
    const w = 595.28;
    const h = Math.round((w * p.height) / p.width * 100) / 100;
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    const draw = enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
    obj(n + 1, `<< /Length ${draw.length} >>`, draw);
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`, p.jpeg);
  });
  const size = first + pages.length * 3;
  const xref = len;
  put(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let n = 1; n < size; n++) put(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return concat(chunks);
}

/** The .fretboard text attached to a PDF Fretboard made, or null. */
export function pdfAttachment(buf) {
  const b = asBytes(buf);
  const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 1 << 16)));
  const at = head.indexOf(ATTACH_TYPE);
  if (at < 0) return null;
  const length = Number(/\/Length (\d+)/.exec(head.slice(at, at + 200))?.[1]);
  const start = head.indexOf('stream\n', at) + 7;
  if (!length || start < 7 || start + length > b.length) return null;
  return new TextDecoder().decode(b.subarray(start, start + length));
}
