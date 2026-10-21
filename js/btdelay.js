// Bluetooth headphones play the sound a moment after the app does, so the tab cursor runs
// ahead of what you hear. This holds it back by the same amount. One device-wide setting,
// shared by the built-in guitar (here) and the linked video (playalong.js, as a sync offset).
const KEY = 'fretboard.audioDelayMs';
export const BT_DEFAULT = 200;
const clamp = (v) => Math.max(0, Math.min(1000, Math.round(Number(v) || 0)));

let ms = 0;
try { ms = clamp(localStorage.getItem(KEY)); } catch { /* no storage */ }
const listeners = new Set();

export const btDelay = () => ms;

export function setBtDelay(v) {
  ms = clamp(v);
  try { localStorage.setItem(KEY, String(ms)); } catch { /* no storage */ }
  listeners.forEach((f) => f(ms));
}

export function onBtDelay(f) {
  listeners.add(f);
  f(ms);
}

// The synth's playback-position events move the cursor: pass them on `ms` late. Skipped while a
// linked video drives playback (it is shifted by its sync offset instead).
export function delayPositionEvents(api, externalOn) {
  const em = api?.player?.positionChanged;
  if (!em || em.__btDelayed) return;
  const trigger = em.trigger.bind(em);
  em.trigger = (e) => {
    if (!ms || externalOn()) trigger(e);
    else setTimeout(() => trigger(e), ms);
  };
  em.__btDelayed = true;
}

// Wires a "Bluetooth headphones" button, a −10 / +10 pair and a ms box to the setting.
export function bindBtControls({ button, input, nudges }) {
  onBtDelay((v) => {
    input.value = v;
    button.classList.toggle('on', v > 0);
    button.textContent = v > 0 ? 'Bluetooth: on' : 'Bluetooth headphones';
  });
  button.addEventListener('click', () => setBtDelay(ms > 0 ? 0 : BT_DEFAULT));
  input.addEventListener('change', () => setBtDelay(input.value));
  nudges.forEach((b) => b.addEventListener('click', () => setBtDelay(ms + Number(b.dataset.bt))));
}
