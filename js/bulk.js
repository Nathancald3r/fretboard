// Picking several songs in the library at once: delete, add to a setlist, move to a folder, share,
// or play them in another key. The key is a setting on the song (transpose, as the player's and the
// chord view's Tr. buttons save it), so the arrangement as written is never changed: it is "Nate's key",
// and Back to the original key clears it.
import { listSongs, getSong, deleteSong, updateSong, getValue, setValue } from './db.js';
import { loadFolders, addFolder } from './folders.js';
import { popMenu } from './menu.js';
import { pitchClass, noteName } from './theory.js';
import { officialGaps } from './songmeta.js';

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toast = (msg) => window.dispatchEvent(new CustomEvent('fbtoast', { detail: msg }));
const changed = () => window.dispatchEvent(new Event('songschange'));

const picked = new Set();
let on = false;
let hooks = null; // { shown(): the songs listed now, ask(opts), redraw() }

export const selecting = () => on;
export const isPicked = (id) => picked.has(id);

export function initBulk(h) {
  hooks = h;
  $('lib-select-btn').addEventListener('click', () => (on ? stop() : start()));
  $('bulk-bar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bulk]');
    if (b && !b.disabled) act(b.dataset.bulk, b);
  });
}

function start() { on = true; picked.clear(); hooks.redraw(); }
export function stop() { on = false; picked.clear(); hooks.redraw(); }

/** A row clicked while picking: ticks or unticks it. */
export function toggle(id) {
  if (picked.has(id)) picked.delete(id); else picked.add(id);
  hooks.redraw();
}

/** After the library is drawn: the bar and the Select button. */
export function drawBar() {
  const bar = $('bulk-bar');
  $('lib-select-btn').textContent = on ? 'Done' : 'Select';
  $('lib-select-btn').classList.toggle('on', on);
  document.querySelector('.lib-list')?.classList.toggle('picking', on);
  bar.hidden = !on;
  if (!on) return;
  const shown = hooks.shown();
  for (const id of [...picked]) if (!shown.some((s) => s.id === id)) picked.delete(id); // filtered out: not picked
  const n = picked.size;
  const all = shown.length && n === shown.length;
  bar.innerHTML = `<div class="bulk-top"><b>${n ? `${n} selected` : 'Tap songs to select them'}</b>
    <span class="row"><button class="ghost small" data-bulk="unsynced" title="Pick every song shown that is not an official Ultimate Guitar tab with its video, synced. Nothing is deleted until you press Delete.">Pick not synced</button>
    <button class="ghost small" data-bulk="${all ? 'none' : 'all'}">${all ? 'Select none' : `Select all ${shown.length}`}</button></span></div>
    <div class="bulk-acts">
      <button class="small" data-bulk="setlist" ${n ? '' : 'disabled'}>＋ Setlist</button>
      <button class="small" data-bulk="folder" ${n ? '' : 'disabled'}>📁 Folder</button>
      <button class="small" data-bulk="key" ${n ? '' : 'disabled'}>♯♭ Key</button>
      <button class="small" data-bulk="share" ${n ? '' : 'disabled'}>⤴ Share</button>
      <button class="small danger" data-bulk="delete" ${n ? '' : 'disabled'}>Delete</button>
    </div>`;
}

