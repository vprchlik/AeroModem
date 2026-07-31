/**
 * Acoustic channel simulator — a pure function applying composable impairments
 * in the physical order a real phone-to-phone link experiences them:
 *
 *   TX clipping → speaker band-limit → room (RIR convolution) → clock drift
 *   → receiver AGC wander (optional) → AWGN → random start offset
 *
 * Every random draw comes from splitmix32(opts.seed): identical opts ⇒
 * bit-identical output. This is the test bed every modem feature must pass
 * through before touching hardware (PLAN.md Phase 2).
 */

import { splitmix32, gaussianPair } from '../util/prng';
import { assert } from '../util/assert';
import { designBandpassFir, filterAligned, fftConvolve } from '../dsp/filters';
import { resampleFractional } from '../dsp/resample';
import { bandPowerDb } from '../dsp/measure';
import { makeRir, RIR_SPECS, type RirPreset } from './rir';

export interface ChannelOpts {
  /** Drives ALL randomness (noise, RIR, offsets). Same seed ⇒ same output. */
  seed: number;
  /** Sample rate of `samples` (Hz). */
  sampleRate: number;

  /** Hard clipping at this level (dBFS, e.g. −3). Models TX amplifier limits. */
  clip?: { thresholdDbfs: number };

  /**
   * Speaker/mic band-limit. 'phone': ≈200 Hz…21 kHz passband with steep
   * Blackman-FIR roll-off (≥30 dB by 22.5 kHz). 'flat': no filtering.
   */
  bandLimit?: { speakerModel: 'phone' | 'flat' };

  /** Multipath: convolve with a synthetic RIR preset or a custom response. */
  rir?: RirPreset | Float32Array;

  /** Sample-clock drift in parts-per-million (signal resampled by 1+ppm·1e-6). */
  clockDriftPpm?: number;

  /** Slow receiver gain wander (models a browser that ignored autoGainControl:false). */
  agcWander?: boolean;

  /** AWGN at this SNR (dB), measured in `snrBandHz` (default: full 0…Nyquist). */
  snrDb?: number;
  /** Band over which snrDb is defined, [loHz, hiHz]. */
  snrBandHz?: [number, number];

  /** Prepend a seeded-uniform random count of silence samples in [min, max]. */
  startOffsetSamples?: [number, number];
}

/** Named opts presets for tests/bench (seed & sampleRate filled by caller). */
export const CHANNEL_PRESETS: Record<string, Omit<ChannelOpts, 'seed' | 'sampleRate'>> = {
  clean: {},
  'phone-clean': { bandLimit: { speakerModel: 'phone' } },
  'living-room-20db': {
    bandLimit: { speakerModel: 'phone' },
    rir: 'living-room',
    snrDb: 20,
  },
  'hallway-10db-drift': {
    bandLimit: { speakerModel: 'phone' },
    rir: 'hallway',
    snrDb: 10,
    clockDriftPpm: 30,
  },
};

/** Cache of designed FIR kernels (design is deterministic; cache is per fs). */
const phoneFirCache = new Map<number, Float32Array>();

function phoneBandLimitFir(fs: number): Float32Array {
  let h = phoneFirCache.get(fs);
  if (!h) {
    // 1601 taps: transition ≈ 5.5·fs/1601 ≈ 165 Hz @48k — steep enough that a
    // 21.3 kHz cutoff is ≥30 dB down by 22.5 kHz, and 200 Hz HPF bites by ~100 Hz.
    h = designBandpassFir(1601, 200, 21300, fs);
    phoneFirCache.set(fs, h);
  }
  return h;
}

