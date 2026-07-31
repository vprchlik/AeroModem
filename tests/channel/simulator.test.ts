import { describe, expect, it } from 'vitest';
import { simulateChannel, type ChannelOpts } from '../../src/channel/simulator';
import { designBandpassFir, filterAligned } from '../../src/dsp/filters';
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

/** Band-limited (2–20 kHz) unit-ish test signal — modem-like spectrum. */
function bandNoise(seed: number, n: number): Float32Array {
  const rng = splitmix32(seed);
  const white = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const [g1, g2] = gaussianPair(rng);
    white[i] = g1;
    if (i + 1 < n) white[i + 1] = g2;
  }
  const h = designBandpassFir(401, 2000, 20000, FS);
  return filterAligned(white, h);
}

describe('AWGN impairment', () => {
  const clean = bandNoise(101, 2 ** 17);

  for (const target of [0, 10, 20, 30]) {
    it(`measured in-band SNR within ±0.5 dB of ${target} dB (10 seeds)`, () => {
      for (let seed = 1; seed <= 10; seed++) {
        const noisy = simulateChannel(clean, {
          seed,
          sampleRate: FS,
          snrDb: target,
          snrBandHz: [2000, 20000],
        });
        const measured = measureSnrDb(clean, noisy, FS, 2000, 20000);
        expect(Math.abs(measured - target)).toBeLessThan(0.5);
      }
    });
  }
});

describe('band-limit impairment (phone speaker model)', () => {
  it('attenuates 22.5 kHz by ≥ 30 dB while passing 10 kHz within 1 dB', () => {
    const opts: ChannelOpts = {
      seed: 1,
      sampleRate: FS,
      bandLimit: { speakerModel: 'phone' },
    };
    const x10 = tone(10000, 32768);
    const x225 = tone(22500, 32768);
    const y10 = simulateChannel(x10, opts);
    const y225 = simulateChannel(x225, opts);

    const atten10 =
      bandPowerDb(x10, FS, 9800, 10200) - bandPowerDb(y10, FS, 9800, 10200);
    const atten225 =
      bandPowerDb(x225, FS, 22300, 22700) - bandPowerDb(y225, FS, 22300, 22700);

    expect(Math.abs(atten10)).toBeLessThan(1);
    expect(atten225).toBeGreaterThan(30);
  });

  it("'flat' model is a passthrough", () => {
    const x = tone(15000, 8192);
    const y = simulateChannel(x, {
      seed: 1,
      sampleRate: FS,
      bandLimit: { speakerModel: 'flat' },
    });
    expect(y).toEqual(x);
  });
});

describe('clock drift impairment', () => {
  it('+50 ppm shifts a 10 kHz tone to 10000.5 Hz ± 0.1 Hz', () => {
    const x = tone(10000, 2 ** 18 + 64);
    const y = simulateChannel(x, { seed: 1, sampleRate: FS, clockDriftPpm: 50 });
    const f = estimateToneFreqHz(y, FS);
    expect(Math.abs(f - 10000.5)).toBeLessThan(0.1);
  });

  it('−50 ppm shifts a 10 kHz tone to 9999.5 Hz ± 0.1 Hz', () => {
    const x = tone(10000, 2 ** 18 + 64);
    const y = simulateChannel(x, { seed: 1, sampleRate: FS, clockDriftPpm: -50 });
    const f = estimateToneFreqHz(y, FS);
    expect(Math.abs(f - 9999.5)).toBeLessThan(0.1);
  });
});

describe('start offset impairment', () => {
  it('prepends silence within the requested range', () => {
    const x = tone(5000, 8192, 0.5);
    for (let seed = 1; seed <= 5; seed++) {
      const y = simulateChannel(x, {
        seed,
        sampleRate: FS,
        startOffsetSamples: [1000, 5000],
      });
      const added = y.length - x.length;
      expect(added).toBeGreaterThanOrEqual(1000);
      expect(added).toBeLessThanOrEqual(5000);
      for (let i = 0; i < added; i++) {
        expect(y[i]).toBe(0);
      }
      expect(y[added]!).toBeCloseTo(x[0]!, 6);
    }
  });
});

