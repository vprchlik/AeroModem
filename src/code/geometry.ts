/**
 * Frame geometry — every frame occupies a whole number of OFDM data symbols.
 *
 * Header is ALWAYS BPSK with rate-1/2 convolutional coding + 3× repetition
 * (independent of payload modulation). Payload uses the configured modulation
 * and rate-1/2 FEC. Both regions are bit-interleaved across subcarriers and
 * across the OFDM symbols of that region.
 *
 * FAST_48K (683 data carriers), headerRep=3:
 *   | Mod    | hdr sym | pay sym | total | payload bytes |
 *   | BPSK   | 2       | 7       | 9     | 256           |
 *   | QPSK   | 2       | 4       | 6     | 256           |
 *   | 16-QAM | 2       | 2       | 4     | 256           |
 *
 * QUIET_48K (228 data carriers): 6+19 / 6+10 / 6+5.
 */

import type { ModemConfig, Modulation, DerivedConfig } from '../config';
import { derive, MOD_BITS } from '../config';
import { CONV_M } from './convolutional';

/** Header repetition factor (soft-combined at the receiver). */
export const HEADER_REPETITION = 3;

export interface FrameGeometry {
  /** Data carriers. */
  nDataCarriers: number;
  /** OFDM symbols occupied by the BPSK header region. */
  headerSymbols: number;
  /** OFDM symbols occupied by the payload region. */
  payloadSymbols: number;
  /** headerSymbols + payloadSymbols. */
  symbolsPerFrame: number;
  /** floor(dataSymbolsPerBurst / symbolsPerFrame). */
  framesPerBurst: number;
  /** Leftover data symbols in a burst after packing whole frames. */
  leftoverSymbols: number;
  /** Payload bytes per frame (= cfg.blockSize). */
  payloadBytes: number;
  /** Info bits in the header (24·8). */
  headerInfoBits: number;
  /** Coded+repeated header bits before padding. */
  headerCodedBits: number;
  /** Capacity of the header region (headerSymbols · nDataCarriers). */
  headerCapacityBits: number;
  /** Payload info bits including CRC-32 (= (blockSize+4)·8). */
  payloadInfoBits: number;
  /** Coded payload bits before padding (rate 1/2 + tail). */
  payloadCodedBits: number;
  /** Capacity of the payload region. */
  payloadCapacityBits: number;
  /** Coded bits per header OFDM symbol (BPSK). */
  headerBitsPerSymbol: number;
  /** Coded bits per payload OFDM symbol. */
  payloadBitsPerSymbol: number;
  /** Payload modulation. */
  payloadMod: Modulation;
}

function payloadModOf(cfg: ModemConfig): Modulation {
  if (Array.isArray(cfg.bitLoading)) {
    // Phase 5 uses uniform loading; take the first data-carrier entry's mod
    // via derive — but array is indexed by local active index including pilots.
    // Fall back to scanning for a non-pilot — simpler: require uniform for now.
    throw new Error('frameGeometry: array bitLoading not supported in Phase 5');
  }
  return cfg.bitLoading.uniform;
}

export function frameGeometry(cfg: ModemConfig, d?: DerivedConfig): FrameGeometry {
  const der = d ?? derive(cfg);
  const nDataCarriers = der.dataBins.length;
  const payloadMod = payloadModOf(cfg);
  const headerBitsPerSymbol = nDataCarriers * MOD_BITS.bpsk;
  const payloadBitsPerSymbol = nDataCarriers * MOD_BITS[payloadMod];

  const headerInfoBits = cfg.frameHeaderBytes * 8;
  const headerCodedBits = (headerInfoBits + CONV_M) * 2 * HEADER_REPETITION;
  const headerSymbols = Math.ceil(headerCodedBits / headerBitsPerSymbol);
  const headerCapacityBits = headerSymbols * headerBitsPerSymbol;

  const payloadInfoBits = (cfg.blockSize + 4) * 8; // + CRC-32
  const payloadCodedBits = (payloadInfoBits + CONV_M) * 2; // rate 1/2
  const payloadSymbols = Math.ceil(payloadCodedBits / payloadBitsPerSymbol);
  const payloadCapacityBits = payloadSymbols * payloadBitsPerSymbol;

  const symbolsPerFrame = headerSymbols + payloadSymbols;
  const framesPerBurst = Math.floor(cfg.dataSymbolsPerBurst / symbolsPerFrame);
  const leftoverSymbols = cfg.dataSymbolsPerBurst - framesPerBurst * symbolsPerFrame;

  return {
    nDataCarriers,
    headerSymbols,
    payloadSymbols,
    symbolsPerFrame,
    framesPerBurst,
    leftoverSymbols,
    payloadBytes: cfg.blockSize,
    headerInfoBits,
    headerCodedBits,
    headerCapacityBits,
    payloadInfoBits,
    payloadCodedBits,
    payloadCapacityBits,
    headerBitsPerSymbol,
    payloadBitsPerSymbol,
    payloadMod,
  };
}

/**
 * Per-symbol modulation schedule for one burst: header BPSK symbols interleaved
 * with payload-mod symbols for each packed frame, then BPSK padding for leftovers.
 */
export function burstSymbolMods(cfg: ModemConfig, geo?: FrameGeometry): Modulation[] {
  const g = geo ?? frameGeometry(cfg);
  const mods: Modulation[] = [];
  for (let f = 0; f < g.framesPerBurst; f++) {
    for (let i = 0; i < g.headerSymbols; i++) mods.push('bpsk');
    for (let i = 0; i < g.payloadSymbols; i++) mods.push(g.payloadMod);
  }
  while (mods.length < cfg.dataSymbolsPerBurst) mods.push('bpsk');
  return mods;
}

/** Net goodput using measured frame geometry (header on its own BPSK symbols). */
export function estimatedNetBitRateWithGeometry(cfg: ModemConfig): number {
  const der = derive(cfg);
  const g = frameGeometry(cfg, der);
  if (g.framesPerBurst <= 0) return 0;
  const symbolSamples = der.symbolSamples;
  const burstSamples =
    cfg.chirpLengthSamples +
    cfg.chirpGuardSamples +
    (cfg.trainingSymbols + cfg.dataSymbolsPerBurst) * symbolSamples;
  const burstSec = burstSamples / cfg.sampleRate;
  // Useful payload bytes per burst, after assumed LT overhead.
  const payloadBits = g.framesPerBurst * g.payloadBytes * 8;
  return payloadBits / (1 + cfg.ltOverheadEstimate) / burstSec;
}
