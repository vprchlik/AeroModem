/**
 * ModemConfig — THE single source of modem parameters.
 * No magic numbers elsewhere: every sample rate, band edge, FFT size, pilot layout,
 * symbol rate, FEC rate, and fountain parameter lives here (or in ChannelOpts for
 * the simulator). Experiments sweep fields of this object.
 *
 * Derived quantities (bin ranges, pilot/data lists, rate estimates) are computed by
 * `derive()` and must never be hand-written.
 */

import { assert } from './util/assert';

export type Modulation = 'bpsk' | 'qpsk' | 'qam16';
export type FecRate = '1/2' | '2/3' | '3/4';
export type SampleRate = 48000 | 44100;

export interface ModemConfig {
  /** Nominal audio sample rate (Hz). Phones may report 48000 or 44100. */
  sampleRate: SampleRate;

  /** OFDM FFT size N (power of 2). Subcarrier spacing Δf = sampleRate / fftSize. */
  fftSize: number;
  /** Cyclic prefix length in samples. Absorbs early reflections (see PLAN.md §1.1). */
  cpLength: number;

  /** Lower edge of the active band (Hz), inclusive via nearest bin. */
  bandLowHz: number;
  /** Upper edge of the active band (Hz), inclusive via nearest bin. */
  bandHighHz: number;

  /**
   * Comb pilot spacing: 1 pilot every `pilotSpacing` carriers within the active band.
   * Spacing 9 ⇒ ~1 pilot per 8 data carriers (PLAN.md §2).
   */
  pilotSpacing: number;
  /** Seeds the deterministic pilot PN sequence (BPSK ±1). */
  pilotSeed: number;
  /** Pilot power boost relative to data carriers (dB). */
  pilotBoostDb: number;

  /** Linear chirp preamble length in samples. */
  chirpLengthSamples: number;
  /** Silence after chirp before the first training symbol (samples). */
  chirpGuardSamples: number;
  /** Number of known OFDM training symbols after the chirp (channel + SFO init). */
  trainingSymbols: number;
  /** Data OFDM symbols per burst between re-syncs. */
  dataSymbolsPerBurst: number;

  /**
   * Per-subcarrier modulation. Before Phase 7 this is always `{ uniform: … }`;
   * afterward an array of length = number of active carriers enables bit-loading.
   */
  bitLoading: Modulation[] | { uniform: Modulation };

  /** Inner convolutional code rate (punctured from mother rate 1/2). */
  fecRate: FecRate;

  /** Fountain source-block size in bytes. */
  blockSize: number;
  /** Fixed frame header size in bytes (see PLAN.md §5). */
  frameHeaderBytes: 24;
  /** Robust-soliton parameter c (Luby). */
  ltSolitonC: number;
  /** Robust-soliton failure probability δ. */
  ltSolitonDelta: number;

  /**
   * Assumed LT overhead ε used only by the *rate estimator* (not by the encoder).
   * Real ε is measured in Phase 5; 0.08 is the planning baseline from PLAN.md §2.
   */
  ltOverheadEstimate: number;

  /** Transmit digital amplitude in [0, 1] full scale (leave headroom for PAPR). */
  txAmplitude: number;
}

/** Bits per constellation symbol. */
export const MOD_BITS: Record<Modulation, number> = {
  bpsk: 1,
  qpsk: 2,
  qam16: 4,
};

/** FEC rate as a rational number (information bits / coded bits). */
export const FEC_RATE: Record<FecRate, number> = {
  '1/2': 1 / 2,
  '2/3': 2 / 3,
  '3/4': 3 / 4,
};

/**
 * Quantities derived from ModemConfig. Never hand-edit these numbers —
 * they are the single source for budgets, UI rate displays, and tests.
 */
export interface DerivedConfig {
  /** Subcarrier spacing Δf = sampleRate / fftSize (Hz). */
  deltaF: number;
  /** OFDM symbol length including CP (samples). */
  symbolSamples: number;
  /** OFDM symbol rate (symbols / second). */
  symbolRate: number;
  /** First active bin index (inclusive). */
  binLow: number;
  /** Last active bin index (inclusive). */
  binHigh: number;
  /** Number of active carriers = binHigh − binLow + 1. */
  nActive: number;
  /** Absolute FFT bin indices of pilot carriers (comb layout). */
  pilotBins: number[];
  /** Absolute FFT bin indices of data carriers. */
  dataBins: number[];
  /** Bits per data-carrier symbol under the configured bit-loading. */
  bitsPerDataCarrier: number[];
  /** Total coded bits per OFDM data symbol (sum over data carriers). */
  codedBitsPerSymbol: number;
  /** Raw coded bit rate from the OFDM data symbols alone (bit/s), before overheads. */
  rawCodedBitRate: number;
  /**
   * Estimated net goodput (bit/s) after burst overhead, frame-header overhead,
   * FEC rate, and assumed LT overhead. This is what the UI and Phase 0 tests quote.
   */
  estimatedNetBitRate: number;
  /** Fraction of burst airtime spent on data symbols (0..1). */
  burstDataFraction: number;
  /** Payload fraction of a frame after header + CRC-32 (0..1). */
  framePayloadFraction: number;
}

