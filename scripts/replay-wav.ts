/**
 * Replay a real-hardware RX capture (WAV from the app's "Save capture" button)
 * through the StreamingReceiver — the sim-first bridge for hardware failures.
 *
 * Run: npx tsx scripts/replay-wav.ts <capture.wav> [fast|robust|quiet] [--analyze]
 *
 * Prints the same counters the app shows (bursts, frames ok/header-fail/
 * payload-fail, packets), so a failing live run becomes a deterministic
 * offline reproduction.
 *
 * --analyze additionally compares TRAINING-symbol SNR against DATA-symbol EVM
 * per frequency group. The two-training-symbol noise estimate (chanest.ts)
 * cancels any signal-correlated distortion — both training symbols get
 * distorted identically, so their difference hides it — while data symbols
 * expose it. A large train-vs-data gap therefore fingerprints TX-side
 * nonlinearity (e.g. phone speaker-protection limiters), which is invisible
 * to the receiver's CSI weighting. Measured 2026-08-04, iPhone 15 Pro Max
 * Safari TX at high volume: training said 17–24 dB, data EVM implied 4–11 dB,
 * plus a brick wall above ~14.5 kHz — 0/90 frames despite green SNR bars.
 */

import { readFileSync } from 'node:fs';
import { derive, FAST_48K, QUIET_48K, ROBUST_48K, type ModemConfig } from '../src/config';
import { StreamingReceiver } from '../src/link/stream';
import { PreambleDetector } from '../src/modem/sync';
import { OfdmDemodulator } from '../src/modem/ofdmDemod';
import { burstSymbolMods, frameGeometry } from '../src/code/geometry';

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

const args = process.argv.slice(2).filter((a) => a !== '--analyze');
const analyze = process.argv.includes('--analyze');
const [wavPath, modeName = 'robust'] = args;
if (!wavPath) {
  console.error(
    'Usage: npx tsx scripts/replay-wav.ts <capture.wav> [fast|robust|quiet] [--analyze]',
  );
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

// ------------------------------------------------- --analyze deep dive ---

if (analyze) {
  const dv = derive(cfg);
  const geom = frameGeometry(cfg);
  const symbolMods = burstSymbolMods(cfg, geom);
  const detector = new PreambleDetector(cfg);
  const demod = new OfdmDemodulator(cfg, { symbolMods });
  const burstSamples =
    cfg.chirpLengthSamples +
    cfg.chirpGuardSamples +
    (cfg.trainingSymbols + cfg.dataSymbolsPerBurst) * (cfg.fftSize + cfg.cpLength);

  // NOTE: assumes device rate == modem rate (the common capture case). For
  // mismatched rates run the counters replay above; the group table would need
  // a resampling pass first.
  if (sampleRate !== cfg.sampleRate) {
    console.log(`\n--analyze skipped: capture is ${sampleRate} Hz but modem is ${cfg.sampleRate} Hz`);
    process.exit(0);
  }

  const nCar = dv.dataBins.length;
  const G = 16;
  const per = Math.ceil(nCar / G);
  const evmSum = new Float64Array(G);
  const evmN = new Float64Array(G);
  const trainSnrSum = new Float64Array(G);
  const trainSnrN = new Float64Array(G);

  let used = 0;
  for (const det of detector.push(samples)) {
    const start = Math.floor(det.sampleIndex);
    if (start + burstSamples + 1024 > samples.length) break;
    const x = samples.slice(start, start + burstSamples + 1024);
    try {
      const res = demod.demodBurst(x, det.sampleIndex - start + det.fracOffset);
      for (let s = 0; s < res.eqRe.length; s++) {
        const re = res.eqRe[s]!;
        const im = res.eqIm[s]!;
        if (re.length !== nCar) continue;
        for (let i = 0; i < nCar; i++) {
          if (res.est.snrLin[i]! <= 10) continue; // dead carriers: EVM meaningless
          const gi = Math.min(G - 1, Math.floor(i / per));
          // BPSK reference (±1, 0); for QPSK modes this is a coarse proxy.
          const dr = Math.abs(re[i]!) - 1;
          evmSum[gi] += dr * dr + im[i]! * im[i]!;
          evmN[gi]++;
        }
      }
      for (let i = 0; i < nCar; i++) {
        const gi = Math.min(G - 1, Math.floor(i / per));
        trainSnrSum[gi] += 10 * Math.log10(Math.max(res.est.snrLin[i]!, 1e-6));
        trainSnrN[gi]++;
      }
      used++;
    } catch {
      /* malformed burst — skip */
    }
  }

  console.log(`\n--analyze over ${used} bursts (good carriers = train SNR > 10 dB):`);
  console.log('group  centerHz  trainSNRdB  dataEVM  impliedDataSNRdB');
  for (let gi = 0; gi < G; gi++) {
    const hz = ((dv.dataBins[Math.min(gi * per, nCar - 1)] ?? dv.binHigh) * cfg.sampleRate) / cfg.fftSize;
    const tSnr = trainSnrN[gi]! > 0 ? (trainSnrSum[gi]! / trainSnrN[gi]!).toFixed(1) : '—';
    if (evmN[gi]! > 0) {
      const mse = evmSum[gi]! / evmN[gi]!;
      console.log(
        `${String(gi).padStart(3)}  ${(hz / 1000).toFixed(1).padStart(7)}k  ${tSnr.padStart(9)}  ` +
          `${Math.sqrt(mse).toFixed(3).padStart(7)}  ${(10 * Math.log10(1 / mse)).toFixed(1).padStart(10)}`,
      );
    } else {
      console.log(
        `${String(gi).padStart(3)}  ${(hz / 1000).toFixed(1).padStart(7)}k  ${tSnr.padStart(9)}  (no good carriers)`,
      );
    }
  }
  console.log(
    '\nInterpretation: trainSNR ≫ impliedDataSNR on the same carriers = signal-' +
      'correlated TX distortion (limiter/clipping) invisible to the training-based ' +
      'noise estimate; uniformly low trainSNR in a band = spectral kill (speaker/OS filter).',
  );
}
