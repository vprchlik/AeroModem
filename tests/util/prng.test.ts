import { describe, expect, it } from 'vitest';
import { gaussianPair, splitmix32 } from '../../src/util/prng';

describe('splitmix32', () => {
  it('is deterministic for a given seed', () => {
    const a = splitmix32(0x12345678);
    const b = splitmix32(0x12345678);
    const seqA = Array.from({ length: 32 }, () => a());
    const seqB = Array.from({ length: 32 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('diverges for different seeds', () => {
    const a = splitmix32(1);
    const b = splitmix32(2);
    expect(a()).not.toBe(b());
  });

  it('returns values in [0, 1)', () => {
    const rng = splitmix32(42);
    for (let i = 0; i < 10_000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('has mean ≈ 0.5 and variance ≈ 1/12 over a long run', () => {
    const rng = splitmix32(2026);
    const n = 100_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const x = rng();
      sum += x;
      sumSq += x * x;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    expect(mean).toBeGreaterThan(0.49);
    expect(mean).toBeLessThan(0.51);
    // Uniform[0,1) variance = 1/12 ≈ 0.08333
    expect(variance).toBeGreaterThan(0.08);
    expect(variance).toBeLessThan(0.087);
  });
});

describe('gaussianPair', () => {
  it('is deterministic given a seeded rng', () => {
    const a = splitmix32(99);
    const b = splitmix32(99);
    expect(gaussianPair(a)).toEqual(gaussianPair(b));
  });

  it('produces approximately N(0,1) margins over many draws', () => {
    const rng = splitmix32(7);
    const n = 50_000; // pairs → 100_000 samples
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const [x, y] = gaussianPair(rng);
      sum += x + y;
      sumSq += x * x + y * y;
    }
    const m = 2 * n;
    const mean = sum / m;
    const variance = sumSq / m - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(variance).toBeGreaterThan(0.96);
    expect(variance).toBeLessThan(1.04);
  });
});