/** Hz → lowest FFT bin whose center frequency is ≥ hz (inclusive low edge). */
function hzToBinLow(hz: number, sampleRate: number, fftSize: number): number {
  return Math.ceil((hz * fftSize) / sampleRate);
}

/** Hz → highest FFT bin whose center frequency is ≤ hz (inclusive high edge). */
function hzToBinHigh(hz: number, sampleRate: number, fftSize: number): number {
  return Math.floor((hz * fftSize) / sampleRate);
}

function bitsForCarrier(bitLoading: ModemConfig['bitLoading'], carrierIndex: number): number {
  if (Array.isArray(bitLoading)) {
    const mod = bitLoading[carrierIndex];
    assert(mod !== undefined, `bitLoading missing entry for carrier ${carrierIndex}`);
    return MOD_BITS[mod];
  }
  return MOD_BITS[bitLoading.uniform];
}

/**
 * Derive all bin lists and rate estimates from a ModemConfig.
 * Band edges are mapped to nearest bins and clamped to (0, Nyquist).
 */
export function derive(cfg: ModemConfig): DerivedConfig {
  assert(cfg.fftSize > 0 && (cfg.fftSize & (cfg.fftSize - 1)) === 0, 'fftSize must be power of 2');
  assert(cfg.cpLength > 0 && cfg.cpLength < cfg.fftSize, 'cpLength out of range');
  assert(cfg.pilotSpacing >= 2, 'pilotSpacing must be ≥ 2');
  assert(cfg.bandLowHz < cfg.bandHighHz, 'bandLowHz must be < bandHighHz');
  assert(cfg.bandHighHz <= cfg.sampleRate / 2, 'bandHighHz exceeds Nyquist');

  const deltaF = cfg.sampleRate / cfg.fftSize;
  const symbolSamples = cfg.fftSize + cfg.cpLength;
  const symbolRate = cfg.sampleRate / symbolSamples;

  const nyquistBin = cfg.fftSize / 2 - 1; // last positive-frequency bin
  const binLow = Math.max(1, hzToBinLow(cfg.bandLowHz, cfg.sampleRate, cfg.fftSize));
  const binHigh = Math.min(nyquistBin, hzToBinHigh(cfg.bandHighHz, cfg.sampleRate, cfg.fftSize));
  assert(binLow <= binHigh, 'active band maps to empty bin range');

  const nActive = binHigh - binLow + 1;

  // Comb pilots: place a pilot at local indices 0, pilotSpacing, 2·pilotSpacing, …
  // Number of pilots = floor(nActive / pilotSpacing) when that divides cleanly with
  // a residual of data-only carriers at the top; for nActive=768, spacing=9 → 85 pilots.
  // We take every carrier whose local index i satisfies i % pilotSpacing === 0 AND
  // i + pilotSpacing <= nActive − 1 OR we simply take floor(nActive / spacing) pilots
  // at 0, spacing, … — matching PLAN.md §2 (85 + 683 for fast, 28 + 228 for quiet).
  const nPilots = Math.floor(nActive / cfg.pilotSpacing);
  const pilotBins: number[] = [];
  const pilotLocal = new Set<number>();
  for (let p = 0; p < nPilots; p++) {
    const local = p * cfg.pilotSpacing;
    pilotLocal.add(local);
    pilotBins.push(binLow + local);
  }

  const dataBins: number[] = [];
  const bitsPerDataCarrier: number[] = [];
  for (let local = 0; local < nActive; local++) {
    if (pilotLocal.has(local)) continue;
    dataBins.push(binLow + local);
    bitsPerDataCarrier.push(bitsForCarrier(cfg.bitLoading, local));
  }

  assert(
    pilotBins.length + dataBins.length === nActive,
    'pilot/data partition does not cover active band',
  );

  const codedBitsPerSymbol = bitsPerDataCarrier.reduce((a, b) => a + b, 0);
  const rawCodedBitRate = codedBitsPerSymbol * symbolRate;

  // Burst airtime: chirp + guard + training + data, expressed in sample-time.
  const burstSamples =
    cfg.chirpLengthSamples +
    cfg.chirpGuardSamples +
    (cfg.trainingSymbols + cfg.dataSymbolsPerBurst) * symbolSamples;
  const dataSamples = cfg.dataSymbolsPerBurst * symbolSamples;
  const burstDataFraction = dataSamples / burstSamples;

  // Frame: header + payload + CRC-32 (4 bytes). FEC and LT apply to the whole coded stream.
  const crcBytes = 4;
  const frameBytes = cfg.frameHeaderBytes + cfg.blockSize + crcBytes;
  const framePayloadFraction = cfg.blockSize / frameBytes;

  // Net goodput ≈ rawCoded × FEC_rate × burstDataFraction × framePayloadFraction / (1+ε)
  const fec = FEC_RATE[cfg.fecRate];
  const estimatedNetBitRate =
    (rawCodedBitRate * fec * burstDataFraction * framePayloadFraction) /
    (1 + cfg.ltOverheadEstimate);

  return {
    deltaF,
    symbolSamples,
    symbolRate,
    binLow,
    binHigh,
    nActive,
    pilotBins,
    dataBins,
    bitsPerDataCarrier,
    codedBitsPerSymbol,
    rawCodedBitRate,
    estimatedNetBitRate,
    burstDataFraction,
    framePayloadFraction,
  };
}