async function pickedSongs() {
  const out = [];
  for (const id of picked) { const s = await getSong(id); if (s) out.push(s); }
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function act(k, button) {
  if (k === 'all') { hooks.shown().forEach((s) => picked.add(s.id)); hooks.redraw(); return; }
  if (k === 'none') { picked.clear(); hooks.redraw(); return; }
  if (k === 'unsynced') return pickUnsynced();
  if (k === 'setlist') return setlistMenu(button);
  if (k === 'folder') return folderMenu(button);
  if (k === 'key') return keyDialog();
  if (k === 'share') return share();
  if (k === 'delete') return remove();
}

/* ---------- pick the songs that are not "official tab + its video + synced" ---------- */

// Ticks them so they can be looked over (each row says why), unticked to keep, then deleted with Delete.
function pickUnsynced() {
  const shown = hooks.shown();
  picked.clear();
  for (const s of shown) if (officialGaps(s).length) picked.add(s.id);
  const n = picked.size;
  toast(n ? `Picked ${plural(n, 'song')} that aren’t official tab + video + synced; ${shown.length - n} kept. Untick any to keep, then Delete.` : 'Every song shown is an official tab with its video, synced.');
  hooks.redraw();
}

/* ---------- delete ---------- */

async function remove() {
  const songs = await pickedSongs();
  const ok = await hooks.ask({ title: `Delete ${plural(songs.length, 'song')}?`, text: songs.length <= 4 ? songs.map((s) => `“${s.title}”`).join(', ') + ' will be removed. Your practice log keeps their history.' : 'They’ll be removed from your library and their setlists. Your practice log keeps their history.', ok: 'Delete' });
  if (!ok) return;
  const ids = new Set(songs.map((s) => s.id));
  for (const s of songs) await deleteSong(s.id);
  try { // they leave their setlists too
    const lists = (await getValue('setlists')) || [];
    if (lists.some((l) => l.songIds.some((x) => ids.has(x)))) {
      await setValue('setlists', lists.map((l) => ({ ...l, songIds: l.songIds.filter((x) => !ids.has(x)) })));
      window.dispatchEvent(new Event('setlistschange'));
    }
  } catch { /* ignore */ }
  toast(`Deleted ${plural(songs.length, 'song')}.`);
  stop();
}

/* ---------- setlist ---------- */

async function setlistMenu(button) {
  const lists = (await getValue('setlists')) || [];
  popMenu(button, [
    ...lists.map((l, i) => ({ k: String(i), label: l.name, hint: plural(l.songIds.length, 'song') })),
    lists.length ? '-' : null,
    { k: 'new', label: 'New setlist…' },
  ], async (k) => {
    let list;
    if (k === 'new') {
      const f = await hooks.ask({ title: 'New setlist', ok: 'Create', fields: { title: '', artist: '' }, single: true });
      const name = f?.title.trim();
      if (!name) return;
      list = { id: Date.now(), name, songIds: [] };
      lists.push(list);
    } else list = lists[Number(k)];
    const add = [...picked].filter((id) => !list.songIds.includes(id));
    list.songIds.push(...add);
    await setValue('setlists', lists);
    window.dispatchEvent(new Event('setlistschange'));
    const had = picked.size - add.length;
    toast(`Added ${plural(add.length, 'song')} to “${list.name}”.${had ? ` ${had} ${had === 1 ? 'was' : 'were'} in it already.` : ''}`);
    stop();
  });
}

/* ---------- folder ---------- */

async function folderMenu(button) {
  const names = [...new Set([...(await loadFolders()), ...(await listSongs()).map((s) => s.folder).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  popMenu(button, [
    ...names.map((n, i) => ({ k: String(i), label: n })),
    { k: 'none', label: 'No folder', hint: 'Take them out of their folders' },
    '-',
    { k: 'new', label: 'New folder…' },
  ], async (k) => {
    let name = k === 'none' ? '' : names[Number(k)];
    if (k === 'new') {
      const f = await hooks.ask({ title: 'New folder', ok: 'Create', fields: { title: '', artist: '' }, single: true });
      name = f?.title.trim() || '';
      if (!name) return;
      await addFolder(name);
    }
    for (const id of picked) await updateSong(id, { folder: name || null });
    toast(name ? `Moved ${plural(picked.size, 'song')} to “${name}”.` : `Took ${plural(picked.size, 'song')} out of their folders.`);
    changed();
    stop();
  });
}

/* ---------- key: a version of your own, the arrangement as written kept ---------- */

const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** The key a song is written in (its Key: line, or a read tab's key signature), '' when it doesn't say. */
export function writtenKey(song) {
  if (song.kind === 'text') return /\bKey:\s*([A-G][#b]?m?)(?![\w#])/.exec(String(song.data || '').slice(0, 400))?.[1] || '';
  if (song.kind === 'tex') return /\\ks\s+([A-G][#b]?m?)\b/.exec(String(song.data || ''))?.[1] || '';
  return '';
}

const FLAT_MAJORS = [5, 10, 3, 8, 1]; // F Bb Eb Ab Db
// a key moved by semitones, spelled as its key signature is (Bb, not A#)
function keyAfter(key, n) {
  if (!key) return '';
  const minor = /m$/.test(key);
  const pc = (((pitchClass(key.replace(/m$/, '')) + n) % 12) + 12) % 12;
  return noteName(pc, FLAT_MAJORS.includes(minor ? (pc + 3) % 12 : pc)) + (minor ? 'm' : '');
}
const signed = (n) => (n > 0 ? `+${n}` : String(n));
// the smallest move from one key to another: -5 … +6
const moveTo = (from, to) => { const d = (((pitchClass(to) - pitchClass(from)) % 12) + 12) % 12; return d > 6 ? d - 12 : d; };

/** "Nate's key: A" for a song played in another key than written; '' when it isn't. */
export function keyNote(song) {
  const n = song.transpose || 0;
  if (!n) return '';
  const key = writtenKey(song);
  const who = song.keyBy ? `${song.keyBy}’s key` : 'Your key';
  return key ? `${who} ${keyAfter(key, n)} (written in ${key})` : `${who} ${signed(n)}`;
}

async function keyDialog() {
  const songs = await pickedSongs();
  const name = (await getValue('myName')) || '';
  const dlg = document.createElement('dialog');
  dlg.className = 'parts-dialog key-dialog';
  dlg.innerHTML = `<form method="dialog">
    <h2>Key for ${songs.length === 1 ? `“${escape(songs[0].title)}”` : plural(songs.length, 'song')}</h2>
    <p class="muted small-text">The songs stay as written. This saves the key you play them in, under your name, and can be undone any time.</p>
    <div class="key-modes">
      <label><input type="radio" name="mode" value="to" checked> All in one key
        <select data-to>${KEYS.map((k) => `<option>${k}</option>`).join('')}</select></label>
      <label><input type="radio" name="mode" value="by"> Each moved by
        <span class="key-step"><button type="button" class="ghost small" data-step="-1">−</button><b data-by>+0</b><button type="button" class="ghost small" data-step="1">+</button></span> semitones</label>
    </div>
    <label class="key-name">Whose key <input data-name maxlength="30" placeholder="Your name" value="${escape(name)}"></label>
    <ul class="key-preview"></ul>
    <div class="row spread"><button value="reset" class="ghost">Back to the written key</button><span class="row"><button value="cancel" class="ghost">Cancel</button><button value="ok" class="primary">Save</button></span></div>
  </form>`;
  document.body.append(dlg);
  let by = 0;
  const known = songs.map((s) => writtenKey(s));
  // the most common written key starts the "one key" picker
  const common = known.filter(Boolean).sort((a, b) => known.filter((x) => x === b).length - known.filter((x) => x === a).length)[0];
  if (common) dlg.querySelector('[data-to]').value = KEYS[pitchClass(common.replace(/m$/, ''))];
  const mode = () => dlg.querySelector('[name=mode]:checked').value;
  // each song's new transpose, or null when it can't be worked out (no written key, "one key" picked)
  const plan = () => songs.map((s, i) => {
    if (mode() === 'by') return by;
    if (!known[i]) return null;
    const target = dlg.querySelector('[data-to]').value + (/m$/.test(known[i]) ? 'm' : '');
    return moveTo(known[i], target);
  });
  const draw = () => {
    dlg.querySelector('[data-by]').textContent = signed(by);
    const p = plan();
    dlg.querySelector('.key-preview').innerHTML = songs.map((s, i) => {
      const from = known[i];
      const n = p[i];
      const to = n === null ? '<span class="muted">key not written: use “Each moved by”</span>'
        : from ? `<b>${escape(from)}</b> → <b>${escape(keyAfter(from, n))}</b>${n ? ` <span class="muted">(${signed(n)})</span>` : ''}`
          : `<b>${signed(n)}</b> semitones`;
      return `<li><span>${escape(s.title)}</span><span>${to}</span></li>`;
    }).join('');
  };
  dlg.addEventListener('input', draw);
  dlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (!b) return;
    by = Math.max(-11, Math.min(11, by + Number(b.dataset.step)));
    dlg.querySelector('[name=mode][value=by]').checked = true;
    draw();
  });
  dlg.querySelector('[data-to]').addEventListener('change', () => { dlg.querySelector('[name=mode][value=to]').checked = true; draw(); });
  draw();
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener('close', r, { once: true }));
  const v = dlg.returnValue;
  const who = dlg.querySelector('[data-name]').value.trim();
  const p = plan();
  dlg.remove();
  if (v === 'reset') {
    for (const s of songs) await updateSong(s.id, { transpose: 0, keyBy: null });
    toast(`${plural(songs.length, 'song')} back in the written key.`);
  } else if (v === 'ok') {
    if (who !== name) await setValue('myName', who);
    let done = 0;
    for (let i = 0; i < songs.length; i++) {
      if (p[i] === null) continue;
      await updateSong(songs[i].id, { transpose: p[i], keyBy: p[i] ? who || null : null });
      done++;
    }
    const left = songs.length - done;
    toast(`Saved ${who ? `${who}’s` : 'your'} key for ${plural(done, 'song')}.${left ? ` ${left} without a written key ${left === 1 ? 'was' : 'were'} left as ${left === 1 ? 'it was' : 'they were'}.` : ''}`);
  } else return;
  changed();
  stop();
}

/* ---------- share: see share.js ---------- */

export { readShared } from './sharecore.js';

async function share() {
  const { shareSongs } = await import('./share.js');
  if (await shareSongs(await pickedSongs())) stop();
}
