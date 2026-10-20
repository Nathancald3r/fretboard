// Output EQ for the player. alphaTab's synth connects its final node (an AudioWorklet or
// ScriptProcessor) straight to the speakers; we catch that connection and route it
// through a small tone chain instead, which takes the piercing top end off the
// built-in soundfont's guitars.

export const TONES = {
  warm: { label: 'Warm (default)', lowShelf: 2, presence: -5, highShelf: -10, lowpass: 5200 },
  balanced: { label: 'Balanced', lowShelf: 1, presence: -3, highShelf: -6, lowpass: 8000 },
  dark: { label: 'Dark', lowShelf: 3, presence: -7, highShelf: -14, lowpass: 3600 },
  bright: { label: 'Bright (original)', lowShelf: 0, presence: 0, highShelf: 0, lowpass: 20000 },
};
const KEY = 'fretboard-tone';

let current = 'warm';
try { if (TONES[localStorage.getItem(KEY)]) current = localStorage.getItem(KEY); } catch { /* ignore */ }

const chains = new Set();

function buildChain(ctx) {
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf'; low.frequency.value = 220;
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking'; presence.frequency.value = 2800; presence.Q.value = 1.1;
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf'; high.frequency.value = 4000;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass'; lowpass.Q.value = 0.6;
  // Gentle limiter so loud distorted parts don't clip.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
  const out = ctx.createGain();
  out.gain.value = 0.9;
  low.connect(presence).connect(high).connect(lowpass).connect(comp).connect(out).connect(ctx.destination);
  const chain = { ctx, input: low, low, presence, high, lowpass };
  apply(chain);
  chains.add(chain);
  return chain;
}

function apply(chain) {
  const t = TONES[current];
  const now = chain.ctx.currentTime;
  chain.low.gain.setTargetAtTime(t.lowShelf, now, 0.05);
  chain.presence.gain.setTargetAtTime(t.presence, now, 0.05);
  chain.high.gain.setTargetAtTime(t.highShelf, now, 0.05);
  chain.lowpass.frequency.setTargetAtTime(Math.min(t.lowpass, chain.ctx.sampleRate / 2 - 100), now, 0.05);
}

function chainFor(ctx) {
  for (const c of chains) if (c.ctx === ctx) return c;
  return buildChain(ctx);
}

// Only the synth's output node types are rerouted; the metronome (oscillators/gains)
// and tuner are unaffected.
function patch(NodeClass) {
  if (!NodeClass || NodeClass.prototype.__fretboardTone) return;
  const connect = NodeClass.prototype.connect;
  NodeClass.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) return connect.call(this, chainFor(this.context).input, ...rest);
    return connect.call(this, dest, ...rest);
  };
  NodeClass.prototype.__fretboardTone = true;
}

export function installTone() {
  patch(window.AudioWorkletNode);
  patch(window.ScriptProcessorNode);
}

export const getTone = () => current;

export function setTone(name) {
  if (!TONES[name]) return;
  current = name;
  try { localStorage.setItem(KEY, name); } catch { /* ignore */ }
  chains.forEach(apply);
}
