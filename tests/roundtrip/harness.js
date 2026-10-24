// The page side of the round-trip test (driven by roundtrip.py in headless Chromium):
//  1. loadSong: a Guitar Pro file or alphaTex whose content is known
//  2. renderTrack: one tab track drawn by alphaTab, one picture per line, the way UG's Tablature view
//     looks (tab staff with rhythm stems under it, no time signature), then laid out on A4 pages like
//     the UG helper's PAGES_JS (12 mm margins, the score 5 mm in, title / artist / "Track · Tuning:")
//  3. readSong: those PDFs through the real importer (pdfToTab, then ugToAlphaTex to combine them), and
//     the result scored against the original
import { pdfToTab } from '../../js/pdftab.js';
import { ugToAlphaTex } from '../../js/ugtab.js';
import { compareTracks } from './compare.js';

const at = window.alphaTab;
let song = null; // { score, title, artist }

// UG's Tablature view shows no time signature, and alphaTab always draws one on a tab-only staff.
// Its digits are the music font's timeSig glyphs (U+E080-E08F), so those are simply not drawn.
// (Multi-bar rests use the same digits, but alphaTab only draws those when asked to.)
const fillText = CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
  if (typeof text === 'string' && /^[-]+$/.test(text)) return;
  // UG's TAB clef is bold; the music font's is thin
  if (text === '' || text === '') {
    this.save(); this.lineWidth = 1.6; this.strokeStyle = this.fillStyle; this.strokeText(text, ...rest); this.restore();
  }
  return fillText.call(this, text, ...rest);
};

const fontReady = (async () => {
  const f = new FontFace('Bravura', 'url(../../vendor/alphatab/font/Bravura.woff2)');
  document.fonts.add(await f.load());
})();

// UG's rhythm stems start under the staff (0.6-0.8 spaces below its last line), and a half note's is
// about 1 space tall. alphaTab runs its stems up between the fret numbers and draws half notes like
// quarters, so its tab renderer's stem painter is replaced. The class isn't exported: it is reached
// through alphaTab's list of bar renderer factories.
let stemsPatched = false;
function patchStems(renderer, bar) {
  if (stemsPatched) return;
  for (const f of at.Environment.defaultRenderers || []) {
    let one;
    try { one = f.create(renderer, bar); } catch { continue; }
    const proto = Object.getPrototypeOf(one);
    if (typeof proto.paintBeamingStem !== 'function' || !('rhythmMode' in one)) continue;
    // (y relative to the bar renderer) the stems' top, 0.7 spaces under the last line, and their foot, 2 spaces lower
    const stemTop = (r) => r.getLineY(r.bar.staff.tuning.length - 1) + 0.7 * r.lineOffset;
    const stemFoot = (r) => stemTop(r) + 2.0 * r.lineOffset;
    proto.calculateBeamY = function () { return stemFoot(this); };
    proto.getFlagBottomY = function () { return stemFoot(this); };
    proto.paintBeamingStem = function (beat, cy, x, topY, bottomY, canvas) {
      const top = cy + stemTop(this);
      const bot = beat.duration === at.model.Duration.Half ? top + 1.0 * this.lineOffset : Math.max(topY, bottomY);
      if (bot > top) canvas.fillRect(x, top, this.smuflMetrics.stemThickness, bot - top);
    };
    stemsPatched = true;
    return;
  }
  throw new Error("alphaTab's tab renderer wasn't found: the stem patch in harness.js needs updating");
}

