// Analysis frame of the octave spectrogram.
//
// Pipeline per frame: Hann FFT + derivative-window FFT (frequency
// reassignment) -> Gaussian splat onto 3072 log-frequency bins (32 per
// semitone, MIDI 11.5..107.5) -> background subtraction -> harmonic
// min-sum salience boost -> background subtraction -> subharmonic
// suppression -> fold the 8 octaves into one (max) -> level gain.

const H = 32;                // harmonics considered by the salience kernels

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

function normInPlace(v) {
  let m = 0;
  for (let i = 0; i < v.length; i++) if (v[i] > m) m = v[i];
  if (m > 0) for (let i = 0; i < v.length; i++) v[i] /= m;
  return v;
}

// In-place iterative radix-2 complex FFT.
function makeFFT(n) {
  const levels = Math.log2(n) | 0;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tr = re[l] * cos[k] - im[l] * sin[k];
          const ti = re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tr; im[l] = im[j] - ti;
          re[j] += tr; im[j] += ti;
        }
      }
    }
  };
}

export class Analyzer {
  // Defaults: MIDI 12..108, 32 bins per semitone.
  constructor(N = 4096, fs = 22050, ref = 440, midiLo = 12, midiHi = 108, bps = 32) {
    this.N = N; this.fs = fs; this.ref = ref; this.bps = bps;
    this.m0 = midiLo - 0.5;
    const m1 = midiHi - 0.5;
    const B = this.B = Math.round((m1 - this.m0) * bps);          // 3072
    const K = this.K = N / 2 + 1;

    // Low-cut power weights and magnitude weights.
    this.A = new Float64Array(K); this.sqrtA = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      this.A[k] = 1 - Math.exp(-((Math.PI * k / (N >> 8)) ** 2));
      this.sqrtA[k] = Math.sqrt(this.A[k]);
    }
    this.hann = new Float64Array(N); this.dh = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      this.hann[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N);
      this.dh[n] = 0.5 * Math.sin(2 * Math.PI * n / N);       // (N/2pi) * d(hann)/dn
    }
    this.fft = makeFFT(N);
    this.re = new Float64Array(N); this.im = new Float64Array(N);

    // Harmonic offsets in bins, quantised to 1/65536 of a bin.
    this.offq = new Int32Array(H);
    let hsum = 0;
    for (let h = 1; h <= H; h++) { this.offq[h - 1] = Math.floor(12 * bps * Math.log2(h) * 65536 + 0.5); hsum += 1 / h; }
    this.hw = new Float64Array(H);
    for (let h = 1; h <= H; h++) this.hw[h - 1] = (1 / h) / hsum;
    this.nh = new Int32Array(B); this.ns = new Int32Array(B);
    for (let i = 0; i < B; i++) {
      let a = 0, b = 0;
      for (let h = 0; h < H; h++) {
        if (i + (this.offq[h] >> 16) + 1 < B) a++;
        if (i - ((this.offq[h] + 0xffff) >> 16) >= 0) b++;
      }
      this.nh[i] = a; this.ns[i] = b;
    }
    this.cop = [];
    for (let j = 0; j < H; j++) {
      const l = [];
      for (let k = j + 1; k < H; k++) if (gcd(j + 1, k + 1) === 1) l.push(k);
      this.cop.push(Int32Array.from(l));
    }
    this.setReference(ref);

    this.splatW = new Float64Array(16);
    this.tmpA = new Float64Array(H);
    this.S = {
      P: new Float64Array(K), pos: new Float64Array(K), M: new Float64Array(K),
      spread: new Float64Array(B), flat: new Float64Array(B), salience: new Float64Array(B),
      flat2: new Float64Array(B), clean: new Float64Array(B), ks: new Float64Array(B),
      cumsum: new Float64Array(B + 1), splat: new Float64Array(B + 32),
    };
    this.folded = new Float64Array(12 * bps);
    this.semis = new Float64Array(B / bps);
  }

  // Tuning reference (440 Hz by default). The
  // per-bin salience normaliser depends on it.
  setReference(ref) {
    this.ref = ref;
    const B = this.B, Bw = new Float64Array(B);
    for (let i = 0; i < B; i++) {
      const m = this.m0 + i / this.bps;
      Bw[i] = 1 - Math.exp(-((ref * Math.PI * 256 / this.fs * 2 ** ((m - 69) / 12)) ** 2));
    }
    const w = new Float64Array(B);
    for (let i = 0; i < B; i++) {
      const n = this.nh[i];
      if (!n) continue;
      let s = 0;
      for (let h = 0; h < n; h++) s += this.hw[h] * this.interp(Bw, i, this.offq[h]);
      w[i] = 1 / s;
    }
    this.salienceNorm = normInPlace(w);
  }

  interp(S, i, oq) {
    const q = Math.floor(oq / 65536), ip = i + q, fr = (oq - q * 65536) / 65536;
    if (fr === 0) return S[ip];
    return S[ip] + fr * (S[ip + 1] - S[ip]);
  }

  // 16-tap Gaussian, weight exp(-((j - p) * pi/8)^2),
  // normalised over the taps; values below ~1e-4 of the maximum are skipped.
  splat(pos, val, out) {
    const B = this.B, buf = this.S.splat, w = this.splatW;
    buf.fill(0);
    let vmax = 0;
    for (let k = 0; k < this.K; k++) if (val[k] > vmax) vmax = val[k];
    if (vmax <= 0) vmax = 1;
    for (let k = 0; k < this.K; k++) {
      const p = pos[k], v = val[k];
      if (p < 0 || !Number.isFinite(p) || v * 32767 / vmax < 4) continue;
      const b = Math.floor(p + 8 / 65536), fr = p - b;
      let ws = 0;
      for (let t = 0; t < 16; t++) { const d = (t - 7 - fr) * Math.PI / 8; w[t] = Math.exp(-d * d); ws += w[t]; }
      for (let t = 0; t < 16; t++) {
        const j = b - 7 + t + 16;
        if (j >= 0 && j < B + 32) buf[j] += v * w[t] / ws;
      }
    }
    for (let i = 0; i < B; i++) out[i] = buf[i + 16];
    return out;
  }

  // Subtract a 256-bin moving average, clamp at 0.
  bgsub(v, out) {
    const L = v.length, W = 256, h = W / 2, c = this.S.cumsum;
    c[0] = 0;
    for (let i = 0; i < L; i++) c[i + 1] = c[i] + v[i];
    for (let i = 0; i < L; i++) {
      const a = Math.min(Math.max(i - h, 0), L - W);
      out[i] = Math.max(0, v[i] - (c[a + W] - c[a]) / W);
    }
    return out;
  }

  // Min-sum over coprime harmonic pairs.
  kmin(S, i) {
    const n = this.nh[i];
    if (n < 2) return 0;
    const a = this.tmpA;
    for (let h = 0; h < n; h++) a[h] = this.interp(S, i, this.offq[h]) * this.hw[h];
    let out = 0;
    for (let j = 0; j < n - 1; j++) {
      const cj = this.cop[j];
      let s = 0;
      for (let q = 0; q < cj.length; q++) { const k = cj[q]; if (k < n) s += a[k]; }
      out += Math.min(a[j], s);
    }
    return out;
  }

  // Weighted subharmonic sum.
  ksub(S, out) {
    for (let i = 0; i < this.B; i++) {
      let s = 0;
      for (let h = 1; h < this.ns[i]; h++) s += this.interp(S, i, -this.offq[h]) * this.hw[h];
      out[i] = s;
    }
    return out;
  }

  // x: N time-ordered samples in [-1, 1].
  frame(x) {
    const { N, K, B, fs, bps } = this, S = this.S, re = this.re, im = this.im;
    // One complex FFT of z = x*hann + i*x*dh gives both real transforms.
    for (let n = 0; n < N; n++) { re[n] = x[n] * this.hann[n]; im[n] = x[n] * this.dh[n]; }
    this.fft(re, im);
    let level = 0;
    for (let k = 0; k < K; k++) {
      const k2 = (N - k) % N;
      const xr = (re[k] + re[k2]) / 2, xi = (im[k] - im[k2]) / 2;      // X = FFT(x*hann)
      const dr = (im[k] + im[k2]) / 2, di = (re[k2] - re[k]) / 2;      // D = FFT(x*dh)
      const P = xr * xr + xi * xi;
      S.P[k] = P;
      level += this.A[k] * P;
      // Reassigned frequency in bins: phi = k - Im(D * conj(X)) / P.
      const phi = P > 0 ? k - (di * xr - dr * xi) / P : 0;
      S.pos[k] = phi > 0 ? bps * (12 * Math.log2(phi * fs / N / this.ref) + 69 - this.m0) : -1;
    }
    level /= N * N;
    const r = Math.min(1, Math.sqrt(level) * 100);
    const gain = r > 0 ? Math.max(0, 30 + 20 * Math.log10(r)) / 30 : 0;   // 30 dB range

    let pm = 0;
    for (let k = 0; k < K; k++) { S.M[k] = Math.sqrt(S.P[k]); if (S.M[k] > pm) pm = S.M[k]; }
    for (let k = 0; k < K; k++) S.M[k] = (pm > 0 ? S.M[k] / pm : S.M[k]) * this.sqrtA[k];
    normInPlace(S.M);

    normInPlace(this.splat(S.pos, S.M, S.spread));
    normInPlace(this.bgsub(S.spread, S.flat));
    for (let i = 0; i < B; i++) S.salience[i] = S.flat[i] + 64 * this.kmin(S.flat, i);
    normInPlace(S.salience);
    for (let i = 0; i < B; i++) S.salience[i] *= this.salienceNorm[i];
    normInPlace(this.bgsub(S.salience, S.flat2));
    this.ksub(S.flat2, S.ks);
    for (let i = 0; i < B; i++) S.clean[i] = Math.max(0, S.flat2[i] - 2 * S.ks[i]);
    normInPlace(S.clean);

    // Octave fold (max over the 8 octaves) -> 384 rows.
    const rows = 12 * bps, f = this.folded;
    f.fill(0);
    for (let i = 0; i < B; i++) { const j = i % rows; if (S.clean[i] > f[j]) f[j] = S.clean[i]; }
    normInPlace(f);

    // Per-semitone strengths, 96 notes from C0: triangle-weighted.
    for (let s = 0; s < this.semis.length; s++) {
      let acc = 0;
      for (let j = 0; j < bps; j++) acc += S.flat2[s * bps + j] * (16 - Math.abs(j - 16)) / 16;
      this.semis[s] = acc;
    }
    return { level, gain, folded: f, semis: this.semis };
  }
}
