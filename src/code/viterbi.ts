/**
 * Soft-decision Viterbi decoder for the rate-1/2 K=7 mother code.
 *
 * LLR convention matches mapping.ts: LLR > 0 ⇒ bit was more likely 1.
 * Branch metric for expected coded bit b ∈ {0,1}:  −LLR if b=1, +LLR if b=0
 * (equivalently: choose the path maximizing Σ LLR·(2b−1)).
 *
 * Termination: encoder starts and ends in state 0 (6 zero tail bits).
 */

import type { FecRate } from '../config';
import { assert } from '../util/assert';
import { CONV_M, CONV_STATES, convTables } from './convolutional';

/**
 * Decode soft LLRs (length = 2·(infoBits + 6) for rate 1/2).
 * Returns the info bits only (tail discarded).
 */
export function viterbiDecode(llrs: Float32Array, rate: FecRate = '1/2'): Uint8Array {
  assert(rate === '1/2', `Phase 5 supports rate 1/2 only (got ${rate})`);
  assert(llrs.length % 2 === 0, 'LLR length must be even for rate 1/2');
  const nSteps = llrs.length / 2;
  assert(nSteps > CONV_M, 'too few coded symbols for a tailed frame');
  const nInfo = nSteps - CONV_M;

  const { nextState, outputs } = convTables();

  // Path metrics (float64 for dynamic range over long frames).
  let prev = new Float64Array(CONV_STATES);
  let curr = new Float64Array(CONV_STATES);
  prev.fill(-Infinity);
  prev[0] = 0;

  // Survivor bit + previous state per (step, state).
  const survBit = new Uint8Array(nSteps * CONV_STATES);
  const survPrev = new Uint16Array(nSteps * CONV_STATES);

  for (let t = 0; t < nSteps; t++) {
    curr.fill(-Infinity);
    const l0 = llrs[2 * t]!;
    const l1 = llrs[2 * t + 1]!;
    for (let s = 0; s < CONV_STATES; s++) {
      const pm = prev[s]!;
      if (pm === -Infinity) continue;
      for (let bit = 0; bit < 2; bit++) {
        // During the tail, only bit=0 is legal — still explore both and force
        // the traceback from state 0; illegal paths simply won't win.
        const ns = nextState[s]![bit]!;
        const o = outputs[s]![bit]!;
        const b0 = (o >>> 1) & 1;
        const b1 = o & 1;
        // Maximize Σ LLR·(2b−1): contribution for expected bits b0,b1.
        const bm = (b0 ? l0 : -l0) + (b1 ? l1 : -l1);
        const cand = pm + bm;
        if (cand > curr[ns]!) {
          curr[ns] = cand;
          survBit[t * CONV_STATES + ns] = bit;
          survPrev[t * CONV_STATES + ns] = s;
        }
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  // Traceback from state 0 (encoder terminated there).
  const bits = new Uint8Array(nSteps);
  let state = 0;
  for (let t = nSteps - 1; t >= 0; t--) {
    bits[t] = survBit[t * CONV_STATES + state]!;
    state = survPrev[t * CONV_STATES + state]!;
  }
  return bits.subarray(0, nInfo);
}
