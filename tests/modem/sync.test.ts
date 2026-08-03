import { describe, expect, it } from 'vitest';
import { FAST_48K, QUIET_48K } from '../../src/config';
import { simulateChannel, CHANNEL_PRESETS } from '../../src/channel/simulator';
import {
  buildChirp,
  buildTemplate,
  detectPreamble,
  PreambleDetector,
} from '../../src/modem/sync';
import { designBandpassFir, filterAligned } from '../../src/dsp/filters';
import { splitmix32, gaussianPair } from '../../src/util/prng';

const FS = 48000;

/**
 * One full sync trial with ALL impairments enabled simultaneously:
 * random start offset [0, 48000] (applied pre-channel so ground truth is known),
 * +50 ppm drift, AGC wander, nonlinearity, phone speaker, RIR preset, in-band AWGN.
 * Returns |timing error| in samples, or null if not detected within ±64.
 */
function trial(
  cfg: typeof FAST_48K,
  preset: 'small-room' | 'living-room' | 'hallway',
  snrDb: number,
  seed: number,
): number | null {
  const rng = splitmix32(seed ^ 0x5eed);
  const offset = Math.floor(rng() * 48001);
  const chirp = buildChirp(cfg);
  const tx = new Float32Array(offset + chirp.length + 9600);
  for (let i = 0; i < chirp.length; i++) tx[offset + i] = 0.8 * chirp[i]!;

  const rx = simulateChannel(tx, {
    seed,
    sampleRate: FS,
    nonlinearity: {},
    bandLimit: { speakerModel: 'phone' },
    rir: preset,
    clockDriftPpm: 50,
    agcWander: true,
    snrDb,
    snrBandHz: [cfg.bandLowHz, cfg.bandHighHz],
  });

  const truth = offset / (1 + 50e-6);
  const dets = detectPreamble(rx, cfg);
  let best = null;
  for (const d of dets) if (!best || d.corr > best.corr) best = d;
  if (!best) return null;
  const err = Math.abs(best.sampleIndex + best.fracOffset - truth);
  return err < 64 ? err : null;
}

function runBatch(
  cfg: typeof FAST_48K,
  preset: 'small-room' | 'living-room' | 'hallway',
  snrDb: number,
  runs: number,
): { rate: number; median: number; p95: number } {
  const errs: number[] = [];
  let ok = 0;
  for (let r = 0; r < runs; r++) {
    const err = trial(cfg, preset, snrDb, (r + 1) * 7919 + Math.round((snrDb + 100) * 131));
    if (err !== null) {
      ok++;
      errs.push(err);
    }
  }
  errs.sort((a, b) => a - b);
  const q = (p: number) =>
    errs.length ? errs[Math.min(errs.length - 1, Math.floor((p / 100) * errs.length))]! : NaN;
  return { rate: ok / runs, median: q(50), p95: q(95) };
}

/**
 * Operating points chosen from the measured curves (scripts/sync-sweep.ts,
 * 200 runs/point — see PROGRESS.md Phase 3):
 *   - small-room & living-room: 100% detection down to −10 dB; breakdown
 *     (<99%) at −12.5 dB. Operating point −7.5 dB = breakdown + 5 dB margin.
 *   - hallway: 90.5% at −10 dB (breakdown between −10 and −7.5); operating
 *     point −5 dB = ~5 dB above the last fully-clean point (−7.5 dB).
 * Timing thresholds: measured P95 was 0.17–0.19 samples at these points; the
 * asserted bounds (median ≤ 0.5, P95 ≤ 2) leave ~10× seed-variation headroom
 * and sit far inside the ≤ 8-sample budget Phase 4 needs. Hallway did NOT
 * smear timing: with DRR = 0 dB the direct path is still the strongest
 * coherent component, so the peak stays sharp.
 */
describe('sync regression at measured operating points (all impairments on)', () => {
  const RUNS = 100;

  it('small-room @ −7.5 dB in-band', { timeout: 240_000 }, () => {
    const { rate, median, p95 } = runBatch(FAST_48K, 'small-room', -7.5, RUNS);
    expect(rate).toBeGreaterThanOrEqual(0.99);
    expect(median).toBeLessThanOrEqual(0.5);
    expect(p95).toBeLessThanOrEqual(2);
  });

  it('living-room @ −7.5 dB in-band', { timeout: 240_000 }, () => {
    const { rate, median, p95 } = runBatch(FAST_48K, 'living-room', -7.5, RUNS);
    expect(rate).toBeGreaterThanOrEqual(0.99);
    expect(median).toBeLessThanOrEqual(0.5);
    expect(p95).toBeLessThanOrEqual(2);
  });

  it('hallway @ −5 dB in-band', { timeout: 240_000 }, () => {
    const { rate, median, p95 } = runBatch(FAST_48K, 'hallway', -5, RUNS);
    expect(rate).toBeGreaterThanOrEqual(0.99);
    expect(median).toBeLessThanOrEqual(0.5);
    expect(p95).toBeLessThanOrEqual(2);
  });
});

