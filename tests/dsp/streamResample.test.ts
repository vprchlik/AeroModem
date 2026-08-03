import { describe, expect, it } from 'vitest';
import { resampleFractional, StreamResampler } from '../../src/dsp/resample';
import { splitmix32 } from '../../src/util/prng';

describe('StreamResampler', () => {
  it('matches whole-buffer resampleFractional after start-up, for any chunking', () => {
    const rng = splitmix32(11);
    const n = 20000;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = rng() * 2 - 1;

    for (const ratio of [44100 / 48000, 48000 / 44100, 1.0]) {
      const ref = resampleFractional(x, ratio);

      const sr = new StreamResampler(ratio);
      const out: number[] = [];
      let off = 0;
      const chunkRng = splitmix32(77);
      while (off < n) {
        const len = 1 + Math.floor(chunkRng() * 700);
        const res = sr.push(x.subarray(off, Math.min(n, off + len)));
        for (let i = 0; i < res.length; i++) out.push(res[i]!);
        off += len;
      }

      // Compare on the overlap, skipping the start-up transient (first 64).
      const m = Math.min(out.length, ref.length);
      expect(m).toBeGreaterThan(ref.length - 64);
      let maxErr = 0;
      for (let i = 64; i < m; i++) {
        maxErr = Math.max(maxErr, Math.abs(out[i]! - ref[i]!));
      }
      expect(maxErr).toBeLessThan(1e-3);
    }
  });

  it('a 1 kHz tone stays 1 kHz in absolute time across 44.1→48 conversion', () => {
    // Input at 44100: tone 1 kHz. Output at 48000 must also be 1 kHz.
    const fsIn = 44100;
    const fsOut = 48000;
    const n = 44100;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 1000 * i) / fsIn);
    const sr = new StreamResampler(fsIn / fsOut);
    const y = sr.push(x);
    // Count zero crossings in one output second (skip transient).
    let crossings = 0;
    for (let i = 200; i < Math.min(y.length, 200 + fsOut) - 1; i++) {
      if ((y[i]! >= 0) !== (y[i + 1]! >= 0)) crossings++;
    }
    const freq = crossings / 2; // per second
    expect(Math.abs(freq - 1000)).toBeLessThan(5);
  });
});
