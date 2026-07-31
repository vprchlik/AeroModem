/**
 * Pilot and training sequences — deterministic BPSK PN from the config seed.
 *
 * Pilots: one per `pilotSpacing` carriers (comb layout, see config.derive),
 * BPSK ±1 boosted by pilotBoostDb so channel tracking stays reliable on faded
 * carriers. Training symbols: every active bin carries a known ±1 value for
 * least-squares channel estimation.
 */

import type { ModemConfig, DerivedConfig } from '../config';
import { splitmix32 } from '../util/prng';

/** BPSK values (±amplitude) for each pilot bin, in pilotBins order. */
export function pilotValues(cfg: ModemConfig, d: DerivedConfig): Float32Array {
  const rng = splitmix32(cfg.pilotSeed);
  const amp = Math.pow(10, cfg.pilotBoostDb / 20);
  const out = new Float32Array(d.pilotBins.length);
  for (let i = 0; i < out.length; i++) out[i] = rng() < 0.5 ? -amp : amp;
  return out;
}

/** BPSK values (±1) for every active bin (training symbols), binLow…binHigh order. */
export function trainingValues(cfg: ModemConfig, d: DerivedConfig): Float32Array {
  const rng = splitmix32(cfg.pilotSeed ^ 0x7e57a1b2);
  const out = new Float32Array(d.nActive);
  for (let i = 0; i < out.length; i++) out[i] = rng() < 0.5 ? -1 : 1;
  return out;
}
