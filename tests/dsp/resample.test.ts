import { describe, expect, it } from 'vitest';
import { resampleFractional } from '../../src/dsp/resample';
import { estimateToneFreqHz, rms } from '../../src/dsp/measure';

const FS = 48000;

function tone(freq: number, n: number): Float32Array {
  const x = new Float32Array(n);
  const w = (2 * Math.PI * freq) / FS;
  for (let i = 0; i < n; i++) x[i] = Math.cos(w * i);
  return x;
}

describe('resampleFractional', () => {
  it('ratio 1 is (nearly) the identity', () => {
    const x = tone(1000, 8192);
    const y = resampleFractional(x, 1);
    for (let i = 4; i < y.length; i += 777) {
      expect(y[i]!).toBeCloseTo(x[i]!, 4);
    }
  });

  it('scales tone frequency by the resample ratio (+100 ppm)', () => {
    const x = tone(1000, 2 ** 18 + 8);
    const y = resampleFractional(x, 1 + 100e-6);
    const f = estimateToneFreqHz(y, FS);
    expect(Math.abs(f - 1000.1)).toBeLessThan(0.02);
  });

  it('preserves amplitude for in-band signals', () => {
    const x = tone(5000, 65536);
    const y = resampleFractional(x, 1 + 50e-6);
    expect(rms(y)).toBeGreaterThan(0.7 * rms(x));
    expect(rms(y)).toBeLessThan(1.01 * rms(x));
  });
});