/** Shared defaults used by all 48 kHz presets. */
const BASE_48K = {
  sampleRate: 48000 as SampleRate,
  fftSize: 2048,
  cpLength: 512,
  pilotSpacing: 9,
  pilotSeed: 0xae70_0001,
  pilotBoostDb: 2.5,
  chirpLengthSamples: 4096,
  chirpGuardSamples: 256,
  trainingSymbols: 2,
  dataSymbolsPerBurst: 32,
  bitLoading: { uniform: 'qpsk' as Modulation },
  fecRate: '1/2' as FecRate,
  blockSize: 256,
  frameHeaderBytes: 24 as const,
  ltSolitonC: 0.05,
  ltSolitonDelta: 0.05,
  ltOverheadEstimate: 0.08,
  txAmplitude: 0.4,
};

/** Audible fast mode at 48 kHz: ≈ 2–20 kHz. */
export const FAST_48K: ModemConfig = {
  ...BASE_48K,
  bandLowHz: 2000,
  bandHighHz: 20000,
};

/** Near-ultrasonic quiet mode at 48 kHz: ≈ 17–23 kHz. */
export const QUIET_48K: ModemConfig = {
  ...BASE_48K,
  bandLowHz: 17000,
  bandHighHz: 23000,
};

/**
 * Robust mode: FAST band but BPSK payloads (headers are always BPSK anyway),
 * same interleaving. For ordinary reverberant rooms where the QPSK ISI margin
 * is gone (living-room QPSK payload success ≈ 0 at any SNR — PROGRESS.md
 * Phase 5). One fixed preset; adaptation stays in Phase 7.
 */
export const ROBUST_48K: ModemConfig = {
  ...BASE_48K,
  bandLowHz: 2000,
  bandHighHz: 20000,
  bitLoading: { uniform: 'bpsk' },
};

/**
 * Build a 44.1 kHz preset from a 48 kHz one: keep the same Hz band edges
 * (clamped to Nyquist), same numerology otherwise. Cross-rate TX/RX is out of
 * scope for v1 — both ends must display and match the active profile.
 */
function to44100(src: ModemConfig): ModemConfig {
  const nyquist = 44100 / 2;
  return {
    ...src,
    sampleRate: 44100,
    bandLowHz: Math.min(src.bandLowHz, nyquist - 100),
    bandHighHz: Math.min(src.bandHighHz, nyquist - 50),
  };
}

export const FAST_44K1: ModemConfig = to44100(FAST_48K);
export const QUIET_44K1: ModemConfig = to44100(QUIET_48K);
export const ROBUST_44K1: ModemConfig = to44100(ROBUST_48K);

/** Named presets for the UI mode toggle. */
export const PRESETS = {
  'fast-48k': FAST_48K,
  'quiet-48k': QUIET_48K,
  'robust-48k': ROBUST_48K,
  'fast-44k1': FAST_44K1,
  'quiet-44k1': QUIET_44K1,
  'robust-44k1': ROBUST_44K1,
} as const;

export type PresetId = keyof typeof PRESETS;
