// Share a song, some songs or a setlist through the system share sheet (Nearby Share, email, messages,
// MusicStand and other chord apps): Web Share with files on the web, an Android share intent in the app.
// Each song goes in the format other apps read best (see sharecore.js), or as a .fretboard file for
// another Fretboard. Whichever is picked, the dialog says what it keeps and what it loses.
import { chartType } from './songmeta.js';
import { transposeScore } from './transpose.js';
import {
  songToChordPro, playKey, fretboardFile, setlistText, safeName, dateText, makeZip, makePdf, toBase64,
} from './sharecore.js';

const AT = window.alphaTab;
const VENDOR = new URL('../vendor/alphatab/', import.meta.url).href;
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toast = (msg) => window.dispatchEvent(new CustomEvent('fbtoast', { detail: msg }));

const MIME = { cho: 'text/plain', txt: 'text/plain', pdf: 'application/pdf', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const mimeOf = (name) => MIME[/\.(\w+)$/.exec(name)?.[1]?.toLowerCase()] || 'application/octet-stream';

/* ---------- what each song becomes ---------- */

// what a song is, for the formats: 'chords' and 'tab' (text), 'score' (notes: gp, xml, read PDFs), 'sheet' (pages)
function sortOf(song) {
  const t = chartType(song);
  if (t === 'sheet') return 'sheet';
  if (song.kind === 'text') return t === 'tab' ? 'tab' : 'chords';
  return 'score';
}

const KEEPS = {
  chords: 'ChordPro (.cho): chords, words, sections, key and capo, in your key. MusicStand, OnSong and SongbookPro read it, and can transpose it. Loses strumming patterns, loops and the video.',
  tab: 'ChordPro (.cho) with the tab as text: it shows as written, in a fixed-width font. Loses playback, loops and the video.',
  score: 'PDF of the tab pages, in your key. Looks right in any app, but can’t be played or transposed there. Another Fretboard reads the whole song back out of it.',
  sheet: 'The pages as they came (PDF or picture).',
};

/** The files a song becomes for other apps. n: its place in a setlist zip (01, 02…), or 0. */
async function appFiles(song, n = 0, progress = () => {}) {
  const base = (n ? `${String(n).padStart(2, '0')} ` : '') + safeName(song.title);
  const sort = sortOf(song);
  if (sort === 'chords' || sort === 'tab') return [{ name: `${base}.cho`, data: songToChordPro(song) }];
  if (sort === 'sheet') {
    const pages = song.sheets?.length ? song.sheets : [{ data: song.data, fileName: song.fileName }];
    return pages.map((p, i) => ({ name: `${base}${pages.length > 1 ? ` ${i + 1}` : ''}.${/\.(\w+)$/.exec(p.fileName || '')?.[1] || 'pdf'}`, data: p.data }));
  }
  progress(`Making the PDF of “${song.title}”…`);
  const out = [{ name: `${base}.pdf`, data: await tabPdf(song) }];
  if (song.chordSheet) out.push({ name: `${base} (chords).cho`, data: songToChordPro(song, { data: song.chordSheet }) });
  return out;
}

/* ---------- tab → PDF: drawn by alphaTab off screen, a picture per page ---------- */

function parse(song, settings) {
  if (song.kind === 'tex') {
    const importer = new AT.importer.AlphaTexImporter();
    importer.initFromString(String(song.data).replace(/\\staff \{tabs\}/g, '\\staff {score tabs}'), settings);
    return importer.readScore();
  }
  return AT.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(song.data), settings);
}

