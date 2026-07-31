/**
 * Frame header + payload encode/decode.
 *
 * Header (24 B) is protected independently of the payload:
 *   bytes → CRC-16 fill → conv rate-1/2 (+6 tail) → 3× repetition → interleave
 *   → mapped BPSK on dedicated OFDM symbols.
 *
 * Payload (blockSize B) + CRC-32:
 *   → conv rate-1/2 → interleave across payload symbols × carriers
 *   → mapped at the configured payload modulation.
 *
 * A lost/corrupt header drops the whole frame regardless of payload FEC —
 * hence the heavier header protection. Interleaving is on by default; tests
 * may disable it to measure the A/B frame-success impact.
 */

import type { ModemConfig } from '../config';
import { assert } from '../util/assert';
import { crc16Ccitt } from './crc16';
import { appendCrc32, stripCrc32 } from './crc32';
import { bytesToBits, bitsToBytes } from './bits';
import { convEncode } from './convolutional';
import { viterbiDecode } from './viterbi';
import {
  interleaveBits,
  deinterleaveLlrs,
  passthroughBits,
  passthroughLlrs,
} from './interleave';
import {
  frameGeometry,
  HEADER_REPETITION,
  type FrameGeometry,
} from './geometry';

export const HEADER_MAGIC = 0x31464d41; // 'AMF1' little-endian

export interface FrameHeader {
  magic: number;
  sessionId: number;
  fileLength: number;
  K: number;
  blockSize: number;
  packetSeed: number;
  flags: number;
}

export interface FrameEncodeOptions {
  /** Default true. Set false only for interleave A/B tests. */
  interleave?: boolean;
}

export interface EncodedFrame {
  /** Concatenation of header-region bits + payload-region bits (0/1). */
  bits: Uint8Array;
  header: FrameHeader;
  geometry: FrameGeometry;
}

export interface DecodedFrame {
  header: FrameHeader;
  payload: Uint8Array;
}

export interface FrameDecodeStats {
  headerOk: boolean;
  payloadOk: boolean;
}

function writeHeaderBytes(h: FrameHeader): Uint8Array {
  const b = new Uint8Array(24);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, h.magic >>> 0, true);
  dv.setUint32(4, h.sessionId >>> 0, true);
  dv.setUint32(8, h.fileLength >>> 0, true);
  dv.setUint16(12, h.K & 0xffff, true);
  dv.setUint16(14, h.blockSize & 0xffff, true);
  dv.setUint32(16, h.packetSeed >>> 0, true);
  dv.setUint16(20, h.flags & 0xffff, true);
  const crc = crc16Ccitt(b.subarray(0, 22));
  dv.setUint16(22, crc, true);
  return b;
}

function readHeaderBytes(b: Uint8Array): FrameHeader | null {
  if (b.length < 24) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const crcExpect = dv.getUint16(22, true);
  if (crc16Ccitt(b.subarray(0, 22)) !== crcExpect) return null;
  const magic = dv.getUint32(0, true);
  if (magic !== HEADER_MAGIC) return null;
  return {
    magic,
    sessionId: dv.getUint32(4, true),
    fileLength: dv.getUint32(8, true),
    K: dv.getUint16(12, true),
    blockSize: dv.getUint16(14, true),
    packetSeed: dv.getUint32(16, true),
    flags: dv.getUint16(20, true),
  };
}

/** Repeat each bit `rep` times (hard). */
function repeatBits(bits: Uint8Array, rep: number): Uint8Array {
  const out = new Uint8Array(bits.length * rep);
  for (let i = 0; i < bits.length; i++) {
    for (let r = 0; r < rep; r++) out[i * rep + r] = bits[i]!;
  }
  return out;
}

/** Soft-combine `rep` repetitions: out[i] = Σ llrs[i·rep + r]. */
function combineRepetitions(llrs: Float32Array, rep: number): Float32Array {
  assert(llrs.length % rep === 0, 'LLR length not divisible by repetition');
  const n = llrs.length / rep;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let r = 0; r < rep; r++) s += llrs[i * rep + r]!;
    out[i] = s;
  }
  return out;
}

function padTo(bits: Uint8Array, n: number): Uint8Array {
  if (bits.length === n) return bits;
  assert(bits.length <= n, 'coded bits exceed region capacity');
  const out = new Uint8Array(n);
  out.set(bits);
  return out;
}

function padLlrsTo(llrs: Float32Array, n: number): Float32Array {
  if (llrs.length === n) return llrs;
  const out = new Float32Array(n);
  out.set(llrs.subarray(0, Math.min(llrs.length, n)));
  return out;
}

/**
 * Encode one LT packet into a full frame's worth of coded bits
 * (header region || payload region), ready to map onto OFDM symbols.
 */
