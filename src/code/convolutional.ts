/**
 * Rate-1/2 K=7 convolutional encoder, generators (171, 133) octal
 * (industry-standard NASA/CCSDS / 802.11 mother code).
 *
 * Each frame is zero-tailed with 6 bits (flush the 6 memory registers).
 * Puncturing to 2/3 and 3/4 is reserved for Phase 7; Phase 5 uses rate 1/2 only.
 */

import type { FecRate } from '../config';
import { assert } from '../util/assert';

/** Generator polynomials (octal): g0 = 171 = 0b1_111_001, g1 = 133 = 0b1_011_011. */
export const CONV_G0 = 0o171;
export const CONV_G1 = 0o133;
export const CONV_K = 7;
export const CONV_M = CONV_K - 1; // 6 memory bits
export const CONV_STATES = 1 << CONV_M; // 64

function parity(x: number): number {
  let p = 0;
  let v = x;
  while (v) {
    p ^= v & 1;
    v >>>= 1;
  }
  return p;
}

/**
 * Encode info bits (0/1) at the given rate. Appends 6 zero tail bits before encoding.
 * Returns coded bits (0/1). Rate 1/2 only for now; other rates throw.
 */
export function convEncode(infoBits: Uint8Array, rate: FecRate = '1/2'): Uint8Array {
  assert(rate === '1/2', `Phase 5 supports rate 1/2 only (got ${rate})`);
  const nInfo = infoBits.length + CONV_M; // + tail
  const out = new Uint8Array(nInfo * 2);
  let state = 0;
  let o = 0;
  for (let i = 0; i < nInfo; i++) {
    const bit = i < infoBits.length ? infoBits[i]! & 1 : 0;
    const reg = (bit << CONV_M) | state; // [u | m5…m0]
    out[o++] = parity(reg & CONV_G0);
    out[o++] = parity(reg & CONV_G1);
    state = reg >>> 1; // shift toward LSB (oldest)
  }
  return out;
}

/** Next-state / output tables for the Viterbi decoder (built once). */
export interface ConvTables {
  /** nextState[state][bit] */
  nextState: Uint8Array[];
  /** outputs[state][bit] = (out0 << 1) | out1, each ∈ {0,1} */
  outputs: Uint8Array[];
}

let cachedTables: ConvTables | null = null;

export function convTables(): ConvTables {
  if (cachedTables) return cachedTables;
  const nextState: Uint8Array[] = [];
  const outputs: Uint8Array[] = [];
  for (let s = 0; s < CONV_STATES; s++) {
    const ns = new Uint8Array(2);
    const outs = new Uint8Array(2);
    for (let bit = 0; bit < 2; bit++) {
      const reg = (bit << CONV_M) | s;
      ns[bit] = reg >>> 1;
      outs[bit] = (parity(reg & CONV_G0) << 1) | parity(reg & CONV_G1);
    }
    nextState.push(ns);
    outputs.push(outs);
  }
  cachedTables = { nextState, outputs };
  return cachedTables;
}
