/**
 * Window functions for spectral analysis.
 * Pure Float32Array — no audio-API types.
 */

/** Hann window: w[n] = 0.5 − 0.5·cos(2π n / (N−1)), n = 0…N−1. Coherent gain = 0.5. */
export function hann(size: number, out?: Float32Array): Float32Array {
  const w = out ?? new Float32Array(size);
  if (w.length < size) throw new Error('hann: output too short');
  if (size === 1) {
    w[0] = 1;
    return w;
  }
  const denom = size - 1;
  for (let n = 0; n < size; n++) {
    w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / denom);
  }
  return w;
}

/** Mean of the window (= coherent gain for a tone at bin center). */
export function coherentGain(win: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < win.length; i++) sum += win[i]!;
  return sum / win.length;
}