/** A PDF of the song's shown track as the player draws it (notes and tab), with the song attached. */
export async function tabPdf(song) {
  const WIDTH = 950; // the page's drawing width (CSS px)
  const MARGIN = 34;
  const K = 2; // pixels per CSS px in the pictures
  const box = document.createElement('div');
  box.style.cssText = `position:fixed;left:-${WIDTH + 2000}px;top:0;width:${WIDTH}px;background:#fff;color:#000;`;
  box.setAttribute('aria-hidden', 'true');
  document.body.append(box);
  const api = new AT.AlphaTabApi(box, {
    core: { engine: 'html5', useWorkers: false, enableLazyLoading: false, fontDirectory: VENDOR + 'font/', scriptFile: VENDOR + 'alphaTab.js' },
    display: { layoutMode: AT.LayoutMode.Page, staveProfile: AT.StaveProfile.Default, scale: 1, systemPaddingTop: 30 },
    player: { playerMode: AT.PlayerMode.Disabled },
  });
  try {
    const score = parse(song, api.settings);
    const saved = song.trackIndex;
    const track = saved >= 0 && saved < score.tracks.length ? saved : Math.max(0, score.tracks.findIndex((t) => !t.staves[0]?.isPercussion));
    transposeScore(score, { semitones: song.transpose || 0, capo: song.capo ?? null, capoTrack: track, retune: song.tune || 0 });
    if (!score.title) score.title = song.title;
    if (!score.artist) score.artist = song.artist || '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Drawing the tab took too long')), 60000);
      api.renderFinished.on(() => { clearTimeout(timer); resolve(); });
      api.error.on((e) => { clearTimeout(timer); reject(e); });
      api.renderScore(score, [track]);
    });
    await new Promise((r) => setTimeout(r, 50)); // not requestAnimationFrame: it never comes in a hidden page
    const origin = box.getBoundingClientRect();
    const parts = [...box.querySelectorAll('canvas')].map((c) => {
      const r = c.getBoundingClientRect();
      return { c, x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
    }).filter((p) => p.w > 0 && p.h > 0).sort((a, b) => a.y - b.y || a.x - b.x);
    if (!parts.length) throw new Error('Nothing was drawn');
    // rows (a system each), kept whole on a page
    const rows = [];
    for (const p of parts) {
      const row = rows.find((r) => Math.abs(r.y - p.y) < 2);
      if (row) { row.parts.push(p); row.h = Math.max(row.h, p.h); } else rows.push({ y: p.y, h: p.h, parts: [p] });
    }
    const pageW = WIDTH + MARGIN * 2;
    const pageH = Math.round(pageW * Math.SQRT2);
    const pages = [];
    let page = null;
    let y = 0;
    const newPage = () => {
      const c = document.createElement('canvas');
      c.width = pageW * K; c.height = pageH * K;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      page = { c, g }; pages.push(page); y = MARGIN;
    };
    rows.forEach((row, i) => {
      const advance = i + 1 < rows.length ? Math.max(row.h, rows[i + 1].y - row.y) : row.h;
      if (!page || (y + row.h > pageH - MARGIN && y > MARGIN)) newPage();
      for (const p of row.parts) page.g.drawImage(p.c, (MARGIN + p.x) * K, (y + p.y - row.y) * K, p.w * K, p.h * K);
      y += advance;
    });
    // the last page ends under its last line
    const last = pages[pages.length - 1];
    const used = Math.min(pageH, Math.ceil(y + MARGIN));
    if (used < pageH) {
      const c = document.createElement('canvas');
      c.width = pageW * K; c.height = used * K;
      c.getContext('2d').drawImage(last.c, 0, 0);
      last.c = c;
    }
    const jpegs = [];
    for (const p of pages) {
      const blob = await new Promise((r) => p.c.toBlob(r, 'image/jpeg', 0.9));
      jpegs.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), width: p.c.width, height: p.c.height });
    }
    return makePdf(jpegs, { title: [song.title, song.artist].filter(Boolean).join(' - '), attach: { name: `${safeName(song.title)}.fretboard`, data: fretboardFile([song]) } });
  } finally {
    try { api.destroy(); } catch { /* ignore */ }
    box.remove();
  }
}

/* ---------- handing files over ---------- */

const asBlobPart = (d) => (typeof d === 'string' ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : d);
const bytesOf = (d) => (typeof d === 'string' ? new TextEncoder().encode(d) : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength));

