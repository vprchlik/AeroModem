import { describe, expect, it } from 'vitest';
import { interleaveBits, deinterleaveLlrs } from '../../src/code/interleave';

describe('interleave', () => {
  it('is invertible on LLRs', () => {
    const nSymbols = 4;
    const bitsPerSymbol = 6;
    const n = nSymbols * bitsPerSymbol;
    const bits = new Uint8Array(n);
    for (let i = 0; i < n; i++) bits[i] = i & 1;
    const tx = interleaveBits(bits, nSymbols, bitsPerSymbol);
    const llrs = new Float32Array(n);
    for (let i = 0; i < n; i++) llrs[i] = tx[i]! ? 1 : -1;
    const back = deinterleaveLlrs(llrs, nSymbols, bitsPerSymbol);
    for (let i = 0; i < n; i++) {
      expect(back[i]! > 0 ? 1 : 0).toBe(bits[i]);
    }
  });

  it('spreads consecutive bits across symbols', () => {
    const nSymbols = 4;
    const bitsPerSymbol = 8;
    const bits = new Uint8Array(nSymbols * bitsPerSymbol);
    bits[0] = 1;
    bits[1] = 1;
    bits[2] = 1;
    bits[3] = 1;
    const tx = interleaveBits(bits, nSymbols, bitsPerSymbol);
    // First four coded bits land at the start of four different symbols.
    expect(tx[0 * bitsPerSymbol]).toBe(1);
    expect(tx[1 * bitsPerSymbol]).toBe(1);
    expect(tx[2 * bitsPerSymbol]).toBe(1);
    expect(tx[3 * bitsPerSymbol]).toBe(1);
  });
});
