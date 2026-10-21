// Bluetooth headphones play the sound a moment after the app does, so the tab cursor runs
// ahead of what you hear. This holds it back by the same amount. One device-wide setting,
// shared by the built-in guitar (here) and the linked video (playalong.js, as a sync offset).
// The delay you set is kept when the correction is switched off, so it is one tap to turn on.
const MS_KEY = 'fretboard.audioDelayMs';
const ON_KEY = 'fretboard.audioDelayOn';
export const BT_DEFAULT = 200;
const clamp = (v) => Math.max(0, Math.min(1000, Math.round(Number(v) || 0)));

let ms = 0;
let enabled = false;
try {
  ms = clamp(localStorage.getItem(MS_KEY));
  const on = localStorage.getItem(ON_KEY);
  enabled = on === null ? ms > 0 : on === '1'; // earlier versions: a saved delay meant on
} catch { /* no storage */ }
const listeners = new Set();
const save = () => {
  try { localStorage.setItem(MS_KEY, String(ms)); localStorage.setItem(ON_KEY, enabled ? '1' : '0'); } catch { /* no storage */ }
  listeners.forEach((f) => f());
};

/** The delay in effect (0 while the correction is off). */
export const btDelay = () => (enabled ? ms : 0);
export const btMs = () => ms;
export const btOn = () => enabled;

export function setBtOn(on) {
  enabled = !!on;
  if (enabled && !ms) ms = BT_DEFAULT;
  save();
}

export function setBtMs(v) {
  ms = clamp(v);
  if (!ms) enabled = false; // 0 ms is no correction
  save();
}

export function onBtChange(f) {
  listeners.add(f);
  f();
}

// The synth's playback-position events move the cursor: pass them on late. Skipped while a
// linked video drives playback (it is shifted by its sync offset instead).
export function delayPositionEvents(api, externalOn) {
  const em = api?.player?.positionChanged;
  if (!em || em.__btDelayed) return;
  const trigger = em.trigger.bind(em);
  em.trigger = (e) => {
    const d = btDelay();
    if (!d || externalOn()) trigger(e);
    else setTimeout(() => trigger(e), d);
  };
  em.__btDelayed = true;
}

// Wires a toggle button, a ms box and −/+ buttons (data-bt="±n") to the setting. `labelMs`
// puts the number on the button itself.
export function bindBtControls({ button, input, nudges, labelMs = false, title = 'Bluetooth headphones' }) {
  onBtChange(() => {
    if (input) input.value = ms;
    button.classList.toggle('on', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    button.textContent = labelMs && enabled ? `${title} · ${ms} ms` : title;
  });
  button.addEventListener('click', () => setBtOn(!enabled));
  input?.addEventListener('change', () => { setBtMs(input.value); if (ms) setBtOn(true); });
  nudges?.forEach((b) => b.addEventListener('click', () => { setBtMs(ms + Number(b.dataset.bt)); if (ms && !enabled) setBtOn(true); }));
}
