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
  await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: scale * K }), transform: [1, 0, 0, 1, -x0 * K, -y0 * K] }).promise;
  let words;
  try { words = (await wk.recognize(canvas, {}, { blocks: true })).data.words || []; } catch { return []; }
  // text that starts low in the crop is the next strip's section name poking in
  return syllables(words.filter((w) => w.bbox.y0 < 0.45 * canvas.height), x0);
}

/** Tesseract words (with letter boxes) -> syllables; exported for tests. */
export function syllables(words, xOffset = 0) {
  const out = [];
  const px = (v) => v / K + xOffset;
  const sorted = [...words].sort((a, b) => a.bbox.x0 - b.bbox.x0);
  const real = sorted.filter((w) => w.symbols?.some((s) => /[A-Za-z]/.test(s.text)) && w.confidence >= 55);
  if (real.length < 2) return [];
  for (const w of sorted) {
    if (w.symbols?.length && w.symbols.every((s) => DASH.test(s.text) || /[|\u2014\u2013~]/.test(s.text))) { if (out.length) out[out.length - 1].joined = true; continue; }
    if (!real.includes(w)) continue;
    let cur = null;
    for (const s of w.symbols) {
      if (DASH.test(s.text)) { if (cur) cur.joined = true; cur = null; continue; }
      if (!/[A-Za-z0-9'\u2019,.!?;:]/.test(s.text)) continue;
      if (!cur) { cur = { x: px(s.bbox.x0), x1: px(s.bbox.x1), text: '', joined: false }; out.push(cur); }
      cur.text += s.text === '\u2019' ? "'" : s.text;
      cur.x1 = px(s.bbox.x1);
    }
  }
  // stray marks (a beam, a bar number) read as one or two odd letters
  const kept = out.filter((s) => s.text && (s.text.length > 1 || /^[IaAO]$/.test(s.text)) && /[a-z]|^[IAO]$/.test(s.text));
  if (kept.length < 3) return [];
  return kept.map((s) => ({ x: s.x, x1: s.x1, text: s.joined ? s.text + '-' : s.text }));
}
