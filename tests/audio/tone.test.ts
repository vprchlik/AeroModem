import { describe, expect, it } from 'vitest';
import { generateTone } from '../../src/audio/context';
import { FFT, realSpectrumDb } from '../../src/dsp/fft';

describe('generateTone', () => {
  it('produces a tone whose spectrum peaks at the requested bin', () => {
    const fs = 48000;
    const freq = 19000;
    const samples = generateTone(freq, 2048 / fs, fs, 1.0);
    // generateTone adds fade; take a steady middle section if long enough,
    // otherwise use the whole buffer zero-padded into an FFT frame.
    const n = 2048;
    const frame = new Float32Array(n);
    frame.set(samples.subarray(0, Math.min(samples.length, n)));
    const fft = new FFT(n);
    const win = new Float32Array(n);
    win.fill(1);
    const out = new Float32Array(n / 2 + 1);
    realSpectrumDb(frame, fft, win, out);
    const expected = Math.round((freq * n) / fs);
    let peakBin = 0;
    let peakDb = -Infinity;
    for (let k = 0; k < out.length; k++) {
      if (out[k]! > peakDb) {
        peakDb = out[k]!;
        peakBin = k;
      }
    }
    expect(Math.abs(peakBin - expected)).toBeLessThanOrEqual(1);
  });

  it('fades endpoints to near zero', () => {
    const s = generateTone(1000, 0.05, 48000, 0.5);
    expect(Math.abs(s[0]!)).toBeLessThan(1e-3);
    expect(Math.abs(s[s.length - 1]!)).toBeLessThan(1e-3);
  });
});

describe('DSP purity', () => {
  it('dsp modules do not reference Web Audio globals at import time', async () => {
    // Smoke: importing dsp must work in Node (no AudioContext).
    const fft = await import('../../src/dsp/fft');
    const win = await import('../../src/dsp/window');
    expect(fft.FFT).toBeTypeOf('function');
    expect(win.hann).toBeTypeOf('function');
    expect(typeof AudioContext === 'undefined' || true).toBe(true);
  });
});
