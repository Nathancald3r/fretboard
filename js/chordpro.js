// ChordPro files (.cho, .chordpro, .chopro, .crd) and chord-chart PDFs (SongSelect and the like) as
// Fretboard chord sheets: chords written over the words. A chart PDF has real text in it, so it is read
// from the text's positions, not from a picture: a row of chord names sits just above a row of words, and
// each chord stands over the word it is played on. Small raised text (the 2 of Eb², the sus of Fsus) is
// part of the chord before it.
// Notes someone added (PDF comments, ChordPro comments starting with ✎) can be kept, with who wrote them,
// or left out. Pure apart from pdfToChordPro (no DOM): tested in tests/chordpro.test.mjs.

const CHORD = /^[A-G][#b♯♭]?(?:maj|min|dim|aug|sus|add|no|m|M|\+|°|ø|-|\d|\(|\)|#|b)*(?:\/[A-G][#b♯♭]?)?$/;
const isChord = (t) => CHORD.test(t);
const NOTE = '✎';

/* ---------- ChordPro → chord sheet ---------- */

const SECTIONS = { sov: 'Verse', soc: 'Chorus', sob: 'Bridge', sot: 'Tab', sog: 'Grid' };
const LONG = { start_of_verse: 'sov', start_of_chorus: 'soc', start_of_bridge: 'sob', start_of_tab: 'sot', start_of_grid: 'sog' };

/** A ChordPro line ("He [Bb]loves us") as a chord line over a words line; chord only: just the chord line. */
export function chordsOver(line) {
  let words = '';
  let chords = '';
  let any = false;
  for (const part of line.split(/(\[[^\]]*\])/)) {
    const m = /^\[([^\]]*)\]$/.exec(part);
    if (!m) { words += part; continue; }
    any = true;
    const at = Math.max(words.length, chords.length ? chords.length + 1 : 0);
    words = words.padEnd(at); // chords never run into each other: the words get spaces to make room
    chords = chords.padEnd(at) + m[1];
  }
  if (!any) return [line];
  // chords between bar lines ("| [Bb] | [F] |"): one chord line as written
  if (/^[\s|:.%/x\d-]*$/i.test(line.replace(/\[[^\]]*\]/g, ''))) return [line.replace(/\[([^\]]*)\]/g, '$1').trimEnd()];
  return words.trim() ? [chords.trimEnd(), words.trimEnd()] : [chords.trimEnd()];
}

/**
 * Reads ChordPro text. notes: false leaves out the ✎ notes (the clean copy).
 * Returns { title, artist, key, capo, tempo, time, ccli, copyright, notes: [{ by, text }], text } where text
 * is the chord sheet as Fretboard shows it (UG style: a facts line, [Section] lines, chords over words).
 */
