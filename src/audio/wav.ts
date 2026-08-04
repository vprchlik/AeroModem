/**
 * Minimal mono 16-bit PCM WAV encoder — for the RX capture recorder.
 * Pure function (no Web Audio / DOM) so the header layout is unit-testable.
 *
 * Purpose: hardware failures must be reproduced in the simulator before any
 * modem change; recording exactly what the demodulator saw (post mic-gain,
 * device rate) turns a flaky live session into a deterministic test input.
 */

/** Encode mono float samples (−1…1, clamped) as a 16-bit PCM WAV file. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const headerBytes = 44;
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(headerBytes + dataBytes);
  const view = new DataView(out.buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(x * 32767), true);
  }
  return out;
}

/**
 * Bounded recorder: keeps the most recent `maxSeconds` of pushed chunks
 * (drops the oldest whole chunks first) so a long listen can't exhaust memory.
 */
export class CaptureRecorder {
  private chunks: Float32Array[] = [];
  private totalSamples = 0;
  private readonly maxSamples: number;

  constructor(
    readonly sampleRate: number,
    maxSeconds = 120,
  ) {
    this.maxSamples = Math.round(maxSeconds * sampleRate);
  }

  push(chunk: Float32Array): void {
    this.chunks.push(chunk.slice());
    this.totalSamples += chunk.length;
    while (this.totalSamples > this.maxSamples && this.chunks.length > 1) {
      this.totalSamples -= this.chunks.shift()!.length;
    }
  }

  get seconds(): number {
    return this.totalSamples / this.sampleRate;
  }

  /** Concatenate everything retained and encode as WAV. */
  toWav(): Uint8Array {
    const all = new Float32Array(this.totalSamples);
    let off = 0;
    for (const c of this.chunks) {
      all.set(c, off);
      off += c.length;
    }
    return encodeWavPcm16(all, this.sampleRate);
  }
}
