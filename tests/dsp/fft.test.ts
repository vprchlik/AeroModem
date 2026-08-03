import { describe, expect, it } from 'vitest';
import { FFT, realSpectrumDb } from '../../src/dsp/fft';
import { hann } from '../../src/dsp/window';

/** Direct O(N²) DFT for reference (double precision intermediates). */
function dftRef(re: Float32Array, im: Float32Array): { re: Float64Array; im: Float64Array } {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let n0 = 0; n0 < n; n0++) {
      const angle = (-2 * Math.PI * k * n0) / n;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      sr += re[n0]! * c - im[n0]! * s;
      si += re[n0]! * s + im[n0]! * c;
    }
    outRe[k] = sr;
    outIm[k] = si;
  }
  return { re: outRe, im: outIm };
}

function maxAbsErr(
  aRe: ArrayLike<number>,
  aIm: ArrayLike<number>,
  bRe: ArrayLike<number>,
  bIm: ArrayLike<number>,
): number {
  let m = 0;
  for (let i = 0; i < aRe.length; i++) {
    m = Math.max(m, Math.abs(aRe[i]! - bRe[i]!), Math.abs(aIm[i]! - bIm[i]!));
  }
  return m;
}

describe('FFT', () => {
  it.each([8, 16, 32, 64, 256, 1024, 2048])(
    'matches direct DFT for size %i (max abs err < 1e-4)',
    (n) => {
      const re = new Float32Array(n);
      const im = new Float32Array(n);
      // Deterministic pseudo-random input (no Math.random).
      let s = (n * 2654435761) >>> 0;
      for (let i = 0; i < n; i++) {
        s = (s + 0x9e3779b9) >>> 0;
        re[i] = (s / 0x100000000) * 2 - 1;
        s = (s + 0x9e3779b9) >>> 0;
        im[i] = (s / 0x100000000) * 2 - 1;
      }
      const ref = dftRef(re, im);
      const fft = new FFT(n);
      const reF = re.slice();
      const imF = im.slice();
      fft.forward(reF, imF);
      expect(maxAbsErr(reF, imF, ref.re, ref.im)).toBeLessThan(1e-4);
    },
  );

  it('impulse → flat spectrum of 1+0j', () => {
    const n = 64;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    re[0] = 1;
    new FFT(n).forward(re, im);
    for (let k = 0; k < n; k++) {
      expect(Math.abs(re[k]! - 1)).toBeLessThan(1e-5);
      expect(Math.abs(im[k]!)).toBeLessThan(1e-5);
    }
  });

  it('unit cosine at bin k peaks only at ±k', () => {
    const n = 128;
    const k0 = 5;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      re[t] = Math.cos((2 * Math.PI * k0 * t) / n);
    }
    new FFT(n).forward(re, im);
    // Expected: X[k0]=N/2, X[N-k0]=N/2 for a real cosine.
    expect(Math.abs(re[k0]! - n / 2)).toBeLessThan(1e-3);
    expect(Math.abs(re[n - k0]! - n / 2)).toBeLessThan(1e-3);
    expect(Math.hypot(re[k0 + 1]!, im[k0 + 1]!)).toBeLessThan(1e-3);
  });

  it('inverse(forward(x)) ≈ x', () => {
    const n = 256;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (s + 0x9e3779b9) >>> 0;
      re[i] = (s / 0x100000000) * 2 - 1;
      s = (s + 0x9e3779b9) >>> 0;
      im[i] = (s / 0x100000000) * 2 - 1;
    }
    const re0 = re.slice();
    const im0 = im.slice();
    const fft = new FFT(n);
    fft.forward(re, im);
    fft.inverse(re, im);
    expect(maxAbsErr(re, im, re0, im0)).toBeLessThan(1e-5);
  });

  it('obeys Parseval: Σ|x|² = (1/N) Σ|X|²', () => {
    const n = 512;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    let s = 99;
    for (let i = 0; i < n; i++) {
      s = (s + 0x9e3779b9) >>> 0;
      re[i] = (s / 0x100000000) * 2 - 1;
      im[i] = 0;
    }
    let timeEnergy = 0;
    for (let i = 0; i < n; i++) timeEnergy += re[i]! * re[i]!;
    const fft = new FFT(n);
    fft.forward(re, im);
    let freqEnergy = 0;
    for (let i = 0; i < n; i++) freqEnergy += re[i]! * re[i]! + im[i]! * im[i]!;
    expect(Math.abs(timeEnergy - freqEnergy / n)).toBeLessThan(1e-3);
  });

  it('rejects non-power-of-two sizes', () => {
    expect(() => new FFT(100)).toThrow(/power of two/);
  });
});

describe('realSpectrumDb', () => {
  it('places a 19 kHz tone near the expected bin at 48 kHz / N=2048', () => {
    const fs = 48000;
    const n = 2048;
    const freq = 19000;
    const bin = Math.round((freq * n) / fs); // ≈ 811
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.cos((2 * Math.PI * freq * i) / fs);
    const fft = new FFT(n);
    const win = hann(n);
    // Flat window for a cleaner peak check.
    win.fill(1);
    const out = new Float32Array(n / 2 + 1);
    realSpectrumDb(x, fft, win, out);
    let peakBin = 0;
    let peakDb = -Infinity;
    for (let k = 0; k < out.length; k++) {
      if (out[k]! > peakDb) {
        peakDb = out[k]!;
        peakBin = k;
      }
    }
    expect(Math.abs(peakBin - bin)).toBeLessThanOrEqual(1);
    expect(peakDb).toBeGreaterThan(-3); // near 0 dBFS for unit cosine
  });
});
