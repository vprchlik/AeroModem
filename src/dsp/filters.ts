/**
 * FIR filter design + fast convolution — pure Float32Array math.
 *
 * Conventions:
 *   - All frequencies in Hz; `fs` = sample rate.
 *   - Kernels are linear-phase (symmetric), odd length; group delay = (taps−1)/2 samples.
 *   - fftConvolve returns the FULL linear convolution (length x + h − 1).
 */

import { FFT } from './fft';
import { assert } from '../util/assert';

/** Blackman window value at index n of an N-point window (used for FIR design). */
function blackman(n: number, N: number): number {
  const t = (2 * Math.PI * n) / (N - 1);
  return 0.42 - 0.5 * Math.cos(t) + 0.08 * Math.cos(2 * t);
}

/**
 * Windowed-sinc lowpass kernel.
 *   h[n] = sinc(2 fc/fs · (n − M/2)) · blackman(n),  normalized to unity DC gain.
 * Blackman gives ≈ −74 dB stopband; transition width ≈ 5.5 · fs / taps (Hz).
 */
export function designLowpassFir(taps: number, cutoffHz: number, fs: number): Float32Array {
  assert(taps % 2 === 1, 'FIR taps must be odd (linear phase, integer group delay)');
  assert(cutoffHz > 0 && cutoffHz < fs / 2, 'cutoff out of (0, Nyquist)');
  const h = new Float32Array(taps);
  const M = taps - 1;
  const fc = cutoffHz / fs; // cycles per sample
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const k = n - M / 2;
    const x = 2 * Math.PI * fc * k;
    const sinc = k === 0 ? 2 * Math.PI * fc : Math.sin(x) / k;
    const v = sinc * blackman(n, taps);
    h[n] = v;
    sum += v;
  }
  // Normalize so Σh = 1 (0 dB at DC).
  for (let n = 0; n < taps; n++) h[n]! /= sum;
  return h;
}

/**
 * Windowed-sinc bandpass kernel = LP(high) − LP(low).
 * Passband gain ≈ 1 between lowHz and highHz; Blackman stopband ≈ −74 dB.
 */
export function designBandpassFir(
  taps: number,
  lowHz: number,
  highHz: number,
  fs: number,
): Float32Array {
  assert(lowHz < highHz, 'bandpass requires lowHz < highHz');
  const lpHigh = designLowpassFir(taps, highHz, fs);
  const lpLow = designLowpassFir(taps, lowHz, fs);
  const h = new Float32Array(taps);
  for (let n = 0; n < taps; n++) h[n] = lpHigh[n]! - lpLow[n]!;
  return h;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Linear convolution via a single zero-padded FFT (frequency-domain multiply).
 * Output length = x.length + h.length − 1.
 * Time domain in, time domain out; internally frequency domain (complex product).
 */
export function fftConvolve(x: Float32Array, h: Float32Array): Float32Array {
  const outLen = x.length + h.length - 1;
  const n = nextPow2(outLen);
  const fft = new FFT(n);

  const xr = new Float32Array(n);
  const xi = new Float32Array(n);
  const hr = new Float32Array(n);
  const hi = new Float32Array(n);
  xr.set(x);
  hr.set(h);

  fft.forward(xr, xi);
  fft.forward(hr, hi);

  // (xr + j xi)(hr + j hi) — pointwise complex multiply in frequency domain.
  for (let k = 0; k < n; k++) {
    const ar = xr[k]!;
    const ai = xi[k]!;
    const br = hr[k]!;
    const bi = hi[k]!;
    xr[k] = ar * br - ai * bi;
    xi[k] = ar * bi + ai * br;
  }
  fft.inverse(xr, xi);
  return xr.slice(0, outLen);
}

/**
 * Convolve and re-align: returns exactly x.length samples with the kernel's
 * group delay (taps−1)/2 removed, so output[i] corresponds to input[i].
 * Use for zero-latency-style filtering with linear-phase FIRs.
 */
export function filterAligned(x: Float32Array, h: Float32Array): Float32Array {
  const full = fftConvolve(x, h);
  const delay = (h.length - 1) >> 1;
  return full.slice(delay, delay + x.length);
}

/**
 * Frequency-sampling FIR design from an arbitrary magnitude response.
 *
 * `magAt(fHz)` returns desired |H(f)| (linear, ≥ 0). The kernel is built by
 * inverse-FFT of a zero-phase magnitude grid (N = 4096 points), centering the
 * symmetric impulse response, and applying a Hann window of length `taps`.
 * Result is linear-phase with group delay (taps−1)/2 samples.
 *
 * Works well for SMOOTH targets (e.g. transducer roll-offs); do not use for
 * brick-wall specs.
 */
export function designFirFromMagnitude(
  magAt: (fHz: number) => number,
  taps: number,
  fs: number,
): Float32Array {
  assert(taps % 2 === 1, 'FIR taps must be odd');
  const N = 4096;
  assert(taps < N, 'taps must be < design grid size');
  const fft = new FFT(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let k = 0; k <= N / 2; k++) {
    const m = Math.max(0, magAt((k * fs) / N));
    re[k] = m;
    if (k > 0 && k < N / 2) re[N - k] = m; // Hermitian symmetry (real kernel)
  }
  fft.inverse(re, im);
  // Zero-phase kernel is centered at n=0 (wrapping negatively); rotate so the
  // center lands at (taps−1)/2, then Hann-window to length `taps`.
  const h = new Float32Array(taps);
  const M = (taps - 1) >> 1;
  for (let n = 0; n < taps; n++) {
    const src = (n - M + N) % N;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (taps - 1));
    h[n] = re[src]! * w;
  }
  return h;
}
