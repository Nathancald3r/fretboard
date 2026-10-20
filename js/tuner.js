// Chromatic guitar tuner using the microphone (autocorrelation pitch detection)
// plus reference tones for common tunings. Audio never leaves the browser.

const $ = (id) => document.getElementById(id);
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Low string to high string, as MIDI note numbers.
const TUNINGS = {
  'Standard (E A D G B E)': [40, 45, 50, 55, 59, 64],
  'Drop D (D A D G B E)': [38, 45, 50, 55, 59, 64],
  'E♭ standard': [39, 44, 49, 54, 58, 63],
  'D standard': [38, 43, 48, 53, 57, 62],
  'Drop C (C G C F A D)': [36, 43, 48, 53, 57, 62],
  'Drop B (B F# B E G# C#)': [35, 42, 47, 52, 56, 61],
  'Open G (D G D G B D)': [38, 43, 50, 55, 59, 62],
  'Open D (D A D F# A D)': [38, 45, 50, 54, 57, 62],
  'DADGAD': [38, 45, 50, 55, 57, 62],
};

let ctx = null;
let stream = null;
let analyser = null;
let buffer = null;
let rafId = null;
let recent = [];

const noteName = (midi) => NOTES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
const midiToFreq = (midi) => 440 * 2 ** ((midi - 69) / 12);

function audio() {
  ctx ??= new AudioContext();
  ctx.resume();
  return ctx;
}

// Normalized autocorrelation with parabolic interpolation; returns Hz or -1.
function detectPitch(buf, sampleRate) {
  let rms = 0;
  for (const v of buf) rms += v * v;
  if (Math.sqrt(rms / buf.length) < 0.01) return -1;

  const minLag = Math.floor(sampleRate / 1400);
  const maxLag = Math.floor(sampleRate / 60);
  const size = buf.length - maxLag;
  const corr = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < size; i++) {
      sum += buf[i] * buf[i + lag];
      e1 += buf[i] * buf[i];
      e2 += buf[i + lag] * buf[i + lag];
    }
    corr[lag] = sum / Math.sqrt(e1 * e2 || 1);
  }
  // First peak that is close to the best one avoids octave errors.
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) best = Math.max(best, corr[lag]);
  if (best < 0.85) return -1;
  let lag = minLag;
  while (lag < maxLag && !(corr[lag] > 0.93 * best && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1])) lag++;
  const [a, b, c] = [corr[lag - 1], corr[lag], corr[lag + 1]];
  const shift = (a - c) / (2 * (a - 2 * b + c)) || 0;
  return sampleRate / (lag + shift);
}

function loop() {
  analyser.getFloatTimeDomainData(buffer);
  const hz = detectPitch(buffer, ctx.sampleRate);
  if (hz > 0) {
    recent.push(hz);
    if (recent.length > 5) recent.shift();
    const sorted = [...recent].sort((x, y) => x - y);
    show(sorted[Math.floor(sorted.length / 2)]);
  }
  rafId = setTimeout(loop, 60); // ~16 checks a second keeps CPU low
}

function show(hz) {
  const midiFloat = 69 + 12 * Math.log2(hz / 440);
  const midi = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midi) * 100);
  const inTune = Math.abs(cents) <= 5;
  $('tn-note').textContent = noteName(midi);
  $('tn-note').classList.toggle('in-tune', inTune);
  $('tn-freq').textContent = `${hz.toFixed(1)} Hz`;
  $('tn-cents').textContent = inTune ? 'in tune' : `${cents > 0 ? '+' : ''}${cents} cents ${cents > 0 ? '(sharp)' : '(flat)'}`;
  $('tn-needle').style.left = `${50 + cents}%`;
}

async function start() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    $('tn-note').textContent = '–';
    $('tn-freq').textContent = 'Microphone blocked or unavailable: ' + err.message;
    return;
  }
  const c = audio();
  analyser = c.createAnalyser();
  analyser.fftSize = 4096;
  buffer = new Float32Array(analyser.fftSize);
  c.createMediaStreamSource(stream).connect(analyser);
  recent = [];
  loop();
  $('tn-go').textContent = 'Stop tuner';
}

export function stopTuner() {
  clearTimeout(rafId);
  rafId = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $('tn-go').textContent = 'Start tuner (uses mic)';
}

function playTone(midi) {
  const c = audio();
  const t = c.currentTime;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
  gain.connect(c.destination);
  // A couple of harmonics so low strings are audible on small speakers.
  [1, 2, 3].forEach((h, i) => {
    const osc = c.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = midiToFreq(midi) * h;
    const g = c.createGain();
    g.gain.value = [1, 0.5, 0.25][i];
    osc.connect(g).connect(gain);
    osc.start(t);
    osc.stop(t + 2.3);
  });
}

function renderStrings() {
  const notes = TUNINGS[$('tn-tuning').value];
  $('tn-strings').innerHTML = '';
  notes.forEach((midi, i) => {
    const b = document.createElement('button');
    b.textContent = `${6 - i}: ${noteName(midi)}`;
    b.addEventListener('click', () => playTone(midi));
    $('tn-strings').append(b);
  });
}

export function initTuner() {
  Object.keys(TUNINGS).forEach((name) => $('tn-tuning').add(new Option(name, name)));
  $('tn-tuning').addEventListener('change', renderStrings);
  renderStrings();
  $('tn-go').addEventListener('click', () => (stream ? stopTuner() : start()));
}