export function simulateChannel(samples: Float32Array, opts: ChannelOpts): Float32Array {
  assert(Number.isFinite(opts.seed), 'ChannelOpts.seed required');
  assert(opts.sampleRate > 0, 'ChannelOpts.sampleRate required');
  const fs = opts.sampleRate;
  const rng = splitmix32(opts.seed);

  let x: Float32Array = samples.slice(); // never mutate the caller's buffer

  // 1) TX clipping — hard limiter at the given dBFS threshold.
  if (opts.clip) {
    const th = Math.pow(10, opts.clip.thresholdDbfs / 20);
    for (let i = 0; i < x.length; i++) {
      const v = x[i]!;
      x[i] = v > th ? th : v < -th ? -th : v;
    }
  }

  // 2) Speaker/mic band-limit (linear-phase FIR, group delay removed).
  if (opts.bandLimit && opts.bandLimit.speakerModel === 'phone') {
    x = filterAligned(x, phoneBandLimitFir(fs));
  }

  // 3) Room multipath — full convolution truncated to input length
  //    (direct path at index 0 keeps alignment).
  if (opts.rir !== undefined) {
    const h =
      opts.rir instanceof Float32Array
        ? opts.rir
        : makeRir(opts.rir, (rng() * 0x100000000) >>> 0, fs);
    x = fftConvolve(x, h).slice(0, x.length);
  }

  // 4) Clock drift — evaluate waveform at t·(1+ε).
  if (opts.clockDriftPpm !== undefined && opts.clockDriftPpm !== 0) {
    x = resampleFractional(x, 1 + opts.clockDriftPpm * 1e-6);
  }

  // 5) Receiver AGC wander — slow multiplicative gain ±15% at ~0.4 Hz.
  if (opts.agcWander) {
    const phase = rng() * 2 * Math.PI;
    const w = (2 * Math.PI * 0.4) / fs;
    for (let i = 0; i < x.length; i++) {
      x[i]! *= 1 + 0.15 * Math.sin(w * i + phase);
    }
  }

  // 6) AWGN at target in-band SNR.
  if (opts.snrDb !== undefined) {
    const [lo, hi] = opts.snrBandHz ?? [0, fs / 2];
    // In-band signal power (linear, Welch estimate).
    const pSigDb = bandPowerDb(x, fs, Math.max(1, lo), Math.min(hi, fs / 2 - 1));
    const pSig = Math.pow(10, pSigDb / 10);
    // White noise of variance σ² has (in the same Welch scale) total power P_tot
    // proportional to σ², and in-band share (hi−lo)/(fs/2). Target:
    //   pSig / pNoiseInBand = snr → pNoiseInBand = pSig / snr.
    const snrLin = Math.pow(10, opts.snrDb / 10);
    const bandFrac = (Math.min(hi, fs / 2) - Math.max(0, lo)) / (fs / 2);
    // Calibrate the Welch-scale → σ² factor empirically on a unit-σ probe:
    // generate a short unit-variance noise, measure its full-band Welch power.
    const probe = new Float32Array(16384);
    const rngProbe = splitmix32((rng() * 0x100000000) >>> 0);
    for (let i = 0; i < probe.length; i += 2) {
      const [g1, g2] = gaussianPair(rngProbe);
      probe[i] = g1;
      if (i + 1 < probe.length) probe[i + 1] = g2;
    }
    const unitNoiseFullBandDb = bandPowerDb(probe, fs, 1, fs / 2 - 1);
    const pUnitInBand = Math.pow(10, unitNoiseFullBandDb / 10) * bandFrac;
    const sigma = Math.sqrt(pSig / snrLin / pUnitInBand);

    for (let i = 0; i < x.length; i += 2) {
      const [g1, g2] = gaussianPair(rng);
      x[i]! += sigma * g1;
      if (i + 1 < x.length) x[i + 1]! += sigma * g2;
    }
  }

  // 7) Random start offset — silence prepended (receiver never knows when TX began).
  if (opts.startOffsetSamples) {
    const [min, max] = opts.startOffsetSamples;
    assert(min <= max && min >= 0, 'startOffsetSamples range invalid');
    const n = min + Math.floor(rng() * (max - min + 1));
    const out = new Float32Array(n + x.length);
    out.set(x, n);
    x = out;
  }

  return x;
}

export { RIR_SPECS, makeRir };
export type { RirPreset };