function download(f) {
  const url = URL.createObjectURL(new Blob([asBlobPart(f.data)], { type: mimeOf(f.name) }));
  const a = Object.assign(document.createElement('a'), { href: url, download: f.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

function readyTap(n) {
  const dlg = document.createElement('dialog');
  dlg.className = 'parts-dialog share-dialog';
  dlg.innerHTML = `<form method="dialog"><h2>Ready to share</h2><p class="muted">${n > 1 ? `${n} files are` : 'The file is'} ready.</p>
    <div class="row spread"><button value="" class="ghost small">Cancel</button><button value="go" class="primary">⤴ Share</button></div></form>`;
  document.body.append(dlg);
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => { dlg.remove(); resolve(dlg.returnValue === 'go'); }, { once: true }));
}

/**
 * The share sheet with these files. text: a line for email or messages. Returns 'shared', 'saved'
 * (downloaded: the browser can't share them) or 'cancelled'.
 */
async function deliver(files, { title, text = '' }) {
  if (window.fretboardAndroid) { // the app: Android's own share sheet
    window.fretboardAndroid.postMessage(JSON.stringify({
      share: true, title, text, files: files.map((f) => ({ name: f.name, mime: mimeOf(f.name), data: toBase64(bytesOf(f.data)) })),
    }));
    return 'shared';
  }
  const make = (list) => list.map((f) => new File([asBlobPart(f.data)], f.name, { type: mimeOf(f.name) }));
  if (navigator.canShare) {
    // Chrome shares only some file types (PDF, text, pictures): ChordPro then goes as a .txt (chord apps read ChordPro in it)
    for (const list of [files, files.map((f) => (/\.cho$/i.test(f.name) ? { ...f, name: f.name.replace(/\.cho$/i, '.txt') } : f))]) {
      const ready = make(list);
      if (!navigator.canShare({ files: ready })) continue;
      const data = { files: ready, title, ...(text ? { text } : {}) };
      try {
        await navigator.share(data);
        return 'shared';
      } catch (e) {
        if (e?.name === 'AbortError') return 'cancelled';
        // making a PDF took a while, and the browser only shares straight after a tap: one more tap
        if (e?.name === 'NotAllowedError' && await readyTap(files.length)) {
          try { await navigator.share(data); return 'shared'; } catch (e2) { if (e2?.name === 'AbortError') return 'cancelled'; }
        }
        break; // no share sheet here (some desktops): save instead
      }
    }
  }
  if (files.length > 1) download({ name: `${safeName(title)}.zip`, data: makeZip(files) });
  else download(files[0]);
  return 'saved';
}

/* ---------- the dialog ---------- */

function keyLine(song) {
  const k = playKey(song);
  if (k.shift) return k.key ? `Key ${k.key} · ${song.keyBy ? `${song.keyBy}’s` : 'your'} key (written in ${k.written})` : `${song.keyBy ? `${song.keyBy}’s` : 'Your'} key: ${k.shift > 0 ? '+' : ''}${k.shift} from the original`;
  return k.key ? `Key ${k.key} · the original key` : 'The original key';
}

function choose({ heading, intro, choices, setlist }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'parts-dialog dup-dialog share-dialog';
  dlg.innerHTML = `<form method="dialog">
    <h2>${escape(heading)}</h2>
    ${setlist ? `<label class="share-date">Date <input type="date" name="date" value="${escape(setlist.date || '')}"></label>` : ''}
    ${intro}
    <div class="dup-choices">${choices.map((c, i) => `<button value="${c.k}" class="dup-choice${i ? '' : ' primary'}"><b>${escape(c.title)}</b><span>${c.hint}</span></button>`).join('')}</div>
    <div class="row spread"><span></span><button value="" class="ghost small">Cancel</button></div>
  </form>`;
  document.body.append(dlg);
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => {
    const date = dlg.querySelector('[name=date]')?.value || '';
    dlg.remove();
    resolve({ k: dlg.returnValue, date });
  }, { once: true }));
}

const sortsOf = (songs) => [...new Set(songs.map(sortOf))];
const appsHint = (songs) => sortsOf(songs).map((s) => `<i>${{ chords: 'Chord charts', tab: 'Text tabs', score: 'Tabs', sheet: 'Sheet music' }[s]}:</i> ${escape(KEEPS[s])}`).join('<br>');
const FRETBOARD_HINT = 'Everything: every track, your key, loops, video sync, strumming. Only Fretboard opens it (on the web or the Android app).';

