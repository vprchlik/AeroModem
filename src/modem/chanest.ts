/**
 * Least-squares channel estimation from the two training symbols.
 *
 * Model per active bin k (after FFT of a CP-stripped symbol window):
 *   Y[k] = H[k] · X[k] + W[k],   X[k] = known training value (±1)
 *
 * The two training symbols are one OFDM symbol apart in time; sample-clock
 * drift rotates the second by a phase ramp e^{−j2πkδ/N} (δ = timing slip per
 * symbol, samples). We estimate that ramp FIRST (it is also our initial drift
 * rate), de-rotate Y2, then average for the LS estimate and estimate the noise
 * variance from the residual difference.
 */

import type { ModemConfig, DerivedConfig } from '../config';

export interface ChannelEstimate {
  /** Ĥ real/imag per ACTIVE bin (binLow…binHigh order). */
  hRe: Float32Array;
  hIm: Float32Array;
  /** Per-bin noise variance σ² (single white estimate). */
  noiseVar: number;
  /** Estimated timing drift per symbol, in samples (from T1→T2 phase slope). */
  driftPerSymbol: number;
  /** Per-active-bin SNR estimate |Ĥ|²/σ² (linear). */
  snrLin: Float32Array;
}

/**
 * y1/y2: FFT outputs of the two training symbols, ACTIVE BINS ONLY
 * (re/im arrays of length nActive). train: known ±1 per active bin.
 */
export function estimateChannel(
  cfg: ModemConfig,
  d: DerivedConfig,
  y1Re: Float32Array,
  y1Im: Float32Array,
  y2Re: Float32Array,
  y2Im: Float32Array,
  train: Float32Array,
): ChannelEstimate {
  const n = d.nActive;
  const N = cfg.fftSize;

  // 1) Drift slope from T1→T2: φ_k = arg(Y2 · conj(Y1)) ≈ −2πkδ/N.
  //    Weighted least-squares fit of φ_k vs absolute bin k, weights |Y1|².
  let sw = 0;
  let swk = 0;
  let swkk = 0;
  let swp = 0;
  let swkp = 0;
  for (let i = 0; i < n; i++) {
    const cr = y2Re[i]! * y1Re[i]! + y2Im[i]! * y1Im[i]!;
    const ci = y2Im[i]! * y1Re[i]! - y2Re[i]! * y1Im[i]!;
    const phi = Math.atan2(ci, cr); // small per-bin rotation, no unwrap needed
    const wgt = y1Re[i]! * y1Re[i]! + y1Im[i]! * y1Im[i]!;
    const k = d.binLow + i;
    sw += wgt;
    swk += wgt * k;
    swkk += wgt * k * k;
    swp += wgt * phi;
    swkp += wgt * k * phi;
  }
  const denom = sw * swkk - swk * swk;
  const slope = denom !== 0 ? (sw * swkp - swk * swp) / denom : 0;
  const intercept = sw !== 0 ? (swp - slope * swk) / sw : 0;
  const driftPerSymbol = (-slope * N) / (2 * Math.PI);

  // 2) De-rotate Y2 by the fitted ramp, then average with Y1.
  const hRe = new Float32Array(n);
  const hIm = new Float32Array(n);
  let noiseAcc = 0;
  for (let i = 0; i < n; i++) {
    const k = d.binLow + i;
    const ang = -(intercept + slope * k);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const r2 = y2Re[i]! * c - y2Im[i]! * s;
    const i2 = y2Re[i]! * s + y2Im[i]! * c;
    const avgRe = 0.5 * (y1Re[i]! + r2);
    const avgIm = 0.5 * (y1Im[i]! + i2);
    // LS: Ĥ = Y_avg / X, X = ±1 ⇒ divide = multiply by ±1.
    const x = train[i]!;
    hRe[i] = avgRe * x;
    hIm[i] = avgIm * x;
    // Noise: (Y1 − Y2rot)/2 has variance σ²/2 per complex dim… accumulate |d|².
    const dr = y1Re[i]! - r2;
    const di = y1Im[i]! - i2;
    noiseAcc += dr * dr + di * di;
  }
  // |Y1−Y2|² has expectation 2σ² per bin ⇒ σ² = mean/2.
  const noiseVar = Math.max(noiseAcc / (2 * n), 1e-12);

  const snrLin = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    snrLin[i] = (hRe[i]! * hRe[i]! + hIm[i]! * hIm[i]!) / noiseVar;
  }

  return { hRe, hIm, noiseVar, driftPerSymbol, snrLin };
}
