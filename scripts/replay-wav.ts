/**
 * Replay a real-hardware RX capture (WAV from the app's "Save capture" button)
 * through the StreamingReceiver — the sim-first bridge for hardware failures.
 *
 * Run: npx tsx scripts/replay-wav.ts <capture.wav> [fast|robust|quiet]
 *
 * Prints the same counters the app shows (bursts, frames ok/header-fail/
 * payload-fail, packets) plus per-burst sync details, so a failing live run
 * becomes a deterministic offline reproduction.
 */

import { readFileSync } from 'node:fs';
import { FAST_48K, QUIET_48K, ROBUST_48K, type ModemConfig } from '../src/config';
import { StreamingReceiver } from '../src/link/stream';

function parseWavMono(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (off: number, len: number) =>
    String.fromCharCode(...bytes.subarray(off, off + len));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }

  // Walk chunks: fmt then data (the app writes canonical 44-byte headers, but
  // accept any chunk order/padding so external recordings also replay).
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let data: Uint8Array | null = null;
  while (off + 8 <= bytes.length) {
    const id = ascii(off, 4);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      const format = view.getUint16(body, true);
      if (format !== 1) throw new Error(`Only PCM supported (fmt=${format})`);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      data = bytes.subarray(body, body + size);
    }
    off = body + size + (size & 1);
  }
  if (!data || !sampleRate) throw new Error('Missing fmt/data chunk');
  if (bitsPerSample !== 16) throw new Error(`Only 16-bit PCM supported (got ${bitsPerSample})`);

  const frames = Math.floor(data.length / 2 / channels);
  const samples = new Float32Array(frames);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < frames; i++) {
    // Average channels down to mono.
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += dv.getInt16((i * channels + c) * 2, true);
    samples[i] = acc / channels / 32767;
  }
  return { samples, sampleRate };
}

const MODES: Record<string, ModemConfig> = {
  fast: FAST_48K,
  robust: ROBUST_48K,
  quiet: QUIET_48K,
};

const [, , wavPath, modeName = 'robust'] = process.argv;
if (!wavPath) {
  console.error('Usage: npx tsx scripts/replay-wav.ts <capture.wav> [fast|robust|quiet]');
  process.exit(1);
}
const cfg = MODES[modeName];
if (!cfg) {
  console.error(`Unknown mode "${modeName}" — use fast|robust|quiet`);
  process.exit(1);
}

const { samples, sampleRate } = parseWavMono(new Uint8Array(readFileSync(wavPath)));
console.log(
  `${wavPath}: ${samples.length} samples @ ${sampleRate} Hz ` +
    `(${(samples.length / sampleRate).toFixed(1)} s), mode=${modeName}`,
);

let peak = 0;
for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
console.log(`peak |x| = ${(100 * peak).toFixed(1)}%`);

const rx = new StreamingReceiver(cfg, { deviceSampleRate: sampleRate });
let completed: Uint8Array | null = null;
rx.onComplete((f) => {
  completed = f;
});

// Feed in app-sized chunks so streaming behavior matches the browser.
const CHUNK = 2048;
for (let off = 0; off < samples.length; off += CHUNK) {
  rx.push(samples.subarray(off, Math.min(off + CHUNK, samples.length)));
}

const d = rx.diagnostics;
const p = d.progress;
console.log(
  `bursts: ${d.burstsDetected} detected / ${d.burstsDemodulated} demodulated · ` +
    `frames: ${p.framesOk} ok / ${p.framesHeaderFail} header-fail / ` +
    `${p.framesPayloadFail} payload-fail · packets ${p.packetsAccepted}` +
    (p.K ? ` / K=${p.K}` : '') +
    ` · drift ${d.lastCorrectedPpm.toFixed(1)} ppm`,
);
if (d.lastSnrDb) {
  const snr = Array.from(d.lastSnrDb);
  const sorted = [...snr].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)]!;
  console.log(
    `per-carrier SNR: median ${med.toFixed(1)} dB, ` +
      `min ${sorted[0]!.toFixed(1)}, max ${sorted[sorted.length - 1]!.toFixed(1)}`,
  );
}
console.log(completed ? `✓ file completed: ${(completed as Uint8Array).length} bytes` : 'file NOT completed');
