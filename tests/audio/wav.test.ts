import { describe, expect, it } from 'vitest';
import { CaptureRecorder, encodeWavPcm16 } from '../../src/audio/wav';

function ascii(bytes: Uint8Array, offset: number, len: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + len));
}

describe('encodeWavPcm16', () => {
  it('writes a valid 44-byte RIFF/WAVE header for mono 16-bit PCM', () => {
    const wav = encodeWavPcm16(new Float32Array([0, 0.5, -0.5, 1]), 48000);
    const view = new DataView(wav.buffer);

    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(ascii(wav, 36, 4)).toBe('data');
    expect(wav.length).toBe(44 + 4 * 2);
    expect(view.getUint32(4, true)).toBe(36 + 8); // RIFF size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(96000); // byte rate
    expect(view.getUint16(34, true)).toBe(16); // bit depth
    expect(view.getUint32(40, true)).toBe(8); // data bytes
  });

  it('quantizes and clamps samples to int16 little-endian', () => {
    const wav = encodeWavPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]), 8000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32767);
    expect(view.getInt16(50, true)).toBe(32767); // clamped
    expect(view.getInt16(52, true)).toBe(-32767); // clamped
    expect(view.getInt16(54, true)).toBe(Math.round(0.5 * 32767));
  });

  it('round-trips a sine within int16 quantization error', () => {
    const n = 480;
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) src[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    const wav = encodeWavPcm16(src, 48000);
    const view = new DataView(wav.buffer);
    for (let i = 0; i < n; i++) {
      const decoded = view.getInt16(44 + 2 * i, true) / 32767;
      expect(Math.abs(decoded - src[i]!)).toBeLessThan(1 / 32767 + 1e-6);
    }
  });
});

describe('CaptureRecorder', () => {
  it('accumulates chunks and reports duration', () => {
    const rec = new CaptureRecorder(48000, 10);
    rec.push(new Float32Array(48000)); // 1 s
    rec.push(new Float32Array(24000)); // 0.5 s
    expect(rec.seconds).toBeCloseTo(1.5, 6);
    const wav = rec.toWav();
    expect(wav.length).toBe(44 + (48000 + 24000) * 2);
  });

  it('drops oldest chunks beyond the retention window', () => {
    const rec = new CaptureRecorder(1000, 2); // keep 2000 samples
    const a = new Float32Array(1500).fill(0.25);
    const b = new Float32Array(1500).fill(-0.25);
    rec.push(a);
    rec.push(b); // 3000 total > 2000 → drop a
    expect(rec.seconds).toBeCloseTo(1.5, 6);
    const wav = rec.toWav();
    const view = new DataView(wav.buffer);
    // Everything retained is chunk b (−0.25).
    expect(view.getInt16(44, true)).toBe(Math.round(-0.25 * 32767));
  });
});
