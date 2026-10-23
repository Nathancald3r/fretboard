// Reads the lyric line printed under a Tab Pro staff with Tesseract (vendored, runs offline),
// giving each syllable and where it starts, so it can be attached to the note it is sung on.

let worker = null;
let failed = false;

async function getWorker() {
  if (failed) return null;
  if (!worker) {
    try {
      const T = (await import('../vendor/tesseract/tesseract.esm.min.js')).default;
      const dir = new URL('../vendor/tesseract/', import.meta.url).href;
      worker = await T.createWorker('eng', 1, { workerPath: dir + 'worker.min.js', corePath: dir, langPath: dir, gzip: true, workerBlobURL: false });
      await worker.setParameters({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '1' });
    } catch {
      failed = true;
      worker = null;
    }
  }
  return worker;
}

export async function closeLyricReader() {
  const w = worker;
  worker = null;
  failed = false;
  if (w) await w.terminate().catch(() => {});
}

const K = 4; // the line is read at 4x the size the staff was found at
const DASH = /^[-\u2010-\u2015_]$/;

/**
 * @param page pdf.js page, scale the scale the staff was found at, st the staff, limitY the lowest row to read
 * @returns {Promise<{ x: number, x1: number, text: string }[]>} syllables left to right ("tea-" when a word goes on)
 */
export async function readLyricLine(page, scale, st, limitY) {
  const wk = await getWorker();
  if (!wk) return [];
  const x0 = Math.round(st.x0 - 10), x1 = Math.round(st.x1 + 10);
  const y0 = Math.round(st.ys[st.ys.length - 1] + 2.9 * st.u), y1 = Math.round(Math.min(st.ys[st.ys.length - 1] + 4.9 * st.u, limitY));
  if (y1 - y0 < 1.2 * st.u) return [];
  const canvas = document.createElement('canvas');
  canvas.width = (x1 - x0) * K;
  canvas.height = (y1 - y0) * K;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: scale * K }), transform: [1, 0, 0, 1, -x0 * K, -y0 * K], intent: 'print' }).promise;
  let words;
  try { words = (await wk.recognize(canvas, {}, { blocks: true })).data.words || []; } catch { return []; }
  // text that starts low in the crop is the next strip's section name poking in (the lone
  // hyphens between syllables sit lower than the letters, so they are always kept)
  return syllables(words.filter((w) => w.bbox.y0 < 0.45 * canvas.height || isDash(w)), x0);
}

// Common misreads in this font: the word "I" read as "1", "|", "l" or "[I"; a stray capital
// stuck to the front of a word ("KE-very").
function fixWord(w) {
  const sym = (w.symbols || []).filter((s) => !/^[\[\]()]$/.test(s.text));
  if (sym.length === 1 && /^[1|lI]$/.test(sym[0].text) && !isDash({ symbols: sym, text: '' })) {
    return { ...w, text: 'I', confidence: Math.max(w.confidence, 60), symbols: [{ ...sym[0], text: 'I' }] };
  }
  if (w.confidence < 70 && sym.length > 3 && /^[A-Z]{2}[-‐-―a-z]/.test(sym.map((s) => s.text).join(''))) {
    return { ...w, text: w.text.slice(1), symbols: sym.slice(1) };
  }
  // "O" read as a zero ("0-pened")
  if (sym.some((s) => s.text === '0') && !/[1-9]/.test(w.text)) {
    const fixed = sym.map((s) => (s.text === '0' ? { ...s, text: 'O' } : s));
    return { ...w, text: fixed.map((s) => s.text).join(''), symbols: fixed };
  }
  return sym.length === (w.symbols || []).length ? w : { ...w, text: sym.map((s) => s.text).join(''), symbols: sym };
}

const isDash = (w) => w.symbols?.length > 0 && w.symbols.every((s) => DASH.test(s.text) || /[|—–~]/.test(s.text));
// a word that reads as lyrics: letters, with hyphens / dashes between syllables and light punctuation
const WORDLIKE = /^[-‐-―]?[A-Za-z'’]+([-‐-―]+[A-Za-z'’]+)*[-‐-―]?[,.!?;:]?$/;