const b64bytes =(b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function settings() {
  const s = new at.Settings();
  s.core.engine = 'html5';
  s.core.enableLazyLoading = false;
  s.core.useWorkers = false;
  s.display.layoutMode = at.LayoutMode.Page;
  s.display.staveProfile = at.StaveProfile.Tab;
  s.notation.rhythmMode = at.TabRhythmMode.ShowWithBars; // beams (ShowWithBeams draws flags)
  s.display.resources.smuflFontFamilyName = 'Bravura';
  // UG's fret numbers are bold
  s.display.resources.tablatureFont.weight = at.model.FontWeight.Bold;
  // black bar numbers and darker staff lines (alphaTab's are red and light grey)
  s.display.resources.barNumberColor = new at.model.Color(0, 0, 0, 255);
  s.display.resources.staffLineColor = new at.model.Color(90, 90, 90, 255);
  const E = at.NotationElement;
  for (const e of [E.ScoreTitle, E.ScoreSubTitle, E.ScoreArtist, E.ScoreAlbum, E.ScoreWords, E.ScoreMusic,
    E.ScoreWordsAndMusic, E.ScoreCopyright, E.GuitarTuning, E.TrackNames, E.ChordDiagrams, E.EffectChordNames, E.EffectDynamics]) s.notation.elements.set(e, false);
  return s;
}

// alphaTex -> score; a parse error says what alphaTab's diagnostics say
function texScore(text) {
  const imp = new at.importer.AlphaTexImporter();
  imp.initFromString(text, new at.Settings());
  try {
    return imp.readScore();
  } catch (e) {
    const inner = e.inner || e.innerError || e.cause;
    throw new Error(inner ? String(inner).replace(/\s+/g, ' ').slice(0, 600) : e.message);
  }
}

/** b64: the file's bytes; kind: 'gp' (any Guitar Pro file) or 'tex' (alphaTex). */
window.loadSong = (b64, kind) => {
  const bytes = b64bytes(b64);
  let score;
  if (kind === 'tex') {
    score = texScore(new TextDecoder().decode(bytes));
  } else {
    score = at.importer.ScoreLoader.loadScoreFromBytes(bytes, new at.Settings());
  }
  song = { score, title: score.title || '', artist: score.artist || '' };
  return {
    title: song.title,
    artist: song.artist,
    tempo: score.tempo,
    bars: score.masterBars.length,
    tracks: score.tracks.map((t, i) => {
      const st = t.staves[0];
      return { index: i, name: t.name, strings: st.tuning.length, tab: !st.isPercussion && st.tuning.length > 0, capo: st.capo, tuning: tuningName(st.tuning) };
    }),
  };
};

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
// alphaTab lists the strings highest first; UG writes them lowest first
const tuningName = (t) => [...t].reverse().map((p) => NAMES[p % 12]).join(' ');

/** Draws one track's lines and lays them out on pages (Letter by default); the caller then prints the page to PDF. */
window.renderTrack = async (index, { width = 1000, scale = 1, paper = 'letter' } = {}) => {
  await fontReady;
  await document.fonts.ready;
  const s = settings();
  s.display.scale = scale;
  const r = new at.rendering.ScoreRenderer(s);
  r.width = width;
  patchStems(r, song.score.tracks[index].staves[0].bars[0]);
  const lines = [];
  let error = null;
  // the lines of music (the "rendered by alphaTab" note under the score belongs to no bar)
  r.partialRenderFinished.on((e) => { if (e.renderResult && e.firstMasterBarIndex >= 0) lines.push({ y: e.y, canvas: e.renderResult }); });
  r.error.on((e) => { error = e; });
  const done = new Promise((ok) => r.renderFinished.on(() => ok()));
  r.renderScore(song.score, [index]);
  await Promise.race([done, new Promise((ok) => setTimeout(ok, 20000))]);
  if (error) throw error;
  lines.sort((a, b) => a.y - b.y);
  const t = song.score.tracks[index], st = t.staves[0];
  const info = [t.name, `Tuning: ${tuningName(st.tuning)}`, ...(st.capo ? [`Capo: ${st.capo}`] : [])].join('  ·  ');
  layOut(lines.map((l) => l.canvas), [song.title, song.artist, info], paper);
  await Promise.all([...document.images].map((i) => i.decode()));
  return { lines: lines.length, pages: document.querySelectorAll('.pg').length };
};

// The page layout of PAGES_JS in tools/ug_collect.py: 12 mm margins, the score 5 mm in from each side.
// The area filled on each paper size (the page less its margins); PAGES_JS uses A4's.
const PAPER = { a4: { size: 'A4', w: 186, h: 272 }, letter: { size: 'letter', w: 191.9, h: 254.4 } };
function layOut(canvases, head, paper) {
  document.body.textContent = '';
  const P = PAPER[paper] || PAPER.letter;
  const pageW = P.w, pageH = P.h, side = 5, k = (pageW - 2 * side) / pageW;
  const st = document.createElement('style');
  st.textContent = '@page{size:' + P.size + ';margin:12mm}body{margin:0;font-family:Georgia,"Times New Roman",serif;color:#000;background:#fff}'
    + '.pg{height:' + pageH + 'mm;overflow:hidden;break-after:page}.pg:last-child{break-after:auto}'
    + 'h1{font-size:22pt;text-align:center;margin:0 0 1mm;font-weight:normal}.sub{text-align:center;font-size:13pt;margin:0 0 3mm}'
    + '.info{font-size:10pt;margin:0 0 2mm}.pic{overflow:hidden;margin:0 ' + side + 'mm}img{display:block;width:' + (pageW - 2 * side) + 'mm}';
  document.body.append(st);
  let page = document.createElement('div'); page.className = 'pg'; document.body.append(page);
  for (const [t, text] of [['h1', head[0]], ['p.sub', head[1]], ['p.info', head[2]]]) {
    if (!text) continue;
    const [tag, cls] = t.split('.'); const el = document.createElement(tag); if (cls) el.className = cls; el.textContent = text; page.append(el);
  }
  const mmOf = (px) => px * 25.4 / 96;
  let used = page.lastChild ? mmOf(page.lastChild.getBoundingClientRect().bottom - page.getBoundingClientRect().top) + 2 : 0;
  for (const c of canvases) {
    const mm = pageW / c.width; // mm per picture pixel, as PAGES_JS sets it
    const hh = Math.min(c.height * mm * k, pageH);
    const box = document.createElement('div'); box.className = 'pic'; box.style.height = hh + 'mm';
    // a white backing: an alphaTab canvas is transparent where nothing is drawn
    const w = document.createElement('canvas'); w.width = c.width; w.height = c.height;
    const g = w.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w.width, w.height); g.drawImage(c, 0, 0);
    const img = document.createElement('img'); img.src = w.toDataURL('image/png');
    box.append(img);
    if (used + hh > pageH && used > 0) { page = document.createElement('div'); page.className = 'pg'; document.body.append(page); used = 0; }
    page.append(box); used += hh;
  }
}

