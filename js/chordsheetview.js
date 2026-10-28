// The chord sheet as it is read on screen. A sheet is stored as chords over the words (the one format
// the whole app reads); here it becomes ChordPro-style pieces, each chord tied to the letters it is
// played on ("thou" + [G]"ghts"), so a line can wrap at any word and the chords stay on their words.
// ChordPro written inline is read too, with [G] or {G}. A repeated section (a chorus written out
// again) is shown once, and its repeats as one-line markers ("↻ Chorus ×2"). Pure (no DOM): tested in
// tests/chordsheetview.test.mjs.

// A chord name: G, Em, C#m7, G7sus, F2(no3), D/F#, also in brackets "(G)" for an optional one.
export const CHORD = /^\(?[A-G][#b]?(m|maj|min|dim|aug|sus|add|M)?\d*(sus\d?|add\d+|b\d+|#\d+|\((?:no|add)?\d+\))*(\/[A-G][#b]?)?\)?$/;
export const TAB_LINE = /^\s*[A-Ga-g]?[#b]?\s*[|:]?[-0-9|hpbrx/\\~^().<>*=sv ]*-{3,}[-0-9|hpbrx/\\~^().<>*=sv ]*$/;
// Also on a chord line: repeats and bar marks ("G  C/G  (x2)", "| G | D |", "N.C.").
const EXTRA = /^(\(?x\d+\)?|\(?\d+x\)?|\|+|-+|N\.?C\.?)$/i;

// Ultimate Guitar's raw format wraps chords and tabs in [ch]..[/ch] and [tab]..[/tab].
export const cleanTabText = (text) => text.replace(/\[\/?(ch|tab)\]/g, '').replace(/\r\n?/g, '\n');

/** The tokens of a line that holds only chords (and repeat or bar marks), else null. */
export const chordTokens = (line) => {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  return tokens.some((t) => CHORD.test(t)) && tokens.every((t) => CHORD.test(t) || EXTRA.test(t)) ? tokens : null;
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tidy = (c) => c.replace(/♯/g, '#').replace(/♭/g, 'b');
const core = (c) => c.replace(/[()]/g, '');

/* ---------- chords tied to words ---------- */

/**
 * ChordPro written inline ("Seven P.M. thou[G]ghts in my {D}home") as pieces [{ c?, t }]: a chord and
 * the text up to the next chord. Brackets that hold no chord ([x2], [Verse]) stay text.
 */
export function inlinePieces(line) {
  const marks = [];
  for (const m of line.matchAll(/\[([^\]]*)\]|\{\s*([A-G][^{}\s]*)\s*\}/g)) {
    const name = tidy((m[1] ?? m[2]).trim());
    if (CHORD.test(name)) marks.push({ name, at: m.index, end: m.index + m[0].length });
  }
  const out = [];
  if (!marks.length || marks[0].at > 0) out.push({ t: line.slice(0, marks.length ? marks[0].at : line.length) });
  marks.forEach((m, i) => out.push({ c: m.name, t: line.slice(m.end, marks[i + 1]?.at ?? line.length) }));
  return out;
}

/**
 * A chord line over a words line ("G      C" over "Amazing grace how") as pieces: each chord takes the
 * words from the column it stands over. A chord over a gap goes to the word just after it.
 */
export function overPieces(chordLine, wordsLine) {
  const words = wordsLine.replace(/\s+$/, '');
  const chords = [];
  const extras = [];
  for (const m of chordLine.matchAll(/\S+/g)) {
    if (!CHORD.test(m[0])) { extras.push(m[0]); continue; }
    let at = m.index;
    if (at < words.length && words[at] === ' ') {
      let k = at;
      while (k < words.length && words[k] === ' ') k++;
      if (k - at <= 3 && k < words.length) at = k;
    }
    chords.push({ c: tidy(m[0]), at: Math.max(at, chords.length ? chords[chords.length - 1].at : 0) });
  }
  const line = words.padEnd(chords.length ? chords[chords.length - 1].at : 0); // a chord past the words stands apart
  const out = [];
  if (!chords.length || chords[0].at > 0) out.push({ t: line.slice(0, chords.length ? chords[0].at : line.length) });
  chords.forEach((ch, i) => out.push({ c: ch.c, t: line.slice(ch.at, chords[i + 1]?.at ?? line.length) }));
  if (extras.length) out.push({ t: `  ${extras.join(' ')}` });
  return out;
}

/** Pieces as words: [[{ c?, t }…]…], split at spaces; a chord between spaces is a word of its own. */
export function toWords(pieces) {
  const words = [];
  let word = null;
  const end = () => { if (word) words.push(word); word = null; };
  for (const p of pieces) {
    if (p.c) (word ||= []).push({ c: p.c, t: '' });
    for (const ch of p.t) {
      if (/\s/.test(ch)) { end(); continue; }
      word ||= [];
      const last = word[word.length - 1];
      if (last) last.t += ch; else word.push({ t: ch });
    }
  }
  end();
  return words;
}

/* ---------- the sheet's lines and sections ---------- */

const HEADER = /^\s*\[([^\]]{1,40})\]\s*$/;
const header = (line) => { const m = HEADER.exec(line); return m && !CHORD.test(tidy(m[1].trim())) ? m[1].trim() : null; };
const isTab = (line) => TAB_LINE.test(line) && /-{3,}/.test(line);

/**
 * The sheet's body (chords over words, or ChordPro, or both) as sections:
 * [{ name, lines: [{ t: 'w', words } | { t: 'c', items } | { t: 'tab' | 'pre' | 'note' | 'text', s }] }].
 * A [Name] line starts a section; so does a blank line (its name is ''), unless it only follows a name.
 */
export function readSections(text) {
  const lines = cleanTabText(String(text || '')).split('\n').map((l) => l.replace(/\s+$/, ''));
  const blocks = [];
  let cur = null;
  const add = (line) => { if (!cur) { cur = { name: '', lines: [] }; blocks.push(cur); } cur.lines.push(line); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { if (cur?.lines.length) cur = null; continue; }
    const name = header(line);
    if (name !== null) { cur = { name, lines: [] }; blocks.push(cur); continue; }
    if (line.trim().startsWith('✎')) { add({ t: 'note', s: line.trim() }); continue; }
    if (isTab(line)) { add({ t: 'tab', s: line }); continue; }
    const tokens = chordTokens(line);
    if (tokens) {
      const next = lines[i + 1];
      const words = next && next.trim() && !chordTokens(next) && header(next) === null && !isTab(next) && !next.trim().startsWith('✎');
      if (words) { i++; add({ t: 'w', words: toWords(overPieces(line, next)) }); continue; }
      add({ t: 'c', items: tokens.map((s) => (CHORD.test(s) ? { c: tidy(s) } : { x: s })) });
      continue;
    }
    const pieces = inlinePieces(line);
    if (pieces.some((p) => p.c)) { add({ t: 'w', words: toWords(pieces) }); continue; }
    // spacing that matters (a diagram, a pattern) stays as written
    add(/\S {3,}\S/.test(line.trim()) ? { t: 'pre', s: line } : { t: 'text', s: line.trim() });
  }
  return blocks;
}

const squash = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const lineKey = (l) => (l.t === 'w' ? l.words.map((w) => w.map((p) => `${p.c || ''}|${squash(p.t)}`).join('')).join(' ')
  : l.t === 'c' ? l.items.map((x) => x.c || x.x).join(' ') : squash(l.s));
const blockKey = (b) => b.lines.map(lineKey).join('\n');

/* ---------- notes: tied to a line (or a section's name) by what it says, so they stay put when the sheet is edited elsewhere ---------- */

export const NOTE_COLORS = ['yellow', 'blue', 'green', 'pink'];
export const keyHash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
};
/** The id a note holds for a line (the same line written twice has the same id), or a section's name. */
export const lineHash = (l) => keyHash(lineKey(l));
export const sectionHash = (name) => keyHash(`§${squash(name)}`);
/** The line as plain words (what a note says it was about). */
export const lineLabel = (l) => {
  const s = l.t === 'w' ? l.words.map((w) => w.map((p) => p.t).join('')).join(' ') : l.t === 'c' ? l.items.map((x) => x.c || x.x).join(' ') : l.s || '';
  const t = s.replace(/\s+/g, ' ').trim() || (l.t === 'w' ? l.words.flatMap((w) => w.filter((p) => p.c).map((p) => p.c)).join(' ') : '');
  return t.length > 40 ? `${t.slice(0, 38).trim()}…` : t;
};
const lyricPeek = (b) => {
  const l = b.lines.find((x) => x.t === 'w' || x.t === 'text');
  const s = l ? (l.t === 'w' ? l.words.map((w) => w.map((p) => p.t).join('')).join(' ') : l.s) : '';
  return s.length > 30 ? `${s.slice(0, 28).trim()}…` : s;
};

/**
 * The sections with repeats folded: [{ name, lines, times, key }] in full, and
 * [{ marker: true, name, of, times, key, peek }] for a section whose lines were already shown.
 * Two in a row with the same name become one with ×2. A name alone with no lines ([Chorus] after the
 * chorus was written out) counts as a repeat too. collapse = false keeps every section in full.
 */
export function foldRepeats(blocks, collapse = true) {
  if (!collapse) return blocks.map((b) => ({ ...b, times: 1, key: blockKey(b) }));
  const items = [];
  const seen = new Map(); // lines → the name of the first section that has them
  const named = new Map(); // lower-case name → the first section's name, for sections that have lines
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  for (const b of blocks) {
    const empty = !b.lines.length;
    const key = empty ? `ref:${b.name.toLowerCase()}` : blockKey(b);
    const prev = items[items.length - 1];
    let first = null;
    if (empty) { if (b.name && named.has(b.name.toLowerCase())) first = named.get(b.name.toLowerCase()); }
    else if (seen.has(key) && (b.lines.length >= 2 || (b.name && same(seen.get(key), b.name)))) first = seen.get(key);
    if (first === null) {
      items.push({ ...b, times: 1, key });
      if (!empty) { seen.set(key, b.name); if (b.name && !named.has(b.name.toLowerCase())) named.set(b.name.toLowerCase(), b.name); }
      continue;
    }
    if (prev && same(prev.name, b.name) && (prev.key === key || empty)) { prev.times++; continue; }
    items.push({ marker: true, name: b.name, of: first, times: 1, key, peek: b.name ? '' : lyricPeek(b) });
  }
  return items;
}

/** Every chord name of the sections in order, without optional-chord brackets. */
export function chordsOf(blocks) {
  return blocks.flatMap((b) => b.lines.flatMap((l) => (l.t === 'w' ? l.words.flatMap((w) => w.filter((p) => p.c).map((p) => core(p.c)))
    : l.t === 'c' ? l.items.filter((x) => x.c).map((x) => core(x.c)) : [])));
}

/* ---------- capo ---------- */

/**
 * The shapes to play. written: the capo the sheet was written with (its chords are shapes for it),
 * capo: the capo you chose (null: the sheet's own), shift: your transpose. move: semitones to move each
 * written chord by to get the shape to play; the key it sounds in moves by shift only.
 */
export function capoPlan({ written = 0, capo = null, shift = 0 } = {}) {
  const use = capo == null ? written : capo;
  return { capo: use, move: shift + written - use };
}

/* ---------- HTML ---------- */

const chordHtml = (c, rename, played) => {
  const name = core(c);
  const shown = rename ? rename(name) : name;
  return `<span class="chord" data-chord="${esc(played ? played(name) : name)}">${esc(c.startsWith('(') ? `(${shown})` : shown)}</span>`;
};

const wordHtml = (word, rename, played) => {
  if (!word.some((p) => p.c)) return esc(word.map((p) => p.t).join(''));
  return `<span class="w">${word.map((p) => (p.c
    ? `<span class="cs">${chordHtml(p.c, rename, played)}<span class="ly">${esc(p.t)}</span></span>`
    : `<span class="ly">${esc(p.t)}</span>`)).join('')}</span>`;
};

const noteColor = (n) => (NOTE_COLORS.includes(n?.color) ? n.color : 'yellow');
const noteHtml = (n) => (n.text ? `<div class="an c-${noteColor(n)}" data-an="${esc(n.k)}"><span class="ai">✎</span> ${esc(n.text)}</div>` : '');

// notes: Map of line id → { k, text, color }; a line with one is tinted, and its words sit under it
const lineHtml = (l, rename, played, notes) => {
  if (l.t === 'note') return `<div class="ln note">${esc(l.s)}</div>`;
  const k = lineHash(l);
  const n = notes?.get(k);
  const at = ` data-k="${k}"${n ? ` data-an="${esc(n.k)}"` : ''}`;
  const hl = n ? ` hl c-${noteColor(n)}` : '';
  let html;
  if (l.t === 'w') {
    const hasChord = l.words.some((w) => w.some((p) => p.c));
    html = `<div class="ln${hasChord ? ' hc' : ''}${hl}"${at}>${l.words.map((w) => wordHtml(w, rename, played)).join(' ')}</div>`;
  } else if (l.t === 'c') html = `<div class="ln co${hl}"${at}>${l.items.map((x) => (x.c ? chordHtml(x.c, rename, played) : `<span class="x">${esc(x.x)}</span>`)).join(' ')}</div>`;
  else if (l.t === 'tab') html = `<div class="pre tab-line${hl}"${at}>${esc(l.s)}</div>`;
  else if (l.t === 'pre') html = `<div class="pre${hl}"${at}>${esc(l.s)}</div>`;
  else html = `<div class="ln${hl}"${at}>${esc(l.s)}</div>`;
  return n ? html + noteHtml(n) : html;
};

/**
 * Sections and markers as HTML. rename: chord name → name to show; played: → name for its shapes;
 * notes: Map of id → note (see lineHash); orphans: notes whose line is gone, listed at the end.
 */
export function viewHtml(items, { rename = null, played = null, notes = null, orphans = [] } = {}) {
  return items.map((it) => {
    if (it.marker) {
      const label = it.name || (it.of ? `Repeat of ${it.of}` : 'Repeat');
      const note = it.name && it.of && it.of.toLowerCase() !== it.name.toLowerCase() ? ` <span class="of">same as ${esc(it.of)}</span>`
        : it.peek ? ` <span class="of">“${esc(it.peek)}”</span>` : '';
      return `<div class="tx-rep"><span class="ic">↻</span> ${esc(label)}${it.times > 1 ? ` <span class="rep">×${it.times}</span>` : ''}${note}</div>`;
    }
    const sk = it.name ? sectionHash(it.name) : '';
    const sn = sk && notes?.get(sk);
    const head = it.name || it.times > 1
      ? `<div class="sh${sn ? ` hl c-${noteColor(sn)}` : ''}"${sk ? ` data-k="${sk}"${sn ? ` data-an="${esc(sn.k)}"` : ''}` : ''}>${esc(it.name)}${it.times > 1 ? `${it.name ? ' ' : ''}<span class="rep">×${it.times}</span>` : ''}</div>${sn ? noteHtml(sn) : ''}` : '';
    return `<section class="tx-sec">${head}${it.lines.map((l) => lineHtml(l, rename, played, notes)).join('')}</section>`;
  }).join('') + (orphans.length
    ? `<section class="tx-sec tx-orphans"><div class="sh">Notes on lines you changed</div>${orphans.map((n) => `<div class="an c-${noteColor(n)}" data-an="${esc(n.k)}"><span class="ai">✎</span> ${n.label ? `<i>${esc(n.label)}</i> · ` : ''}${esc(n.text) || 'highlight'}</div>`).join('')}</section>` : '');
}
