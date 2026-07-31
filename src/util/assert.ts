/**
 * Tiny assertion helpers used in DSP hot paths and tests.
 * Failures throw Error — never silently continue with bad state.
 */

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new Error(message);
  }
}

export function assertPowerOfTwo(n: number, label = 'size'): void {
  assert(
    Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0,
    `${label} must be a power of two, got ${n}`,
  );
}
