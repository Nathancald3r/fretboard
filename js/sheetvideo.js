// The chord sheet's video panel: YouTube's player with our own big controls (play, seek bar, speed,
// fold). YouTube's own bar is a thin line in a small frame; a tap that misses it pauses the video.
import { loadYouTubeApi, clock, nextRate } from './ytapi.js';

const $ = (id) => document.getElementById(id);
const FOLD_KEY = 'fretboard-tx-vid-fold';

export function initVideoBar({ onFold = () => {} } = {}) {
  let player = null;
  let loaded = ''; // the video id the player holds
  let want = ''; // what the panel was last asked to show (a close while it loads cancels the open)
  let timer = 0;
  let dragging = false;
  let folded = false;
  try { folded = localStorage.getItem(FOLD_KEY) === '1'; } catch { /* ignore */ }

  const playing = () => !!player?.getPlayerState && player.getPlayerState() === window.YT.PlayerState.PLAYING;
  const total = () => (player?.getDuration?.() > 0 ? player.getDuration() : 0);

  function paint() {
    const t = player?.getCurrentTime?.() || 0, d = total();
    const frac = d ? Math.min(1, t / d) : 0;
    if (!dragging) {
      $('tx-vid-seek').value = String(Math.round(frac * 1000));
      $('tx-vid-seek').style.setProperty('--p', `${frac * 100}%`);
    }
    $('tx-vid-time').textContent = `${clock(dragging ? Number($('tx-vid-seek').value) / 1000 * d : t)} / ${clock(d)}`;
    $('tx-vid-play').classList.toggle('playing', playing());
    $('tx-vid-play').setAttribute('aria-label', playing() ? 'Pause' : 'Play');
    const r = player?.getPlaybackRate?.() || 1;
    $('tx-vid-rate').textContent = `${r}×`;
  }

  // polls only while the video plays
  function state() {
    clearInterval(timer);
    if (playing()) timer = setInterval(paint, 250);
    paint();
  }

  function paintFold() {
    $('tx-vid').classList.toggle('folded', folded);
    $('view-text').classList.toggle('vid-folded', folded);
    const b = $('tx-vid-fold');
    b.setAttribute('aria-expanded', String(!folded));
    b.setAttribute('aria-label', folded ? 'Show the video' : 'Fold the video');
    b.title = folded ? 'Show the video (it keeps playing while folded)' : 'Fold the video away (it keeps playing)';
  }

  function setFolded(on) {
    folded = !!on;
    try { localStorage.setItem(FOLD_KEY, folded ? '1' : '0'); } catch { /* ignore */ }
    paintFold();
    onFold();
  }

  async function open(id) {
    want = id;
    $('tx-vid').hidden = false;
    paintFold();
    $('tx-vid-time').textContent = 'Loading…';
    try {
      await loadYouTubeApi();
    } catch {
      $('tx-vid-time').textContent = 'No connection to YouTube';
      return;
    }
    if (want !== id) return; // closed or switched while YouTube loaded
    if (!player) {
      // one player for the whole session: tearing it down and building another can leave it stuck
      $('tx-vid-frame').innerHTML = '<div id="tx-yt"></div>';
      await new Promise((resolve) => {
        player = new window.YT.Player('tx-yt', {
          videoId: id,
          host: 'https://www.youtube-nocookie.com',
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, controls: 0, disablekb: 1 },
          events: { onReady: resolve, onStateChange: state },
        });
      });
      loaded = id;
    } else if (loaded !== id) {
      player.cueVideoById(id);
      loaded = id;
    }
    if (want !== id) { player.pauseVideo(); return; }
    paint();
  }

  function close() {
    want = '';
    clearInterval(timer);
    try { player?.pauseVideo?.(); } catch { /* ignore */ }
    $('tx-vid').hidden = true;
  }

  const seekTo = (ahead) => {
    const d = total();
    if (!player || !d) return;
    player.seekTo(Number($('tx-vid-seek').value) / 1000 * d, ahead);
  };
  const seek = $('tx-vid-seek');
  seek.addEventListener('input', () => { dragging = true; $('tx-vid-seek').style.setProperty('--p', `${seek.value / 10}%`); seekTo(false); paint(); });
  seek.addEventListener('change', () => { seekTo(true); dragging = false; setTimeout(paint, 80); });
  $('tx-vid-play').addEventListener('click', () => {
    if (!player) return;
    if (playing()) player.pauseVideo(); else player.playVideo();
  });
  $('tx-vid-rate').addEventListener('click', () => {
    if (!player) return;
    player.setPlaybackRate(nextRate(player.getPlaybackRate(), player.getAvailablePlaybackRates?.()));
    setTimeout(paint, 50);
  });
  $('tx-vid-fold').addEventListener('click', () => setFolded(!folded));
  paintFold();

  return {
    open,
    close,
    setFolded,
    get folded() { return folded; },
    now: () => (player?.getCurrentTime?.() || 0),
    get playing() { return playing(); },
  };
}
