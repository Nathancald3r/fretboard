// Sheet music PDFs (piano, vocal staff...) that have no tab to read: shown as the PDF's pages.
import { loadPdfjs } from './pdftab.js';

const $ = (id) => document.getElementById(id);
let run = 0;

export async function openSheet(song) {
  const mine = ++run;
  $('sh-title').textContent = song.title || 'Sheet music';
  $('sh-artist').textContent = song.artist || '';
  const box = $('sh-pages');
  box.textContent = 'Loading pages…';
  try {
    const lib = await loadPdfjs();
    const pdf = await lib.getDocument({ data: new Uint8Array(song.data.slice(0)) }).promise;
    if (mine !== run) return;
    box.textContent = '';
    const width = Math.min(box.clientWidth || 900, 1100);
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      if (mine !== run) return;
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (width / base.width) * Math.min(devicePixelRatio || 1, 2) });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      canvas.className = 'sheet-page';
      canvas.setAttribute('aria-label', `Page ${n} of ${pdf.numPages}`);
      box.append(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    }
  } catch (err) {
    console.error(err);
    if (mine === run) box.textContent = 'Could not show this PDF.';
  }
}

export function closeSheet() {
  run++;
  $('sh-pages').textContent = '';
}
