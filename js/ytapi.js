// YouTube's IFrame API, loaded once for the whole page (the play-along and the chord sheet both use it),
// and the small pure helpers the chord sheet's own video bar needs.

let ytReady = null;
export function loadYouTubeApi() {
  ytReady ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) { resolve(); return; }
    const before = window.onYouTubeIframeAPIReady; // whoever asked first still gets told
    window.onYouTubeIframeAPIReady = () => { try { before?.(); } finally { resolve(); } };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytReady = null; window.onYouTubeIframeAPIReady = before; reject(new Error('Could not reach YouTube.')); };
    document.head.append(s);
  });
  return ytReady;
}

// 83.4 → "1:23", 3725 → "1:02:05"
export function clock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

// Speeds the speed button steps through: slower first, back to normal at the end.
const STEPS = [1, 0.75, 0.5, 0.25];
export function nextRate(current, available) {
  const have = Array.isArray(available) && available.length ? available : STEPS;
  const list = STEPS.filter((r) => have.includes(r));
  if (!list.length) return 1;
  const i = list.findIndex((r) => Math.abs(r - current) < 0.01);
  return list[(i + 1) % list.length];
}

// where a tap or drag landed on a bar, as a fraction 0..1
export function barFraction(x, left, width) {
  return width > 0 ? Math.max(0, Math.min(1, (x - left) / width)) : 0;
}
