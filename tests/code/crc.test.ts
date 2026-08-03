import { describe, expect, it } from 'vitest';
import { crc32, appendCrc32, stripCrc32 } from '../../src/code/crc32';
import { crc16Ccitt } from '../../src/code/crc16';

describe('crc32', () => {
  it('matches the known IEEE vector for "123456789"', () => {
    const data = new TextEncoder().encode('123456789');
    expect(crc32(data)).toBe(0xcbf43926);
  });

  it('round-trips via append/strip', () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const framed = appendCrc32(body);
    expect(stripCrc32(framed)).toEqual(body);
  });

  it('rejects flipped bits', () => {
    const framed = appendCrc32(new Uint8Array([9, 8, 7]));
    framed[1]! ^= 0xff;
    expect(stripCrc32(framed)).toBeNull();
  });
});

describe('crc16Ccitt', () => {
  it('is stable and detects changes', () => {
    const a = new Uint8Array(22).fill(0x5a);
    const c1 = crc16Ccitt(a);
    expect(c1).toBeGreaterThan(0);
    a[3]! ^= 1;
    expect(crc16Ccitt(a)).not.toBe(c1);
  });
});
