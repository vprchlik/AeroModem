/**
 * Linear chirp generation — the synchronization preamble.
 *
 * A linear chirp sweeps instantaneous frequency f0 → f1 over n samples:
 *   φ(t) = 2π (f0 t + (f1−f0)/(2T) t²),   x[i] = sin(φ(i/fs))
 * Its autocorrelation is a narrow pulse (width ≈ fs / bandwidth samples),
 * which is what makes it a good matched-filter timing reference.
 *
 * A Tukey (tapered-cosine) window avoids spectral splatter and speaker clicks
 * at the edges without sacrificing much energy (taper on ~10% of each end).
 */

import { assert } from '../util/assert';

export function linearChirp(
  fs: number,
  f0: number,
  f1: number,
  n: number,
  taperFrac = 0.1,
): Float32Array {
  assert(n > 0, 'chirp length must be positive');
  assert(f0 > 0 && f1 > 0 && f0 < fs / 2 && f1 <= fs / 2, 'chirp band out of range');
  const out = new Float32Array(n);
  const T = n / fs; // duration in seconds
  const k = (f1 - f0) / T; // sweep rate, Hz per second
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const phase = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);
    out[i] = Math.sin(phase);
  }
  // Tukey taper: raised-cosine ramps over `taper` samples at each end.
  const taper = Math.min(Math.floor(n * taperFrac), n >> 1);
  for (let i = 0; i < taper; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / taper);
    out[i]! *= g;
    out[n - 1 - i]! *= g;
  }
  return out;
}
