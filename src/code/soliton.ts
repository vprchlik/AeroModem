/**
 * Robust soliton degree distribution (Luby 2002).
 *
 * Ideal soliton ρ: ρ(1)=1/K, ρ(d)=1/(d(d−1)) for d=2…K.
 * Robust tail τ: spikes mass near d ≈ K/R where R = c·ln(K/δ)·√K, so peeling
 * rarely stalls with fewer than ~K packets.
 *
 * Parameters (c, δ) live in ModemConfig; Phase 5 measures empirical overhead ε
 * rather than assuming the planning 8% figure.
 */

import { assert } from '../util/assert';

/**
 * Build the robust-soliton CDF over degrees 1…K (index 0 unused; cdf[d] =
 * P(D ≤ d)). Returns a Float64Array of length K+1.
 */
export function robustSolitonCdf(K: number, c: number, delta: number): Float64Array {
  assert(K >= 1, 'K must be ≥ 1');
  assert(c > 0 && delta > 0 && delta < 1, 'invalid robust-soliton parameters');

  // Clamp R≥1: for small K (c·ln(K/δ)·√K < 1) the robust spike is weak and
  // mean overhead rises — Phase 5 measures this rather than retuning (c, δ).
  const R = Math.max(1, c * Math.log(K / delta) * Math.sqrt(K));

  const mu = new Float64Array(K + 1);
  // Ideal soliton ρ.
  mu[1] = 1 / K;
  for (let d = 2; d <= K; d++) mu[d] = 1 / (d * (d - 1));

  // Robust component τ.
  const bound = Math.floor(K / R);
  for (let d = 1; d <= K; d++) {
    let tau = 0;
    if (d < bound) tau = R / (d * K);
    else if (d === bound) tau = (R * Math.log(R / delta)) / K;
    // d > bound: τ = 0
    mu[d]! += tau;
  }

  let z = 0;
  for (let d = 1; d <= K; d++) z += mu[d]!;
  assert(z > 0, 'soliton mass is zero');

  const cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += mu[d]! / z;
    cdf[d] = acc;
  }
  cdf[K] = 1; // guard against float drift
  return cdf;
}

/** Sample a degree in 1…K from the CDF using one Uniform[0,1) draw. */
export function sampleDegree(cdf: Float64Array, u: number): number {
  const K = cdf.length - 1;
  // Binary search for smallest d with cdf[d] ≥ u.
  let lo = 1;
  let hi = K;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid]! < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Analytic PMF from the CDF (for tests). */
export function pmfFromCdf(cdf: Float64Array): Float64Array {
  const K = cdf.length - 1;
  const p = new Float64Array(K + 1);
  let prev = 0;
  for (let d = 1; d <= K; d++) {
    p[d] = cdf[d]! - prev;
    prev = cdf[d]!;
  }
  return p;
}
