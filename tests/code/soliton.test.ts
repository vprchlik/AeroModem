import { describe, expect, it } from 'vitest';
import { robustSolitonCdf, sampleDegree, pmfFromCdf } from '../../src/code/soliton';
import { splitmix32 } from '../../src/util/prng';

describe('robust soliton', () => {
  it('CDF is monotone and ends at 1', () => {
    const cdf = robustSolitonCdf(100, 0.05, 0.05);
    expect(cdf[0]).toBe(0);
    for (let d = 1; d <= 100; d++) {
      expect(cdf[d]!).toBeGreaterThanOrEqual(cdf[d - 1]!);
    }
    expect(cdf[100]).toBeCloseTo(1, 10);
  });

  it('empirical degree histogram matches PMF (chi-squared sanity)', () => {
    const K = 50;
    const cdf = robustSolitonCdf(K, 0.05, 0.05);
    const pmf = pmfFromCdf(cdf);
    const rng = splitmix32(7);
    const N = 100_000;
    const hist = new Float64Array(K + 1);
    for (let i = 0; i < N; i++) hist[sampleDegree(cdf, rng())]!++;

    // Chi-squared over degrees with expected count ≥ 30.
    let chi = 0;
    let df = 0;
    for (let d = 1; d <= K; d++) {
      const exp = pmf[d]! * N;
      if (exp < 30) continue;
      const diff = hist[d]! - exp;
      chi += (diff * diff) / exp;
      df++;
    }
    // Very loose bound — just catch a broken sampler.
    expect(df).toBeGreaterThan(5);
    expect(chi / df).toBeLessThan(3);
  });
});