/**
 * Reads a song's PDFs back with the importer and scores them against the original tracks.
 * parts: [{ b64, index }], one PDF per track. Each part is scored on its own (pdfToTab's alphaTex),
 * and, with two or more parts, as the app combines them (importPdfParts in js/app.js:
 * ugToAlphaTex(parts[0].strips, { extra: the other parts }), every part cut or padded to the first's bars).
 */
window.readSong = async (parts, opts = {}) => {
  const read = [];
  for (const p of parts) {
    const t0 = performance.now();
    const t = song.score.tracks[p.index];
    // one at a time: two pdfToTab runs at once share the lyric reader
    const r = await pdfToTab(b64bytes(p.b64).buffer, () => {}, { lyrics: false, dynamics: false, bass: t.staves[0].tuning.length === 4 });
    const res = { ms: Math.round(performance.now() - t0), tex: r.tex || '' };
    if (!r.tex) res.error = `the importer found no tab (how: ${r.how})`;
    else {
      try { Object.assign(res, compareTracks(song.score, p.index, texScore(r.tex), 0, opts)); } catch (e) { res.error = `alphaTab couldn't read the importer's alphaTex: ${e.message}`; }
    }
    read.push({ ...p, name: t.name, program: t.playbackInfo.program, strips: r.strips, res });
  }
  const out = { tracks: read.map((x) => x.res), together: null };
  const ok = read.filter((x) => x.strips?.length);
  if (parts.length > 1 && ok.length) {
    const made = ugToAlphaTex(ok[0].strips, { title: song.title, name: ok[0].name, program: ok[0].program, extra: ok.slice(1).map(({ name, program, strips }) => ({ name, program, strips })) });
    let got = null, error = null;
    try { got = made ? texScore(made.tex) : null; } catch (e) { error = `alphaTab couldn't read the combined alphaTex: ${e.message}`; }
    out.together = ok.map((x, k) => (got ? compareTracks(song.score, x.index, got, k, opts) : { error: error || 'ugToAlphaTex combined nothing' }));
    out.togetherTex = made?.tex || '';
  }
  return out;
};
