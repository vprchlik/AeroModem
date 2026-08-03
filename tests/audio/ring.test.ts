import { describe, expect, it } from 'vitest';
import { FloatRing } from '../../src/audio/ring';

describe('FloatRing', () => {
  it('writes and reads in order', () => {
    const r = new FloatRing(8);
    expect(r.write([1, 2, 3, 4])).toBe(4);
    expect(r.length).toBe(4);
    const dst = new Float32Array(4);
    expect(r.read(dst)).toBe(4);
    expect(Array.from(dst)).toEqual([1, 2, 3, 4]);
    expect(r.length).toBe(0);
  });

  it('wraps around the end of the buffer', () => {
    const r = new FloatRing(4);
    r.write([10, 20, 30, 40]);
    const a = new Float32Array(2);
    r.read(a);
    expect(Array.from(a)).toEqual([10, 20]);
    // Write past the old wrap point.
    expect(r.write([50, 60])).toBe(2);
    expect(r.length).toBe(4);
    const b = new Float32Array(4);
    r.read(b);
    expect(Array.from(b)).toEqual([30, 40, 50, 60]);
  });

  it('counts overflow when full', () => {
    const r = new FloatRing(3);
    expect(r.write([1, 2, 3, 4, 5])).toBe(3);
    expect(r.overflowSamples).toBe(2);
    expect(r.length).toBe(3);
  });

  it('zero-fills and counts underflow on short read', () => {
    const r = new FloatRing(4);
    r.write([7]);
    const dst = new Float32Array(3);
    expect(r.read(dst)).toBe(1);
    expect(Array.from(dst)).toEqual([7, 0, 0]);
    expect(r.underflowSamples).toBe(2);
  });

  it('clear resets length but keeps diagnostic counters', () => {
    const r = new FloatRing(4);
    r.write([1, 2, 3, 4, 5]);
    expect(r.overflowSamples).toBe(1);
    r.clear();
    expect(r.length).toBe(0);
    expect(r.overflowSamples).toBe(1);
  });
});
