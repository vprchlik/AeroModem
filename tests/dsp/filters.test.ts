import { describe, expect, it } from 'vitest';
import { designBandpassFir, designLowpassFir, fftConvolve, filterAligned } from '../../src/dsp/filters';
import { bandPowerDb } from '../../src/dsp/measure';

const FS = 48000;

function tone(freq: number, n: number, fs = FS): Float32Array {
  const x = new Float32Array(n);
  const w = (2 * Math.PI * freq) / fs;
  for (let i = 0; i < n; i++) x[i] = Math.cos(w * i);
  return x;
}

describe('fftConvolve', () => {
  it('matches direct convolution on a small case', () => {
    const x = new Float32Array([1, 2, 3, 4]);
    const h = new Float32Array([0.5, -0.25]);
    const y = fftConvolve(x, h);
    // Direct: [0.5, 1−0.25, 1.5−0.5, 2−0.75, −1]
    const expected = [0.5, 0.75, 1.0, 1.25, -1.0];
    expect(y.length).toBe(5);
    for (let i = 0; i < expected.length; i++) {
      expect(y[i]!).toBeCloseTo(expected[i]!, 5);
    }
  });

  it('convolving with a unit impulse is the identity', () => {
    const x = tone(1000, 4096);
    const h = new Float32Array([1]);
    const y = fftConvolve(x, h);
    for (let i = 0; i < x.length; i += 511) {
      expect(y[i]!).toBeCloseTo(x[i]!, 4);
    }
  });
});

describe('designBandpassFir / filterAligned', () => {
  const h = designBandpassFir(401, 500, 5000, FS);

  it('passes an in-band tone within 1 dB', () => {
    const x = tone(2000, 32768);
    const y = filterAligned(x, h);
    const attenDb =
      bandPowerDb(x, FS, 1800, 2200) - bandPowerDb(y, FS, 1800, 2200);
    expect(Math.abs(attenDb)).toBeLessThan(1);
  });

  it('attenuates a stopband tone by ≥ 40 dB', () => {
    const x = tone(8000, 32768);
    const y = filterAligned(x, h);
    const attenDb =
      bandPowerDb(x, FS, 7800, 8200) - bandPowerDb(y, FS, 7800, 8200);
    expect(attenDb).toBeGreaterThan(40);
  });

  it('filterAligned preserves length and alignment (peak at same index)', () => {
    // A slow in-band pulse should come out centred where it went in.
    const n = 16384;
    const x = new Float32Array(n);
    const centre = 8000;
    for (let i = 0; i < n; i++) {
      const t = (i - centre) / FS;
      x[i] = Math.exp(-((t * 400) ** 2)) * Math.cos(2 * Math.PI * 2000 * (i / FS));
    }
    const y = filterAligned(x, h);
    expect(y.length).toBe(n);
    let peakIdx = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(y[i]!);
      if (a > peak) {
        peak = a;
        peakIdx = i;
      }
    }
    expect(Math.abs(peakIdx - centre)).toBeLessThanOrEqual(24); // within one 2 kHz cycle
  });

  it('lowpass DC gain is 1', () => {
    const lp = designLowpassFir(101, 4000, FS);
    let sum = 0;
    for (const v of lp) sum += v;
    expect(sum).toBeCloseTo(1, 4);
  });
});
