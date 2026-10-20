// AudioWorklet for singing mode: hands the last 2048 microphone samples to the page every
// 1024 samples (~21 ms), so pitch is checked at a steady rate even when the window is
// hidden behind your lyrics (animation frames stop there; worklet messages don't).
const SIZE = 2048;
const HOP = 1024;

class SingTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(SIZE);
    this.pos = 0;
    this.sinceSent = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.ring[this.pos] = ch[i];
        this.pos = (this.pos + 1) % SIZE;
      }
      this.sinceSent += ch.length;
      if (this.sinceSent >= HOP) {
        this.sinceSent = 0;
        const frame = new Float32Array(SIZE);
        frame.set(this.ring.subarray(this.pos));
        frame.set(this.ring.subarray(0, this.pos), SIZE - this.pos);
        this.port.postMessage(frame, [frame.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('fretboard-sing-tap', SingTap);
