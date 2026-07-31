/**
 * CRC-32 (ISO-HDLC / Ethernet / PNG): poly 0xEDB88320 (reflected).
 * Used as the full-frame payload integrity check after Viterbi.
 */

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of `data`, init 0xFFFFFFFF, final XOR 0xFFFFFFFF. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Append a little-endian CRC-32 of `data` (4 bytes). */
export function appendCrc32(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 4);
  out.set(data);
  const c = crc32(data);
  out[data.length] = c & 0xff;
  out[data.length + 1] = (c >>> 8) & 0xff;
  out[data.length + 2] = (c >>> 16) & 0xff;
  out[data.length + 3] = (c >>> 24) & 0xff;
  return out;
}

/** Verify trailing little-endian CRC-32; returns payload without CRC, or null. */
export function stripCrc32(data: Uint8Array): Uint8Array | null {
  if (data.length < 4) return null;
  const body = data.subarray(0, data.length - 4);
  const expect =
    data[data.length - 4]! |
    (data[data.length - 3]! << 8) |
    (data[data.length - 2]! << 16) |
    (data[data.length - 1]! << 24);
  if ((crc32(body) >>> 0) !== (expect >>> 0)) return null;
  return body;
}
