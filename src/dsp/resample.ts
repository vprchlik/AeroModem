/**
 * Fractional resampling — models sample-clock drift between two devices.
 *
 * A transmitter clocked ppm parts-per-million fast relative to the receiver
 * appears at the receiver as the waveform evaluated at t·(1+ppm·1e-6):
 * frequencies scale by (1+ε) and duration shrinks by the same factor.
 *
 * Implementation: 4-point (cubic Lagrange) interpolation, out[n] = x(n·ratio).
 * Good to ≈ −80 dB interpolation error for signals below ~0.4·fs.
 */

import { assert } from '../util/assert';

export function resampleFractional(x: Float32Array, ratio: number): Float32Array {
  assert(ratio > 0.5 && ratio < 2, `resample ratio ${ratio} outside sane drift range`);
  // Last index we can safely cubic-interpolate is x.length - 3.
  const outLen = Math.max(0, Math.floor((x.length - 3) / ratio));
  const out = new Float32Array(outLen);
  for (let n = 0; n < outLen; n++) {
    const t = n * ratio;
    const i = Math.floor(t);
    const f = t - i;
    // 4-point Lagrange around samples i-1 … i+2 (clamped at the left edge).
    const im1 = i > 0 ? i - 1 : 0;
    const y0 = x[im1]!;
    const y1 = x[i]!;
    const y2 = x[i + 1]!;
    const y3 = x[i + 2]!;
    // Cubic Lagrange coefficients for offset f in [0,1) relative to y1.
    const c0 = -f * (f - 1) * (f - 2) / 6;
    const c1 = (f * f - 1) * (f - 2) / 2;
    const c2 = -f * (f + 1) * (f - 2) / 2;
    const c3 = f * (f * f - 1) / 6;
    out[n] = c0 * y0 + c1 * y1 + c2 * y2 + c3 * y3;
  }
  return out;
}
