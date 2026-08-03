/**
 * Radix-2 Cooley–Tukey FFT — pure Float32Array math, no Web Audio types.
 *
 * Domain convention:
 *   - Time-domain buffer: length N real (or complex via parallel re/im arrays).
 *   - Frequency-domain: bin k corresponds to frequency k · (sampleRate / N) Hz
 *     for k = 0 … N/2 (Nyquist). Negative frequencies live in bins N/2+1 … N−1
 *     (standard DFT ordering).
 *   - forward: time → frequency (unnormalized DFT).
 *   - inverse: frequency → time, scaled by 1/N so forward∘inverse = identity.
 *
 * Twiddle factors W_N^k = exp(−j 2π k / N) are precomputed once in the constructor
 * so the hot path is allocation-free.
 */

import { assertPowerOfTwo } from '../util/assert';

export class FFT {
  readonly size: number;
  /** Cosine of twiddle angles: cos(2π k / N) for k = 0 … N/2 − 1 (shared by fwd/inv). */
  private readonly cos: Float32Array;
  /** Sine of twiddle angles: sin(2π k / N). Forward uses −sin; inverse uses +sin. */
  private readonly sin: Float32Array;
  /** Bit-reversal permutation table. */
  private readonly rev: Uint32Array;

  constructor(size: number) {
    assertPowerOfTwo(size, 'FFT size');
    this.size = size;
    const half = size >> 1;
    this.cos = new Float32Array(half);
    this.sin = new Float32Array(half);
    for (let k = 0; k < half; k++) {
      const angle = (2 * Math.PI * k) / size;
      this.cos[k] = Math.cos(angle);
      this.sin[k] = Math.sin(angle);
    }
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let y = 0;
      for (let b = 0; b < bits; b++) {
        y = (y << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = y;
    }
  }

  /** In-place forward DFT. `re`/`im` are length-N time-domain samples → spectrum. */
  forward(re: Float32Array, im: Float32Array): void {
    this.transform(re, im, false);
  }

  /** In-place inverse DFT with 1/N scaling. Spectrum → time domain. */
  inverse(re: Float32Array, im: Float32Array): void {
    this.transform(re, im, true);
    const n = this.size;
    const scale = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i]! *= scale;
      im[i]! *= scale;
    }
  }

  private transform(re: Float32Array, im: Float32Array, inverse: boolean): void {
    const n = this.size;
    if (re.length < n || im.length < n) {
      throw new Error(`FFT buffers must be ≥ ${n}`);
    }

    // Bit-reversal permutation (out-of-place via swaps).
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        let t = re[i]!;
        re[i] = re[j]!;
        re[j] = t;
        t = im[i]!;
        im[i] = im[j]!;
        im[j] = t;
      }
    }

    const cos = this.cos;
    const sin = this.sin;
    // Sign: forward uses e^{−jθ} → −sin; inverse uses e^{+jθ} → +sin.
    const sign = inverse ? 1 : -1;

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const wr = cos[k]!;
          const wi = sign * sin[k]!;
          const i0 = i + j;
          const i1 = i0 + half;
          const tr = wr * re[i1]! - wi * im[i1]!;
          const ti = wr * im[i1]! + wi * re[i1]!;
          re[i1] = re[i0]! - tr;
          im[i1] = im[i0]! - ti;
          re[i0] = re[i0]! + tr;
          im[i0] = im[i0]! + ti;
        }
      }
    }
  }
}

/**
 * Real-input power spectrum in dBFS (0 dB = amplitude 1.0 peak sine → bin mag N/2).
 *
 * Steps:
 *   1. Copy `x` (length ≥ fft.size) into scratch, apply `win`, zero imag.
 *   2. Forward FFT.
 *   3. For bins 0…N/2 write 20·log10(|X[k]| / ref) into `out` (length N/2+1).
 *
 * `out` is overwritten; values below `floorDb` are clamped (avoids −∞).
 */
export function realSpectrumDb(
  x: Float32Array,
  fft: FFT,
  win: Float32Array,
  out: Float32Array,
  scratchRe?: Float32Array,
  scratchIm?: Float32Array,
  floorDb = -100,
): void {
  const n = fft.size;
  const re = scratchRe ?? new Float32Array(n);
  const im = scratchIm ?? new Float32Array(n);
  if (re.length < n || im.length < n || win.length < n || out.length < n / 2 + 1) {
    throw new Error('realSpectrumDb: buffer length mismatch');
  }
  if (x.length < n) {
    throw new Error(`realSpectrumDb: need ≥ ${n} input samples`);
  }

  for (let i = 0; i < n; i++) {
    re[i] = x[i]! * win[i]!;
    im[i] = 0;
  }
  fft.forward(re, im);

  // Reference: peak magnitude of a unit-amplitude windowed cosine ≈ (coherentGain)·N/2.
  // We report relative to N/2 so an unwindowed unit sine sits near 0 dBFS.
  const ref = n / 2;
  const nBins = n / 2 + 1;
  for (let k = 0; k < nBins; k++) {
    const mag = Math.hypot(re[k]!, im[k]!);
    const db = 20 * Math.log10(Math.max(mag / ref, 1e-20));
    out[k] = db < floorDb ? floorDb : db;
  }
}
