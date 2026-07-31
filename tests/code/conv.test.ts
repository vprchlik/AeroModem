import { describe, expect, it } from 'vitest';
import { convEncode } from '../../src/code/convolutional';
import { viterbiDecode } from '../../src/code/viterbi';
import { bytesToBits, bitsToBytes } from '../../src/code/bits';
import { splitmix32, gaussianPair } from '../../src/util/prng';

describe('convolutional + viterbi', () => {
  it('round-trips clean LLRs', () => {
    const info = bytesToBits(new Uint8Array(32).map((_, i) => i * 7 + 3));
    const coded = convEncode(info, '1/2');
    const llrs = new Float32Array(coded.length);
    for (let i = 0; i < coded.length; i++) llrs[i] = coded[i]! ? 8 : -8;
    const dec = viterbiDecode(llrs, '1/2');
    expect(dec).toEqual(info);
  });

  it('beats uncoded hard decisions at moderate SNR', () => {
    // BPSK over AWGN at ~4 dB Eb/N0 on the coded bits; soft Viterbi should
    // recover a 64-byte block with far fewer residual bit errors than hard.
    const rng = splitmix32(99);
    const info = new Uint8Array(64 * 8);
    for (let i = 0; i < info.length; i++) info[i] = rng() < 0.5 ? 0 : 1;
    const coded = convEncode(info, '1/2');

    const snrDb = 4;
    const snr = Math.pow(10, snrDb / 10);
    const sigma = Math.sqrt(1 / (2 * snr)); // Eb=1 for coded bit
    const llrs = new Float32Array(coded.length);
    let hardErr = 0;
    for (let i = 0; i < coded.length; i++) {
      const [g] = gaussianPair(rng);
      const x = (coded[i]! ? 1 : -1) + sigma * g;
      llrs[i] = (2 / (sigma * sigma)) * x; // exact LLR scale for unit-power BPSK
      if ((x > 0 ? 1 : 0) !== coded[i]) hardErr++;
    }
    const dec = viterbiDecode(llrs, '1/2');
    let softErr = 0;
    for (let i = 0; i < info.length; i++) if (dec[i] !== info[i]) softErr++;
    // Soft Viterbi should crush the coded-bit hard error rate when referred
    // back to info bits (rate-1/2 ≈ doubles channel uses).
    expect(softErr).toBeLessThan(hardErr / 4);
    expect(softErr / info.length).toBeLessThan(1e-2);
  });

  it('bytes helpers are inverses', () => {
    const b = new Uint8Array([0x00, 0xff, 0xa5, 0x5a]);
    expect(bitsToBytes(bytesToBits(b))).toEqual(b);
  });
});
