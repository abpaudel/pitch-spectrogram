// Landing-page demo: synthesizes spectrogram columns directly (no audio,
// no analysis) for a random sung line, so the view can play behind the
// start screen.
//
// One voice random-walks a major scale in legato phrases separated by
// rests, with glides into some notes, delayed vibrato on some long notes
// and a faint 3rd harmonic (a fifth above, once folded). Each column is a
// Gaussian ridge at the voice's pitch class plus clumped background
// speckle and a faint broadband streak at phrase onsets.

import { ROWS, SUBROWS } from './view.js';

export const DEMO_RATE = 43;            // columns per second, as Analysis Rate Medium
const DT = 1 / DEMO_RATE;
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const STEPS = [-2, -1, -1, -1, 1, 1, 1, 2, -3, 3, -4, 4];
const LOW = 55, HIGH = 81;              // MIDI G3..A5

const rand = (a, b) => a + Math.random() * (b - a);
// MIDI note of scale index d (7 per octave) in the major key on pitch class key.
const scaleMidi = (key, d) => key + 12 * Math.floor(d / 7) + MAJOR[((d % 7) + 7) % 7];

// Folded row of MIDI pitch p: row r is semitone r/SUBROWS - 0.5 above C.
const pitchRow = (p) => ((((p % 12) + 12) % 12) + 0.5) * SUBROWS;

// Max-in a Gaussian bump of the given height at a (fractional) row,
// wrapping between B and C.
function blob(lv, center, sigma, a) {
  const reach = Math.ceil(3 * sigma);
  for (let k = -reach; k <= reach; k++) {
    const r = Math.round(center) + k, d = r - center;
    const i = ((r % ROWS) + ROWS) % ROWS;
    lv[i] = Math.max(lv[i], a * Math.exp(-d * d / (2 * sigma * sigma)));
  }
}

export class Demo {
  constructor() {
    this.key = Math.floor(Math.random() * 12);
    this.degree = 7 * 4 + Math.floor(Math.random() * 7);   // scale index around octave 4
    this.pitch = scaleMidi(this.key, this.degree);         // sounding pitch, MIDI
    this.level = 0;                                        // smoothed loudness
    this.drift = 0;                                        // slow pitch wander, semitones
    this.prev = NaN;                                       // last drawn pitch in this phrase
    this.phraseLeft = 0;
    // Every note is labeled from the start, as the real tracker labels each
    // note from whatever octave the first frame's noise favors; sung notes
    // then relabel their own row.
    this.octaves = Int8Array.from({ length: 12 }, () => 1 + Math.floor(Math.random() * 5));
    this.newNote();
  }

  // Next event. Notes come in legato phrases of 3-8 that change pitch without
  // a break; a rest separates phrases.
  newNote() {
    this.t = 0;
    if (this.phraseLeft === 0 && !this.rest && this.level > 0) {
      this.rest = true;
      this.dur = rand(0.2, 0.7);
      return;
    }
    const phraseStart = this.phraseLeft === 0;
    if (phraseStart) this.phraseLeft = 3 + Math.floor(Math.random() * 6);
    this.phraseLeft--;
    this.rest = false;
    let d;
    do d = this.degree + STEPS[Math.floor(Math.random() * STEPS.length)];
    while (scaleMidi(this.key, d) < LOW || scaleMidi(this.key, d) > HIGH);
    this.degree = d;
    this.target = scaleMidi(this.key, d);
    this.dur = rand(0.25, 1.2);
    // Pitch changes: about a quarter glide; the rest take anywhere from a
    // column or two to about a tenth of a second (time constant 15-50 ms,
    // log-uniform). A phrase starts on its note, or now and then scoops up to it.
    const slow = Math.random() < 0.25;
    this.tau = slow ? rand(0.06, 0.14) : 0.015 * 3.5 ** Math.random();
    if (phraseStart) {
      this.pitch = slow ? this.target - rand(0.5, 1.5) : this.target;
      this.prev = NaN;
    }
    // Vibrato on some longer notes only, in semitones.
    this.vibDepth = this.dur > 0.8 && Math.random() < 0.35 ? rand(0.1, 0.22) : 0;
    this.vibRate = rand(4, 5.5);
    this.vibPhase = Math.random() * 2 * Math.PI;
    this.amp = rand(0.75, 1);
    this.onset = phraseStart;
  }

  // One display column: Q15 levels for ROWS sub-rows, plus octave labels.
  column() {
    const col = new Uint16Array(ROWS);
    const lv = new Float32Array(ROWS);
    for (let n = 0; n < 14; n++) {                         // background speckle
      const a = Math.random();
      blob(lv, Math.random() * ROWS, rand(1, 3), a * a * a * 0.35);
    }
    if (this.onset) {
      for (let i = 0; i < ROWS; i++) lv[i] = Math.max(lv[i], Math.random() * 0.12);
      this.onset = false;
    }
    // Loudness eases between notes and fades in and out around rests.
    const goal = this.rest ? 0 : this.amp;
    this.level += (goal - this.level) * (1 - Math.exp(-DT / (this.rest ? 0.06 : 0.03)));
    if (this.level < 0.02 && this.rest) this.level = 0;
    if (!this.rest) this.pitch += (this.target - this.pitch) * (1 - Math.exp(-DT / this.tau));
    this.drift = 0.97 * this.drift + rand(-0.012, 0.012);
    const vib = this.rest ? 0 : this.vibDepth * Math.min(1, Math.max(0, (this.t - 0.25) / 0.3))
      * Math.sin(this.vibPhase + 2 * Math.PI * this.vibRate * this.t);
    const p = this.pitch + vib + this.drift;
    if (this.level > 0) {
      // A fast pitch change sweeps across rows within one frame, so draw
      // the path from the previous pitch, fainter than the held note.
      const span = p - this.prev, steps = span ? Math.ceil(Math.abs(span) * SUBROWS / 2) : 0;
      for (let k = 0; k < steps; k++) {
        const q = this.prev + span * k / steps;
        blob(lv, pitchRow(q), 1.5, this.level * 0.35);
        blob(lv, pitchRow(q + 19), 1.5, this.level * 0.07);
      }
      blob(lv, pitchRow(p), 2.5, this.level);
      blob(lv, pitchRow(p + 19), 2.5, this.level * 0.2);   // 3rd harmonic
      const pc = ((Math.round(p) % 12) + 12) % 12;
      this.octaves[pc] = Math.floor(Math.round(p) / 12) - 1;
    }
    this.prev = p;
    for (let i = 0; i < ROWS; i++) col[i] = Math.min(32767, lv[i] * 32767) | 0;
    this.t += DT;
    if (this.t >= this.dur) this.newNote();
    return col;
  }
}
