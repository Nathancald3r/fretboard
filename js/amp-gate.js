// Noise gate AudioWorklet for the amp simulator (loaded by js/amp.js).
// Opens fast when the input envelope crosses the threshold, holds briefly, then fades
// out; a few dB of hysteresis stops it chattering on decaying notes.
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'threshold', defaultValue: -70, minValue: -100, maxValue: 0, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.env = 0;
    this.gain = 1;
    this.hold = 0;
    const sr = sampleRate;
    this.envAttack = Math.exp(-1 / (0.0005 * sr));
    this.envRelease = Math.exp(-1 / (0.03 * sr));
    this.openCoef = Math.exp(-1 / (0.001 * sr));
    this.closeCoef = Math.exp(-1 / (0.08 * sr));
    this.holdSamples = Math.round(0.05 * sr);
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input.length) return true;
    const thresholdDb = params.threshold[0];
    const bypass = thresholdDb <= -96;
    const open = 10 ** (thresholdDb / 20);
    const close = open * 0.6; // ~4.4 dB hysteresis
    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (const ch of input) peak = Math.max(peak, Math.abs(ch[i]));
      this.env = peak > this.env ? this.envAttack * this.env + (1 - this.envAttack) * peak : this.envRelease * this.env + (1 - this.envRelease) * peak;
      let target = this.gain > 0.5 ? 1 : 0;
      if (bypass || this.env > open) { target = 1; this.hold = this.holdSamples; }
      else if (this.env < close) { if (this.hold > 0) this.hold--; else target = 0; }
      const coef = target > this.gain ? this.openCoef : this.closeCoef;
      this.gain = coef * this.gain + (1 - coef) * target;
      for (let c = 0; c < output.length; c++) output[c][i] = (input[c] || input[0])[i] * this.gain;
    }
    return true;
  }
}

registerProcessor('fretboard-gate', GateProcessor);