export function readChordPro(src, { notes = true } = {}) {
  const meta = { title: '', artist: '', key: '', capo: 0, tempo: 0, time: '', ccli: '', copyright: '' };
  const found = [];
  const body = [];
  const blank = () => { if (body.length && body[body.length - 1] !== '') body.push(''); };
  let inTab = false;
  for (const raw of String(src || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const d = /^\s*\{\s*([\w-]+)\s*(?::\s*(.*?))?\s*\}\s*$/.exec(line);
    if (!d) {
      if (/^#/.test(line)) continue; // a ChordPro remark, not shown
      if (inTab) { body.push(line); continue; }
      if (line.trim().startsWith(NOTE)) { const n = noteOf(line.trim()); found.push(n); if (notes) body.push(line.trim()); continue; }
      if (!line.trim()) blank(); else body.push(...chordsOver(line));
      continue;
    }
    const name = d[1].toLowerCase();
    const val = (d[2] || '').trim();
    const short = LONG[name] || name;
    if (name === 'title' || name === 't') meta.title = val;
    else if (['artist', 'subtitle', 'st', 'composer'].includes(name)) meta.artist ||= val;
    else if (name === 'key') meta.key = val;
    else if (name === 'capo') meta.capo = Number(val) || 0;
    else if (name === 'tempo') meta.tempo = Number(val) || 0;
    else if (name === 'time') meta.time = val;
    else if (name === 'ccli') meta.ccli = val;
    else if (name === 'copyright') meta.copyright = val;
    else if (name === 'meta') {
      const [k, ...v] = val.split(/\s+/);
      if (k && meta[k.toLowerCase()] === '') meta[k.toLowerCase()] = v.join(' ');
    } else if (SECTIONS[short]) {
      blank();
      body.push(`[${val || SECTIONS[short]}]`);
      inTab = short === 'sot';
    } else if (/^(end_of_\w+|eo[vcbtg])$/.test(name)) {
      inTab = false;
      blank();
    } else if (name === 'chorus') { blank(); body.push(`[${val || 'Chorus'}]`); } // "sing the chorus again"
    else if (['comment', 'c', 'comment_box', 'cb', 'highlight'].includes(name)) {
      if (val.startsWith(NOTE)) { found.push(noteOf(val)); if (notes) body.push(val); }
      else if (/^[\w\s'’&()-]{1,30}$/.test(val) && !/[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}/.test(val)) { blank(); body.push(`[${val}]`); }
      else body.push(val);
    } else if (['comment_italic', 'ci'].includes(name)) {
      if (val.startsWith(NOTE)) { found.push(noteOf(val)); if (notes) body.push(val); } else body.push(val);
    }
  }
  while (body[0] === '') body.shift();
  while (body[body.length - 1] === '') body.pop();
  const facts = ['Chords'];
  if (meta.key) facts.push(`Key: ${meta.key}`);
  if (meta.capo) facts.push(`Capo: ${meta.capo}`);
  if (meta.tempo) facts.push(`Tempo: ${meta.tempo}`);
  if (meta.time) facts.push(`Time: ${meta.time}`);
  const head = [[meta.title || 'Untitled', meta.artist].filter(Boolean).join(' - '), facts.join(' · ')];
  const foot = [meta.ccli && `CCLI Song # ${meta.ccli}`, meta.copyright && `© ${meta.copyright}`].filter(Boolean);
  return { ...meta, notes: found, text: [...head, '', ...body, ...(foot.length ? ['', ...foot] : [])].join('\n') + '\n' };
}

// "✎ Nate (handwritten): Woah" → { by: 'Nate', text: 'Woah' }
function noteOf(s) {
  const m = /^✎\s*([^:]{1,40}):\s*(.*)$/.exec(s);
  return m ? { by: m[1].replace(/\s*\(.*\)$/, '').trim(), text: m[2] } : { by: '', text: s.replace(NOTE, '').trim() };
}

/** Drops (notes: false) or keeps the ✎ note lines of ChordPro text. */
export const withoutNotes = (cho) => cho.split(/\r?\n/).filter((l) => !/^\s*(\{\s*(comment|c|ci|comment_italic)\s*:\s*)?✎/.test(l)).join('\n');

/* ---------- chart PDF → ChordPro ---------- */

const KNOWN = { VERSE: 'verse', CHORUS: 'chorus', BRIDGE: 'bridge', 'PRE-CHORUS': 'verse', PRECHORUS: 'verse' };
const fixText = (t) => t.replace(/(?<=\w)�(?=\w)/g, '’').replace(/�/g, '').replace(/\s+/g, ' ');

/**
 * pages: [{ items: [{ str, x, y, w, h }], notes: [{ by, text, y }] }], y measured down from the page top,
 * x and y the left and top of each piece of text, h its size. Returns ChordPro text, or null when the
 * pages don't read as a chord chart (fewer than 3 chord rows sitting over words).
 */
export function chartToChordPro(pages, { fileName = '' } = {}) {
  // one list, the pages stacked
  const items = [];
  const notes = [];
  pages.forEach((p, n) => {
    for (const it of p.items) if (it.str) items.push({ ...it, y: it.y + n * 10000 });
    for (const no of p.notes || []) notes.push({ ...no, y: no.y + n * 10000 });
  });
  if (!items.length) return null;
  const sizes = items.filter((i) => i.str.trim()).map((i) => Math.round(i.h)).sort((a, b) => a - b);
  const body = mode(sizes); // the size most text is (words and chords)
  const big = items.filter((i) => i.h >= body * 0.9).sort((a, b) => a.y - b.y);
  const rows = [];
  for (const it of big) {
    const row = rows[rows.length - 1];
    if (row && it.y - row.y0 <= body * 0.15) row.items.push(it);
    else rows.push({ y0: it.y, items: [it] });
  }
  // raised small text joins the piece of text that ends where it starts
  for (const s of items.filter((i) => i.h < body * 0.9 && i.h > body * 0.6).sort((a, b) => a.x - b.x)) {
    let host = null;
    for (const r of rows) {
      if (s.y < r.y0 - body * 0.6 || s.y > r.y0 + body * 0.2) continue;
      for (const it of r.items) if (Math.abs(it.x + it.w - s.x) < body * 0.2) host = it;
    }
    if (host) { host.str += s.str.trim(); host.w = s.x + s.w - host.x; }
  }
  for (const r of rows) { // pieces that touch are one word ("Eb2" + "/G")
    const list = [];
    for (const it of r.items.filter((i) => i.str.trim()).sort((a, b) => a.x - b.x)) {
      const prev = list[list.length - 1];
      if (prev && it.x - (prev.x + prev.w) < body * 0.1 && it.x >= prev.x + prev.w - body * 0.3 && !/\s$/.test(prev.str) && !/^\s/.test(it.str)) {
        prev.str += it.str;
        prev.w = it.x + it.w - prev.x;
      } else list.push({ ...it });
    }
    r.items = list;
  }
  const text = (r) => fixText(lineChars(r.items, body).map((c) => c.c).join(''));
  const pieces = (r) => r.items.flatMap((i) => (/^\(.*\)$/.test(i.str.trim()) ? [{ ...i, str: i.str.trim() }] : i.str.trim() ? splitPiece(i) : []));
  const chordRow = (r) => { const p = pieces(r); return p.length && p.every((t) => isChord(t.str) || /^[|:]+$/.test(t.str) || /^\(.*\)$/.test(t.str)) && p.some((t) => isChord(t.str)); };
  const left = Math.min(...rows.map((r) => r.items.find((i) => i.str.trim())?.x ?? 1e9));
  const header = (r) => {
    const t = text(r).trim();
    return /^[A-Z][A-Z0-9 \-/']{2,30}$/.test(t) && !chordRow(r) && r.items.find((i) => i.str.trim()).x < left + body * 0.5 ? t : '';
  };
  const firstHead = rows.findIndex((r) => header(r));
  if (firstHead < 0) return null;
  // the title block over the first section: title, writers, "Key - Bb | Tempo - 49 | Time - 6/8"
  const lines = textLines(items.filter((i) => i.y < rows[firstHead].y0 - 2));
  const meta = [];
  const title = lines.length ? lines.reduce((a, b) => (b.h > a.h ? b : a)) : null;
  if (title) meta.push(`{title: ${title.s}}`);
  let artist = '';
  let key = '';
  for (const l of lines) {
    const s = l.s;
    const k = /Key\s*[-:]\s*([A-G][#b]?m?)/i.exec(s);
    if (k) {
      key = k[1];
      meta.push(`{key: ${key}}`);
      const t = /Tempo\s*[-:]\s*(\d+)/i.exec(s); if (t) meta.push(`{tempo: ${t[1]}}`);
      const ts = /Time\s*[-:]\s*(\d+\/\d+)/i.exec(s); if (ts) meta.push(`{time: ${ts[1]}}`);
    } else if (l !== title && !artist && !/^\(/.test(s) && !/songselect/i.test(s)) artist = s;
  }
  if (artist) meta.splice(1, 0, `{artist: ${artist}}`);
  const capo = /\bcapo\s*(\d+)/i.exec(fileName);
  if (capo) meta.push(`{capo: ${capo[1]}}`);
  const small = textLines(items.filter((i) => i.h < body * 0.6 && i.y > rows[firstHead].y0)).map((l) => l.s);
  const ccli = small.map((s) => /CCLI Song\s*#\s*(\d+)/i.exec(s)).find(Boolean);
  if (ccli) meta.push(`{ccli: ${ccli[1]}}`);
  const copy = small.map((s) => /^(?:©|\(c\)|�)?\s*(\d{4}\s.+)$/i.exec(s.replace(/^[^\w(]+/, ''))).find(Boolean);
  if (copy) meta.push(`{copyright: ${copy[1].trim()}}`);

  const out = [...meta];
  let section = null;
  let chordRows = 0;
  const close = () => { if (section) out.push(`{end_of_${section}}`); section = null; };
  const pending = [...notes].sort((a, b) => a.y - b.y);
  const notesTo = (y) => { while (pending.length && pending[0].y <= y) { const n = pending.shift(); out.push(`{comment: ${NOTE} ${n.by ? n.by + ': ' : ''}${n.text}}`); } };
  for (let i = firstHead; i < rows.length; i++) {
    const r = rows[i];
    notesTo(r.y0 + body);
    const head = header(r);
    if (head) {
      close();
      out.push('');
      const kind = KNOWN[head.split(/\s+/)[0]];
      const name = head.toLowerCase().replace(/(^|[\s-])\w/g, (c) => c.toUpperCase());
      if (kind) { section = kind; out.push(`{start_of_${kind}: ${name}}`); } else out.push(`{comment: ${name}}`);
      continue;
    }
    if (chordRow(r)) {
      const next = rows[i + 1];
      const chords = pieces(r).filter((p) => !/^\(.*\)$/.test(p.str));
      const asides = pieces(r).filter((p) => /^\(.*\)$/.test(p.str)).map((p) => p.str);
      if (next && !chordRow(next) && !header(next) && next.y0 - r.y0 < body * 1.6 && text(next).trim()) {
        i++;
        chordRows++;
        out.push(placeChords(chords, lineChars(next.items, body)) +(asides.length ? '  ' + asides.join(' ') : ''));
      } else {
        out.push(chords.map((c) => (/^[|:]+$/.test(c.str) ? c.str : `[${c.str}]`)).join(' ') + (asides.length ? '  ' + asides.join(' ') : ''));
      }
      continue;
    }
    if (r.items.some((it) => it.h >= body * 0.9)) {
      const t = text(r).trim();
      if (t) out.push(/^\*/.test(t) ? `{comment_italic: ${t}}` : t);
    }
  }
  notesTo(Infinity);
  close();
  if (chordRows < 3) return null;
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

function mode(list) {
  const n = {};
  for (const v of list) n[v] = (n[v] || 0) + 1;
  return Number(Object.entries(n).sort((a, b) => b[1] - a[1])[0][0]);
}

// loose text (the title block, the small print) as lines: { y, h, s }, a space only where there's a real gap
function textLines(list) {
  const lines = [];
  for (const it of list.filter((i) => i.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x)) {
    const l = lines[lines.length - 1];
    if (l && Math.abs(it.y - l.y) < 2) l.items.push(it); else lines.push({ y: it.y, h: it.h, items: [it] });
  }
  return lines.map((l) => ({ y: l.y, h: Math.max(...l.items.map((i) => i.h)),   // pdf.js splits a letter off in small print ("C hris", "w orship"); a lone letter that isn't a word (a, I, O) is joined back
    s: fixText(lineChars(l.items, l.h * 2.5).map((c) => c.c).join('')).replace(/\b([B-HJ-NP-Zb-z]) (?=[a-z])/g, '$1').trim() }));
}

// a piece of text with spaces in it ("| Bb  |") as one piece per word, each at its share of the width
function splitPiece(it) {
  const per = it.w / Math.max(1, it.str.length);
  return [...it.str.matchAll(/\S+/g)].map((m) => ({ str: m[0], x: it.x + m.index * per, w: m[0].length * per }));
}

// a row's letters with their x, in order, with a space wherever pieces of text have a gap between them
// (pdf.js leaves out the spaces at the ends of pieces)
function lineChars(items, body) {
  const chars = [];
  let end = -Infinity;
  for (const it of [...items].sort((a, b) => a.x - b.x)) {
    if (chars.length && it.x - end > body * 0.1 && chars[chars.length - 1].c !== ' ') chars.push({ c: ' ', x: end });
    const per = it.w / Math.max(1, it.str.length);
    [...it.str].forEach((c, k) => chars.push({ c, x: it.x + k * per }));
    end = Math.max(end, it.x + it.w);
  }
  return chars;
}

// chords into the words line: each before the letter under its left edge
function placeChords(chords, chars) {
  let line = '';
  let j = 0;
  for (const ch of chords) {
    if (/^[|:]+$/.test(ch.str)) continue;
    while (j < chars.length && chars[j].x < ch.x - 1.5) line += chars[j++].c;
    line += `[${ch.str}]`;
  }
  line += chars.slice(j).map((c) => c.c).join('');
  return fixText(line).trim()
    .replace(/(\w) - ((?:\[[^\]]+\])?)\s*(?=\w)/g, '$1$2') // af - [Eb2/G]flictions → af[Eb2/G]flictions
    .replace(/ {2,}/g, ' ');
}

/** Reads a PDF's text with pdf.js (lib) and returns ChordPro, or null when it isn't a chord chart. */
export async function pdfToChordPro(lib, buf, { fileName = '' } = {}) {
  const doc = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const view = page.view; // [x0, y0, x1, y1], y up
      const tc = await page.getTextContent();
      const items = tc.items.filter((i) => 'str' in i).map((i) => {
        const h = Math.hypot(i.transform[2], i.transform[3]) || i.height;
        // pdf.js gives the baseline; the top is about 0.8 of the size above it
        return { str: i.str, x: i.transform[4] - view[0], y: view[3] - i.transform[5] - h * 0.8, w: i.width, h };
      });
      const notes = [];
      for (const a of await page.getAnnotations()) {
        if (['Link', 'Widget', 'Popup'].includes(a.subtype)) continue;
        const said = (a.contentsObj?.str || a.contents || '').trim();
        const by = (a.titleObj?.str || a.title || '').trim();
        const text = said || (a.subtype === 'Ink' ? '(drawing)' : a.subtype === 'Highlight' ? '(highlight)' : '');
        if (text) notes.push({ by, text, y: view[3] - (a.rect?.[3] ?? view[3]) });
      }
      pages.push({ items, notes });
      if (n === 1 && !items.length) return null; // a picture-only PDF (UG's prints): not a chart
    }
  } finally {
    doc.destroy();
  }
  return chartToChordPro(pages, { fileName });
}
