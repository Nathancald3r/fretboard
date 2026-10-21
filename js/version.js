// "Which recording is this arrangement based on?": official / live / cover (and who plays it).
import { updateSong } from './db.js';

const $ = (id) => document.getElementById(id);

/** Opens the version dialog for a song. Saves and resolves with the new version, or null if cancelled. */
export function askVersion(song) {
  const dialog = $('ver-dialog');
  const v = song.version || { type: 'official', artist: '', live: false, note: '' };
  dialog.querySelector(`input[name=ver-type][value=${v.type}]`).checked = true;
  $('ver-artist').value = v.artist || (v.type === 'cover' ? '' : song.artist || '');
  $('ver-live').checked = v.type === 'live' || !!v.live;
  $('ver-note').value = v.note || '';
  const show = () => {
    const type = dialog.querySelector('input[name=ver-type]:checked').value;
    $('ver-who').hidden = type !== 'cover';
    $('ver-live-row').hidden = type !== 'cover';
    if (type === 'cover' && $('ver-artist').value === (song.artist || '')) $('ver-artist').value = '';
  };
  dialog.onchange = show;
  show();
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', async () => {
      if (dialog.returnValue !== 'ok') { resolve(null); return; }
      const type = dialog.querySelector('input[name=ver-type]:checked').value;
      const version = {
        type,
        artist: type === 'cover' ? $('ver-artist').value.trim() : song.artist || '',
        live: type === 'live' || (type === 'cover' && $('ver-live').checked),
        note: $('ver-note').value.trim().slice(0, 120),
      };
      song.version = version;
      await updateSong(song.id, { version });
      resolve(version);
    }, { once: true });
  });
}
