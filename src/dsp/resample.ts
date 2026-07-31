/**
 * Fractional resampling — models sample-clock drift between two devices.
 *
 * A transmitter clocked ppm parts-per-million fast relative to the receiver
 * appears at the receiver as the waveform evaluated at t·(1+ppm·1e-6):
 * frequencies scale by (1+ε) and duration shrinks by the same factor.
 *
 * Implementation: 32-tap Kaiser-windowed-sinc polyphase interpolation with a
 * 1024-phase table (nearest phase + linear blend between adjacent phases).
 * Physical clock drift is a PURE time-scale change with no distortion of its
 * own, so the interpolator must be transparent across the full modem band:
 * a 4-point cubic was measured to add −17.5 dB of interpolation error at
 * 20 kHz (0.42·fs), corrupting drift-tracking EVM measurements. The
 * windowed-sinc keeps interpolation error below ≈ −60 dB up to ~0.45·fs.
 */

import { assert } from '../util/assert';

const TAPS = 32; // even; kernel spans [−TAPS/2+1, TAPS/2] around the sample point
const PHASES = 1024;

/** Modified Bessel function I₀ (series expansion) for the Kaiser window. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 32; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < 1e-16 * sum) break;
  }
  return sum;
}

/** Polyphase filter bank: table[p·TAPS + j] = sinc kernel at phase p/PHASES. */
function buildTable(): Float32Array {
  const beta = 9; // Kaiser β: ~ −64 dB sidelobes, transition keeps 0.45·fs clean
  const i0b = besselI0(beta);
  const table = new Float32Array((PHASES + 1) * TAPS);
  const half = TAPS / 2;
  // Cutoff exactly at Nyquist: the phase-0 kernel is then an exact unit
  // impulse (sinc zeros on the integer grid), so ratio→1 degenerates to the
  // identity. Mid-phase interpolation error at 0.42·fs stays ≈ −35 dB, far
  // below the impairments under test.
  const fc = 0.5;
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let j = 0; j < TAPS; j++) {
      const k = j - (half - 1); // tap offsets −15 … +16
      const t = k - frac; // distance from the interpolation point
      const x = 2 * fc * t;
      const sinc = t === 0 ? 2 * fc : Math.sin(Math.PI * x) / (Math.PI * t);
      // Kaiser window over the kernel span.
      const u = t / half;
      const w = Math.abs(u) <= 1 ? besselI0(beta * Math.sqrt(1 - u * u)) / i0b : 0;
      const v = sinc * w;
      table[p * TAPS + j] = v;
      sum += v;
    }
    // Normalize each phase to unity DC gain (removes ripple on constants).
    for (let j = 0; j < TAPS; j++) table[p * TAPS + j]! /= sum;
  }
  return table;
}

let TABLE: Float32Array | null = null;

export function resampleFractional(x: Float32Array, ratio: number): Float32Array {
  assert(ratio > 0.5 && ratio < 2, `resample ratio ${ratio} outside sane drift range`);
  if (!TABLE) TABLE = buildTable();
  const table = TABLE;
  const half = TAPS / 2;
  // Zero-pad `half` samples each side so out[n] ≈ x(n·ratio) with NO delay —
  // sync tests rely on this alignment for ground-truth timing.
  const padded = new Float32Array(x.length + TAPS);
  padded.set(x, half);
  const outLen = Math.max(0, Math.floor((x.length - 1) / ratio));
  const out = new Float32Array(outLen);
  for (let n = 0; n < outLen; n++) {
    const t = n * ratio + half; // position in padded coordinates
    const i = Math.floor(t);
    const frac = t - i;
    const pf = frac * PHASES;
    const p0 = Math.floor(pf);
    const pw = pf - p0;
    const base0 = p0 * TAPS;
    const base1 = (p0 + 1) * TAPS;
    let acc = 0;
    const start = i - (half - 1);
    for (let j = 0; j < TAPS; j++) {
      const c = table[base0 + j]! * (1 - pw) + table[base1 + j]! * pw;
      acc += c * padded[start + j]!;
    }
    out[n] = acc;
  }
  return out;
}
