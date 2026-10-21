// Sheet music PDFs (piano, vocal staff...) that have no tab to read: shown as the PDF's pages.
import { loadPdfjs } from './pdftab.js';

const $ = (id) => document.getElementById(id);
let run = 0;

// A song's notation parts sit in song.sheets ({ name, data }); `k` is the part shown.
export async function openSheet(song, k = 0) {
  const mine = ++run;
  const parts = song.sheets || [];
  const part = parts[k] || parts[0];
  $('sh-title').textContent = song.title || 'Sheet music';
  $('sh-artist').textContent = [song.artist, part?.name].filter(Boolean).join(' · ');
  const nav = $('sh-parts');
  nav.textContent = '';
  // the song's tab (when it has one) and each sheet-music part, to switch between them
  if (song.kind !== 'sheet') nav.append(link(`#song/${song.id}`, '‹ Tab', false));
  if (parts.length > 1 || song.kind !== 'sheet') parts.forEach((s, i) => nav.append(link(`#song/${song.id}/sheet/${i}`, s.name, s === part)));
  nav.hidden = !nav.childElementCount;
  const box = $('sh-pages');
  box.textContent = 'Loading pages…';
  try {
    const lib = await loadPdfjs();
    const pdf = await lib.getDocument({ data: new Uint8Array((part?.data || song.data).slice(0)) }).promise;
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

function link(href, text, on) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  if (on) { a.className = 'on'; a.setAttribute('aria-current', 'page'); }
  return a;
}

export function closeSheet() {
  run++;
  $('sh-pages').textContent = '';
}
