/**
 * Seedable PRNG — the only source of randomness in AeroModem.
 * Every random draw (fountain degrees, AWGN, RIR, test noise) flows through here
 * so tests are bit-identical across runs when given the same seed.
 */

/**
 * SplitMix32: fast 32-bit mixer PRNG (Steele, Lea, Flood & Black, 2014).
 * Returns a closure producing Uniform[0, 1) floats.
 * Seed is coerced to uint32; same seed ⇒ same sequence forever.
 */
export function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    z = (z ^ (z >>> 16)) >>> 0;
    return z / 0x100000000;
  };
}

/**
 * Box–Muller transform: two independent Uniform[0,1) draws → two i.i.d. N(0,1).
 * Returns a pair so both uniforms are consumed (no leftover cache state).
 */
export function gaussianPair(rng: () => number): [number, number] {
  // Rejection of the measure-zero u1=0 case that would make log(0) = −∞.
  let u1 = 0;
  while (u1 <= Number.EPSILON) {
    u1 = rng();
  }
  const u2 = rng();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}
