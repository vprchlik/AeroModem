/**
 * Frame bit interleaver — mandatory for the inner FEC on frequency-selective
 * acoustic channels (Group 8 and deep fades produce concentrated errors).
 *
 * Permutation: consecutive coded bits are spread first across OFDM symbols,
 * then across bit-positions within a symbol (≈ across subcarriers):
 *
 *   txPos = (k % nSymbols) * bitsPerSymbol + floor(k / nSymbols)
 *
 * so a dying band yields scattered errors the Viterbi can correct, rather than
 * a burst that kills one region of the codeword.
 *
 * Pad length must equal nSymbols · bitsPerSymbol (caller pads with zeros).
 */

import { assert } from '../util/assert';

export function interleaveSize(nSymbols: number, bitsPerSymbol: number): number {
  return nSymbols * bitsPerSymbol;
}

/** Forward interleave of hard bits (0/1). */
export function interleaveBits(
  coded: Uint8Array,
  nSymbols: number,
  bitsPerSymbol: number,
): Uint8Array {
  const n = nSymbols * bitsPerSymbol;
  assert(coded.length === n, `interleave: need ${n} bits, got ${coded.length}`);
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const txPos = (k % nSymbols) * bitsPerSymbol + Math.floor(k / nSymbols);
    out[txPos] = coded[k]!;
  }
  return out;
}

/** Inverse interleave of soft LLRs (same permutation). */
export function deinterleaveLlrs(
  txLlrs: Float32Array,
  nSymbols: number,
  bitsPerSymbol: number,
): Float32Array {
  const n = nSymbols * bitsPerSymbol;
  assert(txLlrs.length === n, `deinterleave: need ${n} LLRs, got ${txLlrs.length}`);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const txPos = (k % nSymbols) * bitsPerSymbol + Math.floor(k / nSymbols);
    out[k] = txLlrs[txPos]!;
  }
  return out;
}

/** Identity "interleave" (for A/B tests with interleaving disabled). */
export function passthroughBits(coded: Uint8Array): Uint8Array {
  return coded.slice();
}

export function passthroughLlrs(llrs: Float32Array): Float32Array {
  return llrs.slice();
}
