// A plain click (metronome) and a count-in for the chord sheet's tools. The click is scheduled on the
// audio clock a little ahead, so it stays steady while the page scrolls.

let ctx = null;
let timer = 0;
let next = 0;
let beat = 0;
let bpm = 100;
let on = false;
let count = null; // { timers, done }

const audio = () => {
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
};

function tick(time, accent) {
  const c = audio();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.frequency.value = accent ? 1760 : 1100;
  gain.gain.setValueAtTime(accent ? 0.55 : 0.4, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
  osc.connect(gain).connect(c.destination);
  osc.start(time);
  osc.stop(time + 0.06);
}

function pump() {
  while (next < ctx.currentTime + 0.12) {
    tick(next, beat % 4 === 0);
    next += 60 / bpm;
    beat++;
  }
}

export const clicking = () => on;

export function startClick(b) {
  bpm = Math.max(20, Math.min(400, Number(b) || 100));
  const c = audio();
  on = true;
  beat = 0;
  next = c.currentTime + 0.06;
  clearInterval(timer);
  timer = setInterval(pump, 25);
  pump();
}

export function stopClick() {
  on = false;
  clearInterval(timer);
  timer = 0;
}

export function setClickBpm(b) { bpm = Math.max(20, Math.min(400, Number(b) || bpm)); }

/** Clicks beats times at bpm (the first higher); onBeat(n) as each one sounds. Resolves true when done, false if cancelled. */
export function countIn(b, beats = 4, onBeat = () => {}) {
  cancelCount();
  audio(); // made here, in the tap that asked for it
  const gap = 60000 / Math.max(20, Math.min(400, Number(b) || 100));
  return new Promise((resolve) => {
    const run = { timers: [], done: resolve };
    count = run;
    for (let i = 0; i < beats; i++) {
      run.timers.push(setTimeout(() => { tick(audio().currentTime + 0.01, i === 0); onBeat(i + 1); }, i * gap));
    }
    run.timers.push(setTimeout(() => { count = null; resolve(true); }, beats * gap));
  });
}

export function cancelCount() {
  if (!count) return;
  count.timers.forEach(clearTimeout);
  const { done } = count;
  count = null;
  done(false);
}

export const counting = () => !!count;
