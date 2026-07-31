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
import {
  designFirFromMagnitude,
  designLowpassFir,
  filterAligned,
  fftConvolve,
} from '../dsp/filters';
import { resampleFractional } from '../dsp/resample';
import { bandPowerDb } from '../dsp/measure';
import { makeRir, RIR_SPECS, type RirPreset } from './rir';
import type { ModemConfig } from '../config';

export interface ChannelOpts {
  /** Drives ALL randomness (noise, RIR, offsets). Same seed ⇒ same output. */
  seed: number;
  /** Sample rate of `samples` (Hz). */
  sampleRate: number;

  /** Hard clipping at this level (dBFS, e.g. −3). Models TX amplifier limits. */
  clip?: { thresholdDbfs: number };

  /**
   * Speaker/mic nonlinearity: y = x + a2·x² − a3·x³, applied at 2× oversampling
   * so harmonics beyond Nyquist are removed (as a real mic's anti-alias filter
   * would) instead of aliasing back in-band. Audible-band signals leak real
   * 2nd-harmonic energy into the 17–23 kHz quiet band.
   */
  nonlinearity?: { secondOrder?: number; thirdOrder?: number };

  /**
   * Speaker/mic band-limit. 'phone': realistic transducer response — 2nd-order
   * Butterworth HPF at 350 Hz + smooth 9th-order-Butterworth-magnitude LPF
   * knee at 15.7 kHz (≈54 dB/oct asymptotic slope, ≈28 dB down at 22.5 kHz).
   * 'flat': no filtering.
   */
  bandLimit?: { speakerModel: 'phone' | 'flat' };

  /** Multipath: convolve with a synthetic RIR preset or a custom response. */
  rir?: RirPreset | Float32Array;

  /** Sample-clock drift in parts-per-million (signal resampled by 1+ppm·1e-6). */
  clockDriftPpm?: number;

  /** Slow receiver gain wander (models a browser that ignored autoGainControl:false). */
  agcWander?: boolean;

  /**
   * AWGN at this SNR (dB), defined IN-BAND over `snrBandHz`.
   * `snrBandHz` is REQUIRED when `snrDb` is set — take it from the modem's
   * active band (see `activeBandHz(cfg)`) so "10 dB" means what the receiver
   * experiences, not a full-band figure that flatters narrowband modes.
   */
  snrDb?: number;
  snrBandHz?: [number, number];

  /** Prepend a seeded-uniform random count of silence samples in [min, max]. */
  startOffsetSamples?: [number, number];
}

/** The modem's active band [lo, hi] Hz — the SNR reference band for simulation. */
export function activeBandHz(cfg: ModemConfig): [number, number] {
  return [cfg.bandLowHz, cfg.bandHighHz];
}

/** Named opts presets for tests/bench (seed & sampleRate filled by caller). */
export const CHANNEL_PRESETS: Record<string, Omit<ChannelOpts, 'seed' | 'sampleRate'>> = {
  clean: {},
  'phone-clean': { bandLimit: { speakerModel: 'phone' } },
  'living-room-20db': {
    bandLimit: { speakerModel: 'phone' },
    rir: 'living-room',
    snrDb: 20,
    snrBandHz: [2000, 20000],
  },
  'hallway-10db-drift': {
    bandLimit: { speakerModel: 'phone' },
    rir: 'hallway',
    snrDb: 10,
    snrBandHz: [2000, 20000],
    clockDriftPpm: 30,
  },
  /** Difficulty guard: everything bad at once, quiet-mode band. */
  'worst-case-quiet': {
    clip: { thresholdDbfs: -6 },
    nonlinearity: {},
    bandLimit: { speakerModel: 'phone' },
    rir: 'hallway',
    clockDriftPpm: 50,
    agcWander: true,
    snrDb: 0,
    snrBandHz: [17000, 23000],
    startOffsetSamples: [0, 4800],
  },
};

/**
 * Realistic phone transducer magnitude response:
 *   - low end: 2nd-order Butterworth HPF, −3 dB at 350 Hz (+12 dB/oct below);
 *   - top end: |H| = 1/√(1+(f/15700)^18) — smooth knee, ≈54 dB/oct asymptote.
 * Analytic attenuations: 10 kHz ≈ 0.0 dB · 19 kHz ≈ 15 dB · 20 kHz ≈ 19 dB ·
 * 22.5 kHz ≈ 28 dB. No cliff: slope 20→22.5 kHz ≈ 54 dB/oct.
 */
function phoneMagnitude(fHz: number): number {
  if (fHz <= 0) return 0;
  const hp = 1 / Math.sqrt(1 + Math.pow(350 / fHz, 4));
  const lp = 1 / Math.sqrt(1 + Math.pow(fHz / 15700, 18));
  return hp * lp;
}

