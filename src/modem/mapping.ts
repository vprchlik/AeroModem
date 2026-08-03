/**
 * Constellation mapping and max-log soft demapping.
 *
 * Conventions:
 *   - Bits are Uint8Array elements ∈ {0,1}, MSB-first per symbol.
 *   - All constellations are unit AVERAGE power (E|s|² = 1) so per-carrier SNR
 *     comparisons across modulations are fair.
 *   - LLR sign convention: LLR > 0 ⇒ bit = 1. Hard decision = (llr > 0).
 *   - `csiWeight` multiplies each LLR by |Ĥ|²/σ² so faded carriers contribute
 *     weak beliefs to the (Phase 5) Viterbi decoder.
 *
 * Gray mappings:
 *   BPSK:  0 → −1, 1 → +1 (real axis).
 *   QPSK:  bit0 → real axis, bit1 → imag axis, each BPSK at ±1/√2.
 *   16-QAM: 4 bits = (b0 b1) real × (b2 b3) imag, per axis Gray:
 *     (0,0)→−3α  (0,1)→−1α  (1,1)→+1α  (1,0)→+3α,  α = 1/√10.
 */

import type { Modulation } from '../config';
import { MOD_BITS } from '../config';

const Q_AMP = Math.SQRT1_2; // 1/√2, QPSK per-axis amplitude
const Q16_ALPHA = 1 / Math.sqrt(10); // 16-QAM axis scale for unit average power

/** Map one axis pair of bits (Gray) to a 16-QAM level in units of α. */
function qam16Level(b0: number, b1: number): number {
  // (0,0)→−3, (0,1)→−1, (1,1)→+1, (1,0)→+3
  return b0 === 0 ? (b1 === 0 ? -3 : -1) : b1 === 1 ? 1 : 3;
}

/**
 * Map `count` carriers from `bits[bitOff…]` with modulation `mod`.
 * Writes constellation points into outRe/outIm[outOff…outOff+count).
 * Returns the number of bits consumed.
 */
export function mapCarriers(
  bits: Uint8Array,
  bitOff: number,
  mod: Modulation,
  count: number,
  outRe: Float32Array,
  outIm: Float32Array,
  outOff: number,
): number {
  let p = bitOff;
  for (let i = 0; i < count; i++) {
    const o = outOff + i;
    switch (mod) {
      case 'bpsk': {
        outRe[o] = bits[p]! === 1 ? 1 : -1;
        outIm[o] = 0;
        p += 1;
        break;
      }
      case 'qpsk': {
        outRe[o] = (bits[p]! === 1 ? 1 : -1) * Q_AMP;
        outIm[o] = (bits[p + 1]! === 1 ? 1 : -1) * Q_AMP;
        p += 2;
        break;
      }
      case 'qam16': {
        outRe[o] = qam16Level(bits[p]!, bits[p + 1]!) * Q16_ALPHA;
        outIm[o] = qam16Level(bits[p + 2]!, bits[p + 3]!) * Q16_ALPHA;
        p += 4;
        break;
      }
    }
  }
  return p - bitOff;
}

/** Max-log LLRs for one axis of 16-QAM (levels ±1α, ±3α), weighted by w. */
function qam16AxisLlrs(y: number, w: number, out: Float32Array, o: number): void {
  const a = Q16_ALPHA;
  // Distances to the four levels.
  const dm3 = (y + 3 * a) * (y + 3 * a); // b=(0,0)
  const dm1 = (y + a) * (y + a); //         b=(0,1)
  const dp1 = (y - a) * (y - a); //         b=(1,1)
  const dp3 = (y - 3 * a) * (y - 3 * a); // b=(1,0)
  // bit0: 0 ∈ {−3,−1}, 1 ∈ {+1,+3}; LLR>0 ⇒ bit 1.
  out[o] = w * (Math.min(dm3, dm1) - Math.min(dp1, dp3));
  // bit1: 0 ∈ {−3,+3} (outer), 1 ∈ {−1,+1} (inner).
  out[o + 1] = w * (Math.min(dm3, dp3) - Math.min(dm1, dp1));
}

/**
 * Soft demap `count` equalized carriers starting at inOff.
 * `csiWeight[i]` scales the carrier's LLRs (|Ĥ|²/σ²; use 1 for unweighted).
 * Writes into outLlr[llrOff…]; returns number of LLRs written.
 */
export function demapCarriers(
  re: Float32Array,
  im: Float32Array,
  inOff: number,
  mod: Modulation,
  count: number,
  csiWeight: Float32Array | null,
  outLlr: Float32Array,
  llrOff: number,
): number {
  let p = llrOff;
  for (let i = 0; i < count; i++) {
    const y = re[inOff + i]!;
    const z = im[inOff + i]!;
    const w = csiWeight ? csiWeight[i]! : 1;
    switch (mod) {
      case 'bpsk': {
        // LLR = w · ((y+1)² − (y−1)²) = w·4y  ⇒ sign(y) decides.
        outLlr[p++] = 4 * w * y;
        break;
      }
      case 'qpsk': {
        outLlr[p++] = 4 * w * y * Q_AMP * 2; // = w·((y+q)²−(y−q)²)·… ∝ y
        outLlr[p++] = 4 * w * z * Q_AMP * 2;
        break;
      }
      case 'qam16': {
        qam16AxisLlrs(y, w, outLlr, p);
        qam16AxisLlrs(z, w, outLlr, p + 2);
        p += 4;
        break;
      }
    }
  }
  return p - llrOff;
}

/** Hard bits from LLRs (llr > 0 ⇒ 1). */
export function hardDecisions(llr: Float32Array, out?: Uint8Array): Uint8Array {
  const bits = out ?? new Uint8Array(llr.length);
  for (let i = 0; i < llr.length; i++) bits[i] = llr[i]! > 0 ? 1 : 0;
  return bits;
}

export function bitsPerCarrier(mod: Modulation): number {
  return MOD_BITS[mod];
}
