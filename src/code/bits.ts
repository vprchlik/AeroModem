/** Pack/unpack helpers: bytes ↔ MSB-first bit arrays (Uint8Array of 0/1). */

export function bytesToBits(bytes: Uint8Array): Uint8Array {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i]!;
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (v >>> (7 - b)) & 1;
  }
  return bits;
}

export function bitsToBytes(bits: Uint8Array): Uint8Array {
  const n = Math.floor(bits.length / 8);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | (bits[i * 8 + b]! & 1);
    out[i] = v;
  }
  return out;
}

/** Soft bits → hard 0/1 (llr > 0 ⇒ 1). */
export function hardFromLlrs(llrs: Float32Array): Uint8Array {
  const bits = new Uint8Array(llrs.length);
  for (let i = 0; i < llrs.length; i++) bits[i] = llrs[i]! > 0 ? 1 : 0;
  return bits;
}
