import { describe, expect, it } from 'vitest';
import { coherentGain, hann } from '../../src/dsp/window';

describe('hann', () => {
  it('has endpoints at 0 and midpoint at 1 for odd-friendly sizes', () => {
    const w = hann(5);
    expect(w[0]).toBeCloseTo(0, 6);
    expect(w[4]).toBeCloseTo(0, 6);
    expect(w[2]).toBeCloseTo(1, 6);
  });

  it('has coherent gain ≈ 0.5', () => {
    const w = hann(2048);
    expect(coherentGain(w)).toBeCloseTo(0.5, 3);
  });

  it('writes into a provided output buffer', () => {
    const out = new Float32Array(16);
    const w = hann(16, out);
    expect(w).toBe(out);
    expect(w[0]).toBeCloseTo(0, 6);
  });
});
