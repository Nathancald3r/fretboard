// AudioWorklet for the strum timing drill: the energy of every 64 mic samples (~1.3 ms),
// with the audio clock time of each, sent to the page about every 20 ms.
const HOP = 64;
const SEND = 16; // hops per message

class StrumTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.prev = 0;
    this.out = new Float32Array(SEND);
    this.n = 0;
    this.t0 = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let k = 0; k + HOP <= ch.length; k += HOP) {
      let sum = 0;
      for (let j = k; j < k + HOP; j++) { const d = ch[j] - this.prev; this.prev = ch[j]; sum += d * d; }
      if (this.n === 0) this.t0 = (currentFrame + k) / sampleRate;
      this.out[this.n++] = 10 * Math.log10(sum / HOP + 1e-12);
      if (this.n === SEND) {
        this.port.postMessage({ t0: this.t0, hop: HOP / sampleRate, db: this.out });
        this.out = new Float32Array(SEND);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('fretboard-strum-tap', StrumTap);