/** Share songs (one or more). Resolves true when they went somewhere. */
export async function shareSongs(songs) {
  if (!songs.length) return false;
  const one = songs.length === 1 ? songs[0] : null;
  const name = one ? one.title : `${songs.length} songs`;
  const choices = [{ k: 'apps', title: 'For MusicStand and other apps', hint: appsHint(songs) }];
  if (!one) choices.push({ k: 'zip', title: 'As one .zip file', hint: 'The same files in one .zip, for email or an app that imports a zip (SongbookPro).' });
  if (one && (one.kind === 'gp' || one.kind === 'xml') && one.data) choices.push({ k: 'original', title: `The original file (${escape(one.fileName || 'Guitar Pro')})`, hint: 'Every track, playable, in Fretboard, Guitar Pro or Songsterr. Loses your key, loops and video sync.' });
  choices.push({ k: 'fretboard', title: 'For another Fretboard', hint: FRETBOARD_HINT });
  const intro = one ? `<p class="muted small-text">${escape(keyLine(one))}</p>` : '';
  const { k } = await choose({ heading: `Share “${name}”`, intro, choices });
  if (!k) return false;
  return send(k, songs, { title: name });
}

/** Share a setlist: all its songs in one go, in order, each in its key, with the setlist's date. */
export async function shareSetlist(list, songs, { saveDate } = {}) {
  const rows = songs.map((s, i) => `<li><b>${i + 1}. ${escape(s.title)}</b> <span class="muted">${escape(keyLine(s))}</span></li>`).join('');
  const intro = `<ol class="share-songs">${rows}</ol>${songs.length < list.songIds.length ? `<p class="muted small-text">${list.songIds.length - songs.length} song(s) no longer in your library are left out.</p>` : ''}`;
  const choices = [
    { k: 'apps', title: 'For MusicStand and other apps', hint: `Every song as its own file, all in one share, in order. ${appsHint(songs)}` },
    { k: 'zip', title: 'As one .zip file', hint: 'The same files numbered in setlist order, plus Setlist.txt with the date and each song’s key. Fretboard makes the setlist again from it.' },
    { k: 'fretboard', title: 'For another Fretboard', hint: `The setlist (name, date, order) and its songs. ${FRETBOARD_HINT}` },
  ];
  const { k, date } = await choose({ heading: `Share the setlist “${list.name}”`, intro, choices, setlist: list });
  if (!k) return false;
  if (date !== (list.date || '') && saveDate) await saveDate(date);
  const withDate = { ...list, date };
  const title = `${list.name}${date ? ` ${date}` : ''}`;
  const text = [`${list.name}${date ? ` · ${dateText(date)}` : ''}`, ...songs.map((s, i) => `${i + 1}. ${s.title}${playKey(s).key ? ` (${playKey(s).key})` : ''}`)].join('\n');
  return send(k, songs, { title, text, setlist: withDate });
}

async function send(k, songs, { title, text = '', setlist = null }) {
  let files;
  try {
    if (k === 'fretboard') {
      files = [{ name: `${safeName(title)}.fretboard`, data: fretboardFile(songs, { setlists: setlist ? [{ ...setlist, songIds: songs.map((s) => s.id) }] : [] }) }];
    } else if (k === 'original') {
      files = [{ name: songs[0].fileName || `${safeName(songs[0].title)}.gp`, data: songs[0].data }];
    } else {
      const numbered = k === 'zip' && setlist;
      files = [];
      for (let i = 0; i < songs.length; i++) files.push(...await appFiles(songs[i], numbered ? i + 1 : 0, (m) => toast(m)));
      if (k === 'zip') {
        if (setlist) {
          const entries = songs.map((s, i) => ({ title: s.title, artist: s.artist, key: playKey(s).key, file: files.find((f) => f.name.startsWith(`${String(i + 1).padStart(2, '0')} `))?.name || '' }));
          files.push({ name: 'Setlist.txt', data: setlistText(setlist, entries) });
        }
        files = [{ name: `${safeName(title)}.zip`, data: makeZip(files) }];
      }
    }
  } catch (err) {
    console.error(err);
    toast(`Couldn’t make the files: ${err?.message || err}`);
    return false;
  }
  const r = await deliver(files, { title, text });
  if (r === 'saved') {
    const what = files.length > 1 ? `${safeName(title)}.zip` : files[0].name;
    toast(`Saved “${what}” to your downloads (this browser can’t share ${files.length > 1 ? 'these files' : 'this file'} directly). Open it in MusicStand or send it from there.`);
  }
  return r !== 'cancelled';
}
