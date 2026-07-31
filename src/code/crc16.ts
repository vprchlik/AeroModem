/**
 * CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, refin=false, refout=false, xorout=0.
 * Used for the 2-byte headerCrc field (bytes 0–21 of the 24-byte header).
 */

export function crc16Ccitt(data: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]! << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}