/** Tesseract words (with letter boxes) -> syllables; exported for tests. */
export function syllables(words, xOffset = 0) {
  const out = [];
  const px = (v) => v / K + xOffset;
  const sorted = [...words].map(fixWord).sort((a, b) => a.bbox.x0 - b.bbox.x0);
  const lettered = sorted.filter((w) => !isDash(w) && w.symbols?.some((s) => /[A-Za-z]/.test(s.text)));
  const marks = sorted.filter((w) => !isDash(w)).length;
  // Real lyric words: sure ones, and unsure ones that still look like a word (Tesseract is
  // often unsure of a syllable split by long dashes, e.g. "vic—-to—-ry", yet reads it right).
  const real = lettered.filter((w) => w.confidence >= 55 || (w.confidence >= 20 && WORDLIKE.test(w.text)));
  // a strip with no lyrics reads as scattered marks (bar numbers, beams, the staff): skip it
  const clean = lettered.filter((w) => w.confidence >= 55 && WORDLIKE.test(w.text) && /[a-z]{2}/.test(w.text)).length;
  if (real.length < 2 || clean < 0.5 * marks) return [];
  for (const w of sorted) {
    if (isDash(w)) { if (out.length) out[out.length - 1].joined = true; continue; }
    if (!real.includes(w)) continue;
    let cur = null;
    for (const s of w.symbols) {
      if (DASH.test(s.text) || /[—–]/.test(s.text)) { if (cur) cur.joined = true; else if (out.length) out[out.length - 1].joined = true; cur = null; continue; }
      if (!/[A-Za-z0-9'’,.!?;:]/.test(s.text)) continue;
      if (!cur) { cur = { x: px(s.bbox.x0), x1: px(s.bbox.x1), text: '', joined: false }; out.push(cur); }
      cur.text += s.text === '’' ? "'" : s.text;
      cur.x1 = px(s.bbox.x1);
    }
  }
  // Stray marks (a beam, a bar number) read as one or two odd letters. A single letter stays
  // when it is a word (I, a, O) or part of one ("E-" of "E-very", "t-" of "bat-tle").
  const kept = out.filter((s, i) => s.text && /[A-Za-z]/.test(s.text) && !/\d/.test(s.text) && (s.text.length > 1
    || /^[IaAO]$/.test(s.text) || s.joined || out[i - 1]?.joined));
  if (kept.length < 3) return [];
  return kept.map((s) => ({ x: s.x, x1: s.x1, text: s.joined ? s.text + '-' : s.text }));
}

/**
 * Every word printed in a box of the page (the marks between two tab staves on a "Notation"
 * page: dynamics such as mf, words such as "w/sustainer"). The long staff lines are wiped first,
 * as they would otherwise run through the words.
 * @returns {Promise<{ text: string, conf: number, x0: number, x1: number, y0: number, y1: number }[]>} in page pixels at scale
 */
export async function readWords(page, scale, x0, y0, x1, y1, { K = 4, psm = '11', chars = '', wipe = [], lines = true } = {}) {
  const wk = await getWorker();
  if (!wk || x1 - x0 < 10 || y1 - y0 < 6) return [];
  [x0, y0, x1, y1] = [x0, y0, x1, y1].map(Math.round);
  const canvas = document.createElement('canvas');
  canvas.width = (x1 - x0) * K;
  canvas.height = (y1 - y0) * K;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: scale * K }), transform: [1, 0, 0, 1, -x0 * K, -y0 * K], intent: 'print' }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data, W = canvas.width;
  for (let y = 0; y < canvas.height; y++) {
    let dark = 0;
    for (let x = 0; x < W; x++) if (d[(y * W + x) * 4] < 205) dark++;
    if (lines && dark > 0.4 * W) for (let x = 0; x < W; x++) d.fill(255, (y * W + x) * 4, (y * W + x) * 4 + 3);
  }
  for (const b of wipe) { // marks that aren't words (a wavy line), in page pixels
    for (let y = Math.max(0, Math.floor((b.y0 - y0 - 1) * K)); y < Math.min(canvas.height, Math.ceil((b.y1 - y0 + 2) * K)); y++) {
      for (let x = Math.max(0, Math.floor((b.x0 - x0 - 1) * K)); x < Math.min(W, Math.ceil((b.x1 - x0 + 2) * K)); x++) d.fill(255, (y * W + x) * 4, (y * W + x) * 4 + 3);
    }
  }
  ctx.putImageData(img, 0, 0);
  let words = [];
  try {
    await wk.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: chars }); // 11: scattered words, 8: one word
    words = (await wk.recognize(canvas, {}, { blocks: true })).data.words || [];
  } catch {
    words = [];
  } finally {
    await wk.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '' }).catch(() => {});
  }
  return words.map((w) => ({ text: w.text, conf: w.confidence, x0: x0 + w.bbox.x0 / K, x1: x0 + w.bbox.x1 / K, y0: y0 + w.bbox.y0 / K, y1: y0 + w.bbox.y1 / K }));
}