/** Cache of designed FIR kernels (design is deterministic; cache is per fs). */
const phoneFirCache = new Map<number, Float32Array>();

/** Group delay of the phone band-limit FIR: (taps−1)/2 = 255 samples (5.31 ms
 *  @48 kHz), removed by `filterAligned` so output stays sample-aligned. */
export const PHONE_FIR_TAPS = 511;

/**
 * Nominal phone transducer FIR — exported so the receiver's channel-matched
 * preamble correlator (modem/sync.ts) can use the same nominal response the
 * simulator applies. Both ends of a real link ship this same web app, so the
 * nominal model is common knowledge.
 */
export function phoneTransducerFir(fs: number): Float32Array {
  let h = phoneFirCache.get(fs);
  if (!h) {
    h = designFirFromMagnitude(phoneMagnitude, PHONE_FIR_TAPS, fs);
    phoneFirCache.set(fs, h);
  }
  return h;
}

function phoneBandLimitFir(fs: number): Float32Array {
  return phoneTransducerFir(fs);
}

/** Anti-image/anti-alias lowpass for the 2× oversampled nonlinearity stage. */
const nlLpCache = new Map<number, Float32Array>();

function nlLowpass(fs2: number): Float32Array {
  let h = nlLpCache.get(fs2);
  if (!h) {
    // Cutoff just under the ORIGINAL Nyquist (fs2/4·~0.98) so products above
    // it are removed before decimation.
    h = designLowpassFir(191, 0.49 * (fs2 / 2), fs2);
    nlLpCache.set(fs2, h);
  }
  return h;
}

/**
 * Memoryless polynomial distortion applied at 2× rate:
 *   upsample (zero-stuff + LP, gain 2) → y = x + a2 x² − a3 x³ → LP → decimate.
 * The final LP removes products above the original Nyquist — physically this
 * is the mic's anti-aliasing; without it, a 30 kHz 3rd harmonic of 10 kHz
 * would fold to a fake 18 kHz tone.
 */
function softSaturate(x: Float32Array, a2: number, a3: number, fs: number): Float32Array {
  const fs2 = fs * 2;
  const lp = nlLowpass(fs2);
  const up = new Float32Array(x.length * 2);
  for (let i = 0; i < x.length; i++) up[2 * i] = x[i]!;
  let y = filterAligned(up, lp);
  for (let i = 0; i < y.length; i++) {
    const v = y[i]! * 2; // ×2 restores amplitude lost to zero-stuffing
    y[i] = v + a2 * v * v - a3 * v * v * v;
  }
  y = filterAligned(y, lp);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = y[2 * i]!;
  return out;
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

  // 2) Speaker nonlinearity — memoryless polynomial at 2× oversampling.
  //    Defaults model a phone speaker at moderate drive (~1% THD @ 0.5 FS).
  if (opts.nonlinearity) {
    const a2 = opts.nonlinearity.secondOrder ?? 0.05;
    const a3 = opts.nonlinearity.thirdOrder ?? 0.1;
    x = softSaturate(x, a2, a3, fs);
  }

  // 3) Speaker/mic band-limit (linear-phase FIR, group delay removed).
  if (opts.bandLimit && opts.bandLimit.speakerModel === 'phone') {
    x = filterAligned(x, phoneBandLimitFir(fs));
  }

  // 4) Room multipath — full convolution truncated to input length
  //    (direct path at index 0 keeps alignment).
  if (opts.rir !== undefined) {
    const h =
      opts.rir instanceof Float32Array
        ? opts.rir
        : makeRir(opts.rir, (rng() * 0x100000000) >>> 0, fs);
    x = fftConvolve(x, h).slice(0, x.length);
  }

  // 5) Clock drift — evaluate waveform at t·(1+ε).
  if (opts.clockDriftPpm !== undefined && opts.clockDriftPpm !== 0) {
    x = resampleFractional(x, 1 + opts.clockDriftPpm * 1e-6);
  }

  // 6) Receiver AGC wander — slow multiplicative gain ±15% at ~0.4 Hz.
  if (opts.agcWander) {
    const phase = rng() * 2 * Math.PI;
    const w = (2 * Math.PI * 0.4) / fs;
    for (let i = 0; i < x.length; i++) {
      x[i]! *= 1 + 0.15 * Math.sin(w * i + phase);
    }
  }

  // 7) AWGN at target in-band SNR. The band is REQUIRED: a full-band default
  //    silently over-delivers SNR to narrowband modes (quiet mode got +6 dB).
  if (opts.snrDb !== undefined) {
    assert(
      opts.snrBandHz,
      'ChannelOpts.snrBandHz is required with snrDb — use activeBandHz(cfg)',
    );
    const [lo, hi] = opts.snrBandHz;
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

  // 8) Random start offset — silence prepended (receiver never knows when TX began).
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