describe('false alarms', () => {
  it('60 s of noise + music-like bursts produces 0 detections', { timeout: 120_000 }, () => {
    const n = 60 * FS;
    const rng = splitmix32(2026);
    const x = new Float32Array(n);
    // Base noise floor.
    for (let i = 0; i < n; i += 2) {
      const [g1, g2] = gaussianPair(rng);
      x[i] = 0.02 * g1;
      if (i + 1 < n) x[i + 1] = 0.02 * g2;
    }
    // Music-like: band-limited bursts with varying center frequency and envelope.
    const burst = new Float32Array(FS / 2);
    for (let b = 0; b < 40; b++) {
      const f0 = 300 + rng() * 8000;
      const bw = 200 + rng() * 2000;
      const h = designBandpassFir(201, f0, Math.min(f0 + bw, 23000), FS);
      for (let i = 0; i < burst.length; i += 2) {
        const [g1, g2] = gaussianPair(rng);
        burst[i] = g1;
        if (i + 1 < burst.length) burst[i + 1] = g2;
      }
      const shaped = filterAligned(burst, h);
      const start = Math.floor(rng() * (n - shaped.length));
      const amp = 0.1 + 0.4 * rng();
      for (let i = 0; i < shaped.length; i++) {
        // Attack/decay envelope like a struck note.
        const env = Math.exp(-i / (FS * 0.15));
        x[start + i] = x[start + i]! + amp * env * shaped[i]!;
      }
    }
    const det = new PreambleDetector(FAST_48K);
    const out = det.push(x);
    out.push(...det.flush());
    expect(out).toEqual([]);
  });
});

/**
 * Documented failure point: worst-case-quiet.
 *
 * Measured curve (100 runs/point, scripts + PROGRESS.md): 0 dB → 100%,
 * −3 dB → 96%, −6 dB → 74%, −9 dB → 43%, −12 dB → 3%. Sync does NOT fail at
 * the preset's 0 dB — the 85 ms chirp has ≈27 dB of correlation gain over the
 * 6 kHz quiet band. Breakdown starts just below −3 dB.
 *
 * Both sides are pinned: if the −9 dB rate rises far above 43%, the channel
 * got optimistic (or sync dramatically better) — investigate either way.
 */
describe('documented failure point: worst-case-quiet', () => {
  function worstCaseRate(snrDb: number, runs: number): number {
    const cfg = QUIET_48K;
    const chirp = buildChirp(cfg);
    let correct = 0;
    for (let r = 0; r < runs; r++) {
      const seed = 50000 + r;
      const rng = splitmix32(seed ^ 0x5eed);
      const offset = Math.floor(rng() * 48001);
      const tx = new Float32Array(offset + chirp.length + 9600);
      for (let i = 0; i < chirp.length; i++) tx[offset + i] = 0.8 * chirp[i]!;
      // Offset is applied above (for known ground truth), so drop the preset's own.
      const { startOffsetSamples: _drop, ...preset } = CHANNEL_PRESETS['worst-case-quiet']!;
      const rx = simulateChannel(tx, { seed, sampleRate: FS, ...preset, snrDb });
      const truth = offset / (1 + 50e-6);
      for (const d of detectPreamble(rx, cfg)) {
        if (Math.abs(d.sampleIndex + d.fracOffset - truth) < 64) {
          correct++;
          break;
        }
      }
    }
    return correct / runs;
  }

  it('still syncs at the preset 0 dB point', { timeout: 240_000 }, () => {
    expect(worstCaseRate(0, 50)).toBeGreaterThanOrEqual(0.95);
  });

  it('fails at −9 dB (pinned failure, guards channel optimism)', { timeout: 240_000 }, () => {
    const rate = worstCaseRate(-9, 50);
    expect(rate).toBeLessThan(0.7);
    expect(rate).toBeGreaterThan(0.15);
  });
});

describe('detector unit behavior', () => {
  it('detects a clean chirp at the exact sample with corr ≈ 1', () => {
    const cfg = FAST_48K;
    const chirp = buildChirp(cfg);
    const off = 12345;
    const tx = new Float32Array(off + chirp.length + 4800);
    for (let i = 0; i < chirp.length; i++) tx[off + i] = 0.8 * chirp[i]!;
    const dets = detectPreamble(tx, cfg, { channelMatched: false });
    expect(dets).toHaveLength(1);
    expect(dets[0]!.sampleIndex).toBe(off);
    expect(dets[0]!.corr).toBeGreaterThan(0.99);
  });

  it('streaming chunk size does not change the result', () => {
    const cfg = FAST_48K;
    const chirp = buildChirp(cfg);
    const off = 30000;
    const tx = new Float32Array(off + chirp.length + 4800);
    for (let i = 0; i < chirp.length; i++) tx[off + i] = 0.8 * chirp[i]!;

    const whole = detectPreamble(tx, cfg);
    const det = new PreambleDetector(cfg);
    const chunked = [];
    for (let i = 0; i < tx.length; i += 128) {
      chunked.push(...det.push(tx.subarray(i, Math.min(i + 128, tx.length))));
    }
    chunked.push(...det.flush());
    expect(chunked.map((d) => d.sampleIndex)).toEqual(whole.map((d) => d.sampleIndex));
  });

  it('templates are unit energy', () => {
    for (const matched of [false, true]) {
      const t = buildTemplate(FAST_48K, matched);
      let e = 0;
      for (const v of t) e += v * v;
      expect(e).toBeCloseTo(1, 4);
    }
  });
});
