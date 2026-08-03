import { describe, expect, it } from 'vitest';
import {
  bandPowerDb,
  estimateToneFreqHz,
  measureSnrDb,
  thdRatio,
} from '../../src/dsp/measure';
import { splitmix32, gaussianPair } from '../../src/util/prng';

const FS = 48000;

function tone(freq: number, n: number, amp = 1): Float32Array {
  const x = new Float32Array(n);
  const w = (2 * Math.PI * freq) / FS;
  for (let i = 0; i < n; i++) x[i] = amp * Math.cos(w * i);
  return x;
}

describe('estimateToneFreqHz', () => {
  it('is accurate to ≤ 0.05 Hz on a clean tone', () => {
    const x = tone(12345.6, 2 ** 17);
    expect(Math.abs(estimateToneFreqHz(x, FS) - 12345.6)).toBeLessThan(0.05);
  });
});

describe('measureSnrDb', () => {
  it('recovers a known SNR from synthetic noise', () => {
    const n = 2 ** 17;
    const rng = splitmix32(7);
    const clean = new Float32Array(n);
    for (let i = 0; i < n; i += 2) {
      const [g1, g2] = gaussianPair(rng);
      clean[i] = g1;
      if (i + 1 < n) clean[i + 1] = g2;
    }
    // Unit-variance signal + σ=0.1 noise → 20 dB full-band SNR.
    const noisy = new Float32Array(n);
    for (let i = 0; i < n; i += 2) {
      const [g1, g2] = gaussianPair(rng);
      noisy[i] = clean[i]! + 0.1 * g1;
      if (i + 1 < n) noisy[i + 1] = clean[i + 1]! + 0.1 * g2;
    }
    const snr = measureSnrDb(clean, noisy, FS, 100, 23000);
    expect(Math.abs(snr - 20)).toBeLessThan(0.3);
  });
});

describe('bandPowerDb', () => {
  it('a tone contributes to its own band and not a disjoint one', () => {
    const x = tone(5000, 65536);
    const inBand = bandPowerDb(x, FS, 4800, 5200);
    const outBand = bandPowerDb(x, FS, 10000, 12000);
    expect(inBand - outBand).toBeGreaterThan(60);
  });
});

describe('thdRatio', () => {
  it('is tiny for a clean sine and large for a clipped one', () => {
    const clean = tone(1000, 65536, 1);
    const clipped = clean.slice();
    for (let i = 0; i < clipped.length; i++) {
      const v = clipped[i]!;
      clipped[i] = v > 0.5 ? 0.5 : v < -0.5 ? -0.5 : v;
    }
    expect(thdRatio(clean, FS, 1000)).toBeLessThan(1e-3);
    expect(thdRatio(clipped, FS, 1000)).toBeGreaterThan(0.05);
  });
});
