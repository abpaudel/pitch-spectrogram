// Analysis worker: resamples microphone audio to the analysis rate,
// frames it (hop = N/4, N/8 or N/16 by "Analysis Rate"), runs the
// analyzer and the per-pitch-class octave tracker, and posts one display
// column per frame.

import { Analyzer } from './dsp.js';

// "Sample Rate" option -> decimation of 44100.
const QUALITY_DIV = [4, 2, 1];
const RATE_DIV = [4, 8, 16];          // "Analysis Rate" Low / Medium / High

// Windowed-sinc fractional resampler.
class Resampler {
  constructor(fsIn, fsOut, taps = 16) {
    this.step = fsIn / fsOut;
    this.taps = taps;
    this.cut = Math.min(1, fsOut / fsIn) * 0.92;
    this.hist = new Float32Array(0);
    this.t = taps;                     // read position in hist
  }

  push(x) {
    const h = new Float32Array(this.hist.length + x.length);
    h.set(this.hist); h.set(x, this.hist.length);
    const out = [], L = this.taps, cut = this.cut;
    let t = this.t;
    while (t + L < h.length) {
      const c = Math.floor(t);
      let acc = 0, wsum = 0;
      for (let j = c - L + 1; j <= c + L; j++) {
        const d = t - j, a = Math.PI * cut * d;
        const s = a === 0 ? 1 : Math.sin(a) / a;
        const w = 0.42 + 0.5 * Math.cos(Math.PI * d / L) + 0.08 * Math.cos(2 * Math.PI * d / L);
        acc += h[j] * s * w; wsum += s * w;
      }
      out.push(acc / wsum);
      t += this.step;
    }
    const drop = Math.max(0, Math.floor(t) - L);
    this.hist = h.slice(drop);
    this.t = t - drop;
    return out;
  }
}

// Octave label tracker: a pitch class without a label takes its strongest
// octave immediately; after that, a new strongest octave takes over only
// after holding for 150 ms and being at least 1.5x stronger than the current one.
class OctaveTracker {
  constructor() {
    this.cur = new Int8Array(12).fill(-1);
    this.cand = new Int8Array(12).fill(-1);
    this.candTime = new Float64Array(12);
  }

  update(strength, now) {
    const v = new Float64Array(8);
    for (let pc = 0; pc < 12; pc++) {
      let best = 0;
      for (let o = 0; o < 8; o++) {
        v[o] = strength[o * 12 + pc];
        if (v[o] > v[best]) best = o;
      }
      if (this.cur[pc] < 0) {
        this.cur[pc] = best; this.cand[pc] = -1;
      } else if (best === this.cand[pc]) {
        if (now - this.candTime[pc] >= 150) { this.cur[pc] = this.cand[pc]; this.cand[pc] = -1; }
      } else if (best === this.cur[pc]) {
        this.cand[pc] = -1;
      } else {
        this.cand[pc] = best; this.candTime[pc] = now;
      }
      if (this.cur[pc] >= 0 && this.cand[pc] >= 0 && v[this.cand[pc]] < 1.5 * v[this.cur[pc]]) this.cand[pc] = -1;
    }
    return this.cur;
  }
}

let fsIn = 48000, settings = null, analyzer = null, resampler = null, tracker = new OctaveTracker();
let ring = null, frameBuf = null, ringPos = 0, sinceFrame = 0, hop = 0;

function configure() {
  const div = QUALITY_DIV[settings.quality];
  // 93 ms analysis frame; the hop is (8192/div)/{4,8,16}.
  const fs = 44100 / div, N = 4096 / div, hopBase = 8192 / div;
  if (!analyzer || analyzer.N !== N) analyzer = new Analyzer(N, fs, settings.ref);
  else if (analyzer.ref !== settings.ref) analyzer.setReference(settings.ref);
  resampler = new Resampler(fsIn, fs);
  // The ring starts as silence, so the first frame runs after one hop.
  ring = new Float64Array(N); frameBuf = new Float64Array(N);
  ringPos = 0; sinceFrame = 0;
  hop = hopBase / RATE_DIV[settings.rate];
}

function onSamples(x) {
  if (!analyzer) return;
  const y = resampler.push(x);
  const N = analyzer.N;
  for (let i = 0; i < y.length; i++) {
    ring[ringPos] = y[i];
    ringPos = (ringPos + 1) % N;
    if (++sinceFrame >= hop) { sinceFrame = 0; runFrame(); }
  }
}

// "Analysis Sensitivity": input boost in dB applied before the level gate.
const SENSITIVITY_DB = { low: -6, medium: 6, high: 18 };

// Level gate: full brightness from -40 dBFS RMS (minus the boost), fading
// to black over the 30 dB below that.
function levelGain(level, boostDb) {
  const r = Math.min(1, Math.sqrt(level) * 100 * 10 ** (boostDb / 20));
  return r > 0 ? Math.max(0, 30 + 20 * Math.log10(r)) / 30 : 0;
}

function runFrame() {
  const N = analyzer.N;
  frameBuf.set(ring.subarray(ringPos), 0);           // oldest sample first
  frameBuf.set(ring.subarray(0, ringPos), N - ringPos);
  const r = analyzer.frame(frameBuf);
  const g = levelGain(r.level, SENSITIVITY_DB[settings.sensitivity] ?? SENSITIVITY_DB.medium);
  const col = new Uint16Array(r.folded.length);
  for (let i = 0; i < col.length; i++) col[i] = Math.min(32767, Math.floor(r.folded[i] * g * 32767));
  const strength = new Float64Array(96);
  for (let s = 0; s < 96; s++) strength[s] = r.semis[s] * g;
  const octaves = Int8Array.from(tracker.update(strength, performance.now()));
  postMessage({ col, octaves }, [col.buffer]);
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    fsIn = m.sampleRate;
    m.port.onmessage = (ev) => onSamples(ev.data);
  }
  if (m.type === 'init' || m.type === 'settings') { settings = m.settings; configure(); }
};