describe('clipping impairment', () => {
  it('limits peaks and raises THD', () => {
    const x = tone(1000, 65536, 1);
    const y = simulateChannel(x, {
      seed: 1,
      sampleRate: FS,
      clip: { thresholdDbfs: -6 },
    });
    const th = Math.pow(10, -6 / 20);
    let peak = 0;
    for (const v of y) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(th + 1e-6);
    expect(thdRatio(y, FS, 1000)).toBeGreaterThan(0.05);
    expect(thdRatio(x, FS, 1000)).toBeLessThan(1e-3);
  });
});

describe('RIR impairment', () => {
  it('preserves length and keeps the direct-path signal dominant', () => {
    const x = bandNoise(55, 2 ** 16);
    const y = simulateChannel(x, { seed: 9, sampleRate: FS, rir: 'living-room' });
    expect(y.length).toBe(x.length);
    // Direct path (h[0]=1) means clean signal is embedded; the "error" is
    // reverb whose power sits DRR below — so SNR vs clean ≈ DRR (3 dB ± slack).
    const snr = measureSnrDb(x, y, FS, 2000, 20000);
    expect(snr).toBeGreaterThan(0);
    expect(snr).toBeLessThan(8);
  });

  it('accepts a custom Float32Array response', () => {
    const echo = new Float32Array(2048);
    echo[0] = 1;
    echo[1024] = 0.5;
    const x = tone(4000, 16384);
    const y = simulateChannel(x, { seed: 1, sampleRate: FS, rir: echo });
    expect(y.length).toBe(x.length);
    // y[n] = x[n] + 0.5 x[n−1024]
    const i = 5000;
    expect(y[i]!).toBeCloseTo(x[i]! + 0.5 * x[i - 1024]!, 4);
  });
});

describe('AGC wander impairment', () => {
  it('modulates the envelope by a slow gain', () => {
    const x = tone(2000, FS * 3, 0.5); // 3 s
    const y = simulateChannel(x, { seed: 3, sampleRate: FS, agcWander: true });
    // RMS over 250 ms windows should vary noticeably (>5% spread).
    const win = FS / 4;
    const rmsVals: number[] = [];
    for (let off = 0; off + win <= y.length; off += win) {
      let s = 0;
      for (let i = off; i < off + win; i++) s += y[i]! * y[i]!;
      rmsVals.push(Math.sqrt(s / win));
    }
    const min = Math.min(...rmsVals);
    const max = Math.max(...rmsVals);
    expect(max / min).toBeGreaterThan(1.05);
  });
});

describe('determinism and composition', () => {
  const fullOpts = (seed: number): ChannelOpts => ({
    seed,
    sampleRate: FS,
    clip: { thresholdDbfs: -3 },
    bandLimit: { speakerModel: 'phone' },
    rir: 'living-room',
    clockDriftPpm: 30,
    agcWander: true,
    snrDb: 15,
    snrBandHz: [2000, 20000],
    startOffsetSamples: [0, 48000],
  });

  it('same seed ⇒ bit-identical output', () => {
    const x = bandNoise(77, 2 ** 16);
    const a = simulateChannel(x, fullOpts(1234));
    const b = simulateChannel(x, fullOpts(1234));
    expect(a).toEqual(b);
  });

  it('different seed ⇒ different output', () => {
    const x = bandNoise(77, 2 ** 16);
    const a = simulateChannel(x, fullOpts(1));
    const b = simulateChannel(x, fullOpts(2));
    let differs = a.length !== b.length;
    if (!differs) {
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          differs = true;
          break;
        }
      }
    }
    expect(differs).toBe(true);
  });

  it('all impairments composed produce a finite, plausible signal', () => {
    const x = bandNoise(88, 2 ** 16);
    const y = simulateChannel(x, fullOpts(9));
    expect(y.length).toBeGreaterThan(0.9 * x.length);
    for (let i = 0; i < y.length; i += 97) {
      expect(Number.isFinite(y[i]!)).toBe(true);
    }
  });

  it('does not mutate the input buffer', () => {
    const x = bandNoise(99, 2 ** 14);
    const copy = x.slice();
    simulateChannel(x, fullOpts(5));
    expect(x).toEqual(copy);
  });
});
