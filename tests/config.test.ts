import { describe, expect, it } from 'vitest';
import {
  FAST_48K,
  QUIET_48K,
  FAST_44K1,
  QUIET_44K1,
  derive,
} from '../src/config';

describe('derive(FAST_48K)', () => {
  const d = derive(FAST_48K);

  it('maps the 2–20 kHz band to bins 86…853 (768 carriers)', () => {
    expect(d.deltaF).toBeCloseTo(48000 / 2048, 10);
    expect(d.binLow).toBe(86);
    expect(d.binHigh).toBe(853);
    expect(d.nActive).toBe(768);
  });

  it('partitions into 85 pilots + 683 data carriers (spacing 9)', () => {
    expect(d.pilotBins).toHaveLength(85);
    expect(d.dataBins).toHaveLength(683);
    expect(d.pilotBins[0]).toBe(86);
    expect(d.pilotBins[1]).toBe(86 + 9);
    // last pilot at local index 84*9 = 756 → absolute 86+756 = 842
    expect(d.pilotBins[84]).toBe(842);
  });

  it('estimates net goodput above the 5 kbit/s fast-mode target', () => {
    // PLAN.md §2: ~9.5 kbit/s planning baseline under uniform QPSK + rate-1/2.
    expect(d.estimatedNetBitRate).toBeGreaterThan(5000);
    expect(d.estimatedNetBitRate).toBeGreaterThan(8000);
    expect(d.estimatedNetBitRate).toBeLessThan(15000);
  });

  it('reports OFDM symbol rate 18.75 sym/s', () => {
    expect(d.symbolSamples).toBe(2048 + 512);
    expect(d.symbolRate).toBeCloseTo(18.75, 10);
  });
});

describe('derive(QUIET_48K)', () => {
  const d = derive(QUIET_48K);

  it('maps the 17–23 kHz band to bins 726…981 (256 carriers)', () => {
    expect(d.binLow).toBe(726);
    expect(d.binHigh).toBe(981);
    expect(d.nActive).toBe(256);
  });

  it('partitions into 28 pilots + 228 data carriers', () => {
    expect(d.pilotBins).toHaveLength(28);
    expect(d.dataBins).toHaveLength(228);
  });

  it('estimates net goodput above the 2 kbit/s quiet-mode target', () => {
    // PLAN.md §2: ~2.8 kbit/s planning baseline (before dropping rolled-off carriers).
    expect(d.estimatedNetBitRate).toBeGreaterThan(2000);
    expect(d.estimatedNetBitRate).toBeGreaterThan(2500);
    expect(d.estimatedNetBitRate).toBeLessThan(5000);
  });
});

describe('44.1 kHz presets', () => {
  it('clamp quiet-mode bandHighHz to below Nyquist', () => {
    expect(QUIET_44K1.sampleRate).toBe(44100);
    expect(QUIET_44K1.bandHighHz).toBeLessThanOrEqual(44100 / 2);
    expect(FAST_44K1.bandHighHz).toBeLessThanOrEqual(44100 / 2);
    // derive must still produce a non-empty active band
    expect(derive(FAST_44K1).nActive).toBeGreaterThan(100);
    expect(derive(QUIET_44K1).nActive).toBeGreaterThan(50);
  });
});

describe('derive invariants', () => {
  it('rejects an inverted band', () => {
    expect(() =>
      derive({ ...FAST_48K, bandLowHz: 10000, bandHighHz: 2000 }),
    ).toThrow(/bandLowHz/);
  });

  it('rejects a non-power-of-two FFT', () => {
    expect(() => derive({ ...FAST_48K, fftSize: 2000 })).toThrow(/power of 2/);
  });
});