export function encodeFrame(
  header: FrameHeader,
  payload: Uint8Array,
  cfg: ModemConfig,
  opts: FrameEncodeOptions = {},
): EncodedFrame {
  const doInterleave = opts.interleave !== false;
  const geo = frameGeometry(cfg);
  assert(payload.length === cfg.blockSize, 'payload must equal blockSize');
  assert(header.blockSize === cfg.blockSize, 'header.blockSize mismatch');

  const hdrBytes = writeHeaderBytes({ ...header, magic: HEADER_MAGIC });
  const hdrInfo = bytesToBits(hdrBytes);
  const hdrCoded = convEncode(hdrInfo, cfg.fecRate);
  const hdrRep = repeatBits(hdrCoded, HEADER_REPETITION);
  const hdrPadded = padTo(hdrRep, geo.headerCapacityBits);
  const hdrBits = doInterleave
    ? interleaveBits(hdrPadded, geo.headerSymbols, geo.headerBitsPerSymbol)
    : passthroughBits(hdrPadded);

  const payWithCrc = appendCrc32(payload);
  const payInfo = bytesToBits(payWithCrc);
  const payCoded = convEncode(payInfo, cfg.fecRate);
  const payPadded = padTo(payCoded, geo.payloadCapacityBits);
  const payBits = doInterleave
    ? interleaveBits(payPadded, geo.payloadSymbols, geo.payloadBitsPerSymbol)
    : passthroughBits(payPadded);

  const bits = new Uint8Array(hdrBits.length + payBits.length);
  bits.set(hdrBits, 0);
  bits.set(payBits, hdrBits.length);

  return { bits, header: { ...header, magic: HEADER_MAGIC }, geometry: geo };
}

/**
 * Decode one frame from concatenated header+payload LLRs (same layout as encode).
 * Returns null if header or payload fails; stats always filled.
 */
export function decodeFrame(
  llrs: Float32Array,
  cfg: ModemConfig,
  opts: FrameEncodeOptions = {},
): { frame: DecodedFrame | null; stats: FrameDecodeStats } {
  const doInterleave = opts.interleave !== false;
  const geo = frameGeometry(cfg);
  const need = geo.headerCapacityBits + geo.payloadCapacityBits;
  assert(llrs.length >= need, `need ${need} LLRs, got ${llrs.length}`);

  const stats: FrameDecodeStats = { headerOk: false, payloadOk: false };

  // --- Header ---
  const hdrTx = llrs.subarray(0, geo.headerCapacityBits);
  const hdrDe = doInterleave
    ? deinterleaveLlrs(hdrTx, geo.headerSymbols, geo.headerBitsPerSymbol)
    : passthroughLlrs(hdrTx);
  // Drop padding beyond coded+repeated length, then soft-combine repetitions.
  const hdrRepLlrs = hdrDe.subarray(0, geo.headerCodedBits);
  const hdrCodedLlrs = combineRepetitions(hdrRepLlrs, HEADER_REPETITION);
  const hdrBits = viterbiDecode(hdrCodedLlrs, cfg.fecRate);
  const hdrBytes = bitsToBytes(hdrBits.subarray(0, geo.headerInfoBits));
  const header = readHeaderBytes(hdrBytes);
  if (!header) return { frame: null, stats };
  stats.headerOk = true;

  // --- Payload ---
  const payTx = llrs.subarray(
    geo.headerCapacityBits,
    geo.headerCapacityBits + geo.payloadCapacityBits,
  );
  const payDe = doInterleave
    ? deinterleaveLlrs(payTx, geo.payloadSymbols, geo.payloadBitsPerSymbol)
    : passthroughLlrs(payTx);
  const payCodedLlrs = payDe.subarray(0, geo.payloadCodedBits);
  const payBits = viterbiDecode(payCodedLlrs, cfg.fecRate);
  const payBytes = bitsToBytes(payBits.subarray(0, geo.payloadInfoBits));
  const body = stripCrc32(payBytes);
  if (!body || body.length !== cfg.blockSize) return { frame: null, stats };
  stats.payloadOk = true;

  return { frame: { header, payload: body }, stats };
}

/** Build a raw (uncoded) frame byte buffer: header || payload || crc32 — test helper. */
export function buildFrame(h: FrameHeader, payload: Uint8Array): Uint8Array {
  const hdr = writeHeaderBytes({ ...h, magic: HEADER_MAGIC });
  const body = appendCrc32(payload);
  const out = new Uint8Array(hdr.length + body.length);
  out.set(hdr);
  out.set(body, hdr.length);
  return out;
}

export function parseFrame(
  bytes: Uint8Array,
): { header: FrameHeader; payload: Uint8Array } | null {
  if (bytes.length < 24 + 4) return null;
  const header = readHeaderBytes(bytes.subarray(0, 24));
  if (!header) return null;
  const rest = stripCrc32(bytes.subarray(24));
  if (!rest) return null;
  return { header, payload: rest };
}

// re-export pad helper for burst assembly
export { padLlrsTo };
