/**
 * Synthetic room impulse responses (RIRs) for the channel simulator.
 *
 * Model (time domain, h[n], fs samples/s):
 *   - Direct path: unit impulse at n = 0.
 *   - Early reflections: `earlyCount` discrete taps at seeded delays within
 *     [earlyMinMs, earlyMaxMs], amplitudes decaying with delay.
 *   - Late tail: Gaussian noise shaped by exp(−t/τa), where the amplitude
 *     time constant τa = RT60 / ln(1000) ≈ RT60 / 6.91 (−60 dB at RT60).
 *   - The whole reflected part (early + tail) is scaled so that
 *     DRR = direct power / reflected power matches the preset (dB).
 *
 * RIR length = 0.5·RT60 (amplitude −30 dB, power −60 dB at truncation:
 * negligible energy beyond).
 */

import { splitmix32, gaussianPair } from '../util/prng';
import { assert } from '../util/assert';

export interface RirSpec {
  /** Reverberation time: amplitude −60 dB after this many seconds. */
  rt60Sec: number;
  /** Direct-to-reverberant ratio in dB (direct power / all reflected power). */
  drrDb: number;
  /** Early reflection window (ms after direct). */
  earlyMinMs: number;
  earlyMaxMs: number;
  earlyCount: number;
  /** Expected RMS delay-spread range (ms) — asserted by tests. */
  expectedDelaySpreadMs: [number, number];
}

export const RIR_SPECS: Record<string, RirSpec> = {
  'small-room': {
    rt60Sec: 0.25,
    drrDb: 6,
    earlyMinMs: 2,
    earlyMaxMs: 8,
    earlyCount: 4,
    expectedDelaySpreadMs: [3, 20],
  },
  'living-room': {
    rt60Sec: 0.45,
    drrDb: 3,
    earlyMinMs: 3,
    earlyMaxMs: 12,
    earlyCount: 6,
    expectedDelaySpreadMs: [12, 45],
  },
  hallway: {
    rt60Sec: 0.7,
    drrDb: 0,
    earlyMinMs: 4,
    earlyMaxMs: 18,
    earlyCount: 8,
    expectedDelaySpreadMs: [25, 90],
  },
};

export type RirPreset = keyof typeof RIR_SPECS;

export function makeRir(preset: string, seed: number, sampleRate: number): Float32Array {
  const spec = RIR_SPECS[preset];
  assert(spec, `unknown RIR preset '${preset}'`);
  const rng = splitmix32(seed);

  const len = Math.max(64, Math.round(0.5 * spec.rt60Sec * sampleRate));
  const h = new Float32Array(len);

  // Direct path.
  h[0] = 1;

  // Reflected part built separately, then power-scaled to hit DRR.
  const refl = new Float32Array(len);

  // Early reflections: discrete taps, amplitude shrinking with delay,
  // random sign (wall phase inversions).
  for (let i = 0; i < spec.earlyCount; i++) {
    const delayMs = spec.earlyMinMs + rng() * (spec.earlyMaxMs - spec.earlyMinMs);
    const idx = Math.min(len - 1, Math.round((delayMs / 1000) * sampleRate));
    const amp =
      (0.5 + 0.3 * rng()) * Math.exp(-delayMs / spec.earlyMaxMs) * (rng() < 0.5 ? -1 : 1);
    refl[idx] = refl[idx]! + amp;
  }

  // Late tail: enveloped Gaussian noise starting after 1 ms.
  const tauA = spec.rt60Sec / Math.log(1000); // amplitude time constant (s)
  const start = Math.round(0.001 * sampleRate);
  for (let n = start; n < len; n += 2) {
    const [g1, g2] = gaussianPair(rng);
    const t1 = n / sampleRate;
    refl[n] = refl[n]! + g1 * Math.exp(-t1 / tauA) * 0.25;
    if (n + 1 < len) {
      const t2 = (n + 1) / sampleRate;
      refl[n + 1] = refl[n + 1]! + g2 * Math.exp(-t2 / tauA) * 0.25;
    }
  }

  // Scale reflected part: DRR = Pd / Pr → Pr = Pd / drrLin. Direct power Pd = 1.
  let pr = 0;
  for (let n = 0; n < len; n++) pr += refl[n]! * refl[n]!;
  const target = 1 / Math.pow(10, spec.drrDb / 10);
  const scale = pr > 0 ? Math.sqrt(target / pr) : 0;
  for (let n = 1; n < len; n++) h[n] = refl[n]! * scale;
  // Reflection energy that landed on n=0 would corrupt the direct tap; keep h[0]=1.

  return h;
}

/**
 * Measured RT60 via Schroeder backward integration.
 * EDC(n) = 10·log10( Σ_{m≥n} h²[m] / Σ h² ). A straight-line fit over the
 * EDC range [−10, −25] dB (inside the exponential tail, away from the direct
 * tap and the truncation cliff) gives the decay rate; RT60 = time to −60 dB.
 */
export function rirRt60Ms(h: Float32Array, sampleRate: number): number {
  const n = h.length;
  const edc = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += h[i]! * h[i]!;
    edc[i] = acc;
  }
  const total = edc[0]!;
  // Collect (time, dB) points inside the fit window.
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const db = 10 * Math.log10(edc[i]! / total);
    if (db <= -10 && db >= -25) {
      const t = i / sampleRate;
      sx += t;
      sy += db;
      sxx += t * t;
      sxy += t * db;
      count++;
    }
  }
  assert(count > 10, 'rirRt60Ms: not enough EDC points in fit window');
  const slope = (count * sxy - sx * sy) / (count * sxx - sx * sx); // dB per second
  return (-60 / slope) * 1000;
}

/** Fraction of total RIR energy arriving later than `cpSamples` (ISI energy). */
export function energyBeyondCp(h: Float32Array, cpSamples: number): number {
  let total = 0;
  let late = 0;
  for (let i = 0; i < h.length; i++) {
    const p = h[i]! * h[i]!;
    total += p;
    if (i >= cpSamples) late += p;
  }
  return late / total;
}

/** Statistics of an impulse response, for tests and the bench. */
export function rirStats(
  h: Float32Array,
  sampleRate: number,
  directWindowMs = 1,
): { drrDb: number; rmsDelaySpreadMs: number } {
  const dw = Math.max(1, Math.round((directWindowMs / 1000) * sampleRate));
  let pd = 0;
  let pr = 0;
  for (let n = 0; n < h.length; n++) {
    const p = h[n]! * h[n]!;
    if (n < dw) pd += p;
    else pr += p;
  }
  const drrDb = 10 * Math.log10(pd / Math.max(pr, 1e-30));

  // RMS delay spread: sqrt(E[t²] − E[t]²) with weights h²(t).
  let sumP = 0;
  let sumT = 0;
  let sumT2 = 0;
  for (let n = 0; n < h.length; n++) {
    const p = h[n]! * h[n]!;
    const t = (n / sampleRate) * 1000; // ms
    sumP += p;
    sumT += p * t;
    sumT2 += p * t * t;
  }
  const meanT = sumT / sumP;
  const rmsDelaySpreadMs = Math.sqrt(Math.max(0, sumT2 / sumP - meanT * meanT));
  return { drrDb, rmsDelaySpreadMs };
}
