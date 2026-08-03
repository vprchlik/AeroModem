import { describe, expect, it } from 'vitest';
import { FAST_48K, QUIET_48K } from '../../src/config';
import { frameGeometry } from '../../src/code/geometry';
import {
  encodeFrame,
  decodeFrame,
  buildFrame,
  parseFrame,
  HEADER_MAGIC,
  type FrameHeader,
} from '../../src/code/frame';
import { splitmix32, gaussianPair } from '../../src/util/prng';

function sampleHeader(seed: number): FrameHeader {
  return {
    magic: HEADER_MAGIC,
    sessionId: seed >>> 0,
    fileLength: 100_000,
    K: 391,
    blockSize: 256,
    packetSeed: (seed ^ 0xffff) >>> 0,
    flags: 0,
  };
}

describe('frame geometry', () => {
  it('documents FAST_48K whole-symbol frame sizes', () => {
    const g = frameGeometry(FAST_48K);
    expect(g.nDataCarriers).toBe(683);
    expect(g.headerSymbols).toBe(2); // BPSK always
    expect(g.payloadMod).toBe('qpsk');
    expect(g.payloadSymbols).toBe(4);
    expect(g.symbolsPerFrame).toBe(6);
    expect(g.framesPerBurst).toBe(5); // floor(32/6)
    expect(g.payloadBytes).toBe(256);
  });

  it('documents QUIET_48K geometry', () => {
    const g = frameGeometry(QUIET_48K);
    expect(g.nDataCarriers).toBe(228);
    expect(g.headerSymbols).toBe(6);
    expect(g.payloadSymbols).toBe(10);
    expect(g.symbolsPerFrame).toBe(16);
    expect(g.framesPerBurst).toBe(2);
  });

  it('scales payload symbols with modulation', () => {
    const bpsk = frameGeometry({ ...FAST_48K, bitLoading: { uniform: 'bpsk' } });
    const qam = frameGeometry({ ...FAST_48K, bitLoading: { uniform: 'qam16' } });
    expect(bpsk.symbolsPerFrame).toBe(9); // 2+7
    expect(qam.symbolsPerFrame).toBe(4); // 2+2
  });
});

describe('frame encode/decode', () => {
  it('round-trips on clean LLRs', () => {
    const hdr = sampleHeader(7);
    const payload = new Uint8Array(256);
    for (let i = 0; i < 256; i++) payload[i] = i;
    const enc = encodeFrame(hdr, payload, FAST_48K);
    const llrs = new Float32Array(enc.bits.length);
    for (let i = 0; i < enc.bits.length; i++) llrs[i] = enc.bits[i]! ? 10 : -10;
    const { frame, stats } = decodeFrame(llrs, FAST_48K);
    expect(stats.headerOk).toBe(true);
    expect(stats.payloadOk).toBe(true);
    expect(frame!.header.packetSeed).toBe(hdr.packetSeed);
    expect(frame!.payload).toEqual(payload);
  });

  it('buildFrame/parseFrame agree on CRC', () => {
    const hdr = sampleHeader(3);
    const payload = new Uint8Array(256).fill(0xab);
    const bytes = buildFrame(hdr, payload);
    const parsed = parseFrame(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.payload).toEqual(payload);
  });

  it('header fails before payload when header LLRs are destroyed', () => {
    const hdr = sampleHeader(11);
    const payload = new Uint8Array(256).fill(1);
    const enc = encodeFrame(hdr, payload, FAST_48K);
    const llrs = new Float32Array(enc.bits.length);
    for (let i = 0; i < enc.bits.length; i++) llrs[i] = enc.bits[i]! ? 8 : -8;
    // Wipe header region.
    for (let i = 0; i < enc.geometry.headerCapacityBits; i++) llrs[i] = 0;
    const { stats } = decodeFrame(llrs, FAST_48K);
    expect(stats.headerOk).toBe(false);
    expect(stats.payloadOk).toBe(false);
  });

  it('survives moderate soft noise on the whole frame', () => {
    const rng = splitmix32(123);
    const hdr = sampleHeader(99);
    const payload = new Uint8Array(256);
    for (let i = 0; i < 256; i++) payload[i] = Math.floor(rng() * 256);
    const enc = encodeFrame(hdr, payload, FAST_48K);
    const llrs = new Float32Array(enc.bits.length);
    const sigma = 0.55; // fairly noisy but within rate-1/2 reach for BPSK/QPSK bits
    for (let i = 0; i < enc.bits.length; i++) {
      const [g] = gaussianPair(rng);
      const x = (enc.bits[i]! ? 1 : -1) + sigma * g;
      llrs[i] = (2 / (sigma * sigma)) * x;
    }
    const { frame, stats } = decodeFrame(llrs, FAST_48K);
    expect(stats.headerOk).toBe(true);
    expect(stats.payloadOk).toBe(true);
    expect(frame!.payload).toEqual(payload);
  });
});
