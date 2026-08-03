/**
 * Phase 3 sync sweep — detection rate and timing error vs in-band SNR,
 * per RIR preset, with ALL impairments enabled simultaneously:
 * random start offset [0, 48000], +50 ppm drift, AGC wander, nonlinearity,
 * phone speaker model. Reproducible via fixed seeds.
 *
 * Run: npx tsx scripts/sync-sweep.ts [runsPerPoint]
 * Writes artifacts/sync-sweep.csv and prints a summary table.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { FAST_48K, QUIET_48K } from '../src/config';
import { simulateChannel, CHANNEL_PRESETS } from '../src/channel/simulator';
import { buildChirp, detectPreamble } from '../src/modem/sync';
import { splitmix32 } from '../src/util/prng';

const FS = 48000;
const RUNS = Number(process.argv[2] ?? 200);
const SNRS = [-12.5, -10, -7.5, -5, -2.5, 0, 2.5, 5, 10, 20];
const PRESETS = ['small-room', 'living-room', 'hallway'] as const;

interface RunResult {
  detected: boolean;
  timingErr: number | null; // samples, detected − truth
}

function runOnce(
  preset: (typeof PRESETS)[number] | null,
  snrDb: number,
  seed: number,
  channelMatched: boolean,
): RunResult {
  const cfg = FAST_48K;
  const rng = splitmix32(seed ^ 0x5eed);
  const offset = Math.floor(rng() * 48001);
  const chirp = buildChirp(cfg);

  // TX signal: silence(offset) + chirp + 0.2 s trailing silence.
  const tail = 9600;
  const tx = new Float32Array(offset + chirp.length + tail);
  for (let i = 0; i < chirp.length; i++) tx[offset + i] = 0.8 * chirp[i]!;

  const driftPpm = 50;
  const rx = simulateChannel(tx, {
    seed,
    sampleRate: FS,
    nonlinearity: {},
    bandLimit: { speakerModel: 'phone' },
    ...(preset ? { rir: preset } : {}),
    clockDriftPpm: driftPpm,
    agcWander: true,
    snrDb,
    snrBandHz: [cfg.bandLowHz, cfg.bandHighHz],
  });

  // Ground truth: drift rescales positions by 1/ratio.
  const truth = offset / (1 + driftPpm * 1e-6);

  const dets = detectPreamble(rx, cfg, { channelMatched });
  if (dets.length === 0) return { detected: false, timingErr: null };
  // Take the strongest detection.
  let best = dets[0]!;
  for (const d of dets) if (d.corr > best.corr) best = d;
  return { detected: true, timingErr: best.sampleIndex + best.fracOffset - truth };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function sweep(channelMatched: boolean): string[] {
  const rows: string[] = [];
  for (const preset of PRESETS) {
    console.log(`\n== preset ${preset} (matched=${channelMatched}) ==`);
    console.log('SNR(dB)  detect%   median|err|  p95|err|  maxCorr(med)');
    for (const snr of SNRS) {
      let detected = 0;
      const errs: number[] = [];
      for (let r = 0; r < RUNS; r++) {
        const seed = (r + 1) * 7919 + Math.round((snr + 100) * 131);
        const res = runOnce(preset, snr, seed, channelMatched);
        if (res.detected && res.timingErr !== null) {
          detected++;
          errs.push(Math.abs(res.timingErr));
        }
      }
      errs.sort((a, b) => a - b);
      const rate = detected / RUNS;
      const med = percentile(errs, 50);
      const p95 = percentile(errs, 95);
      console.log(
        `${snr.toString().padStart(6)}  ${(100 * rate).toFixed(1).padStart(7)}  ` +
          `${med.toFixed(2).padStart(11)}  ${p95.toFixed(2).padStart(8)}`,
      );
      rows.push(
        `${channelMatched},${preset},${snr},${RUNS},${rate.toFixed(4)},${med.toFixed(3)},${p95.toFixed(3)}`,
      );
    }
  }
  return rows;
}

function worstCaseQuiet(): void {
  console.log('\n== worst-case-quiet (quiet-band chirp, all impairments, 0 dB) ==');
  const cfg = QUIET_48K;
  let detected = 0;
  const runs = Math.min(RUNS, 100);
  for (let r = 0; r < runs; r++) {
    const seed = 40000 + r;
    const rng = splitmix32(seed ^ 0x5eed);
    const offset = Math.floor(rng() * 4801);
    const chirp = buildChirp(cfg);
    const tx = new Float32Array(offset + chirp.length + 9600);
    for (let i = 0; i < chirp.length; i++) tx[offset + i] = 0.8 * chirp[i]!;
    // Offset applied above for known ground truth; drop the preset's own.
    const { startOffsetSamples: _drop, ...preset } = CHANNEL_PRESETS['worst-case-quiet']!;
    const rx = simulateChannel(tx, { seed, sampleRate: FS, ...preset });
    const dets = detectPreamble(rx, cfg, { channelMatched: true });
    const truth = offset / (1 + 50e-6);
    for (const d of dets) {
      if (Math.abs(d.sampleIndex + d.fracOffset - truth) < 64) {
        detected++;
        break;
      }
    }
  }
  console.log(`correct detections: ${detected}/${runs} (${((100 * detected) / runs).toFixed(1)}%)`);
}

const t0 = Date.now();
const rows = [
  'channelMatched,preset,snrDb,runs,detectionRate,medianAbsErr,p95AbsErr',
  ...sweep(true),
];
// Raw-template comparison at a single informative SNR set (smaller sweep).
worstCaseQuiet();
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/sync-sweep.csv', rows.join('\n') + '\n');
console.log(`\nWrote artifacts/sync-sweep.csv in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
