/**
 * Measurement helpers used by tests, the simulator, and the bench harness.
 * All pure Float32Array; frequencies in Hz.
 */

import { FFT } from './fft';
import { hann } from './window';
import { assert } from '../util/assert';

/**
 * Welch-averaged band power. Splits `x` into 50%-overlapped Hann segments of
 * `segLen`, averages periodograms, and sums the bins whose center frequency
 * lies in [loHz, hiHz]. Returns power in dB (relative units — consistent for
 * ratios like SNR; not calibrated to absolute dBFS).
 */
export function bandPowerDb(
  x: Float32Array,
  fs: number,
  loHz: number,
  hiHz: number,
  segLen = 4096,
): number {
  assert(loHz < hiHz, 'bandPowerDb: loHz must be < hiHz');
  assert(x.length >= segLen, `bandPowerDb: need ≥ ${segLen} samples`);
  const fft = new FFT(segLen);
  const win = hann(segLen);
  const re = new Float32Array(segLen);
  const im = new Float32Array(segLen);
  const hop = segLen >> 1;
  const nSeg = Math.floor((x.length - segLen) / hop) + 1;

  const binLo = Math.max(0, Math.ceil((loHz * segLen) / fs));
  const binHi = Math.min(segLen / 2, Math.floor((hiHz * segLen) / fs));

  let acc = 0;
  for (let s = 0; s < nSeg; s++) {
    const off = s * hop;
    for (let i = 0; i < segLen; i++) {
      re[i] = x[off + i]! * win[i]!;
      im[i] = 0;
    }
    fft.forward(re, im);
    let p = 0;
    for (let k = binLo; k <= binHi; k++) {
      p += re[k]! * re[k]! + im[k]! * im[k]!;
    }
    acc += p;
  }
  const mean = acc / Math.max(1, nSeg);
  return 10 * Math.log10(Math.max(mean, 1e-30));
}

/**
 * In-band SNR between a clean reference and an impaired copy of the SAME
 * alignment/length: noise := noisy − clean (sample-wise), then
 * SNR = bandPower(clean) − bandPower(noise) in dB over [loHz, hiHz].
 */
export function measureSnrDb(
  clean: Float32Array,
  noisy: Float32Array,
  fs: number,
  loHz: number,
  hiHz: number,
): number {
  const n = Math.min(clean.length, noisy.length);
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = noisy[i]! - clean[i]!;
  return (
    bandPowerDb(clean.subarray(0, n), fs, loHz, hiHz) -
    bandPowerDb(noise, fs, loHz, hiHz)
  );
}

/**
 * High-precision single-tone frequency estimate: Hann-windowed FFT over the
 * largest power-of-two prefix, then 3-point parabolic interpolation on
 * log-magnitude around the peak bin. Error ≪ 0.05 bin for a clean tone.
 * Optional [loHz, hiHz] restricts the peak search (e.g. to the modem band,
 * when out-of-band distortion products could out-power the tone).
 */
export function estimateToneFreqHz(
  x: Float32Array,
  fs: number,
  loHz?: number,
  hiHz?: number,
): number {
  let n = 1;
  while (n * 2 <= x.length) n *= 2;
  assert(n >= 1024, 'estimateToneFreqHz: need ≥ 1024 samples');
  const fft = new FFT(n);
  const win = hann(n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = x[i]! * win[i]!;
    im[i] = 0;
  }
  fft.forward(re, im);

  const kLo = Math.max(1, loHz !== undefined ? Math.ceil((loHz * n) / fs) : 1);
  const kHi = Math.min(n / 2 - 1, hiHz !== undefined ? Math.floor((hiHz * n) / fs) : n / 2 - 1);
  let peak = kLo;
  let peakMag = 0;
  for (let k = kLo; k <= kHi; k++) {
    const m = re[k]! * re[k]! + im[k]! * im[k]!;
    if (m > peakMag) {
      peakMag = m;
      peak = k;
    }
  }
  const mag = (k: number) =>
    Math.log(Math.max(1e-30, Math.hypot(re[k]!, im[k]!)));
  const a = mag(peak - 1);
  const b = mag(peak);
  const c = mag(peak + 1);
  const denom = a - 2 * b + c;
  const delta = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
  return ((peak + delta) * fs) / n;
}

/**
 * Total harmonic distortion ratio: Σ power at k·f0 (k=2…nHarmonics) / power at f0.
 * Each component measured in a ±(1.5·binWidth·segLen) window via bandPowerDb.
 */
export function thdRatio(
  x: Float32Array,
  fs: number,
  f0: number,
  nHarmonics = 8,
  segLen = 8192,
): number {
  const halfBw = (1.5 * fs) / segLen;
  const fundDb = bandPowerDb(x, fs, f0 - halfBw, f0 + halfBw, segLen);
  let harm = 0;
  for (let k = 2; k <= nHarmonics; k++) {
    const fk = k * f0;
    if (fk + halfBw >= fs / 2) break;
    harm += Math.pow(10, bandPowerDb(x, fs, fk - halfBw, fk + halfBw, segLen) / 10);
  }
  return harm / Math.pow(10, fundDb / 10);
}

/** RMS of a buffer. */
export function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, x.length));
}
