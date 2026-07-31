/**
 * Preamble synchronization — chirp matched filtering with a channel-matched
 * template.
 *
 * The receiver correlates incoming audio against the TX chirp AFTER passing it
 * through the nominal phone transducer response (see PLAN.md Phase 3): with the
 * realistic speaker model, the top octave of the sweep arrives 15–30 dB down,
 * and correlating against the raw chirp lets the low band dominate the peak.
 * The matched template restores peak sharpness at zero TX cost. TX pre-emphasis
 * was rejected (cannot boost +28 dB within digital full scale) and PHAT
 * whitening was rejected (amplifies noise in dead bands at low SNR).
 *
 * Detection pipeline (streaming, overlap-save):
 *   1. numerator  num[n] = Σ_i x[n+i]·t[i]        (FFT cross-correlation)
 *   2. denominator = ||t|| · sqrt(E[n]),  E[n] = Σ_{i<T} x[n+i]²  (prefix sums)
 *   3. c[n] = num/den ∈ [−1, 1]  — a true correlation coefficient
 *   4. local maxima of c above `threshold`, refractory window T, quadratic
 *      sub-sample interpolation.
 *
 * `sampleIndex` is the CHIRP START in the detector's absolute input clock.
 */

import type { ModemConfig } from '../config';
import { FFT } from '../dsp/fft';
import { linearChirp } from '../dsp/chirp';
import { filterAligned } from '../dsp/filters';
import { phoneTransducerFir } from '../channel/simulator';

export interface Detection {
  /** Start of the chirp, in absolute samples since the detector was created. */
  sampleIndex: number;
  /** Sub-sample refinement from quadratic peak interpolation, in (−0.5, 0.5). */
  fracOffset: number;
  /** Normalized correlation coefficient at the peak (0…1). */
  corr: number;
}

export interface SyncOptions {
  /**
   * Correlate against the chirp filtered through the nominal phone transducer
   * (default true — see header). False = raw-chirp correlator (for A/B tests).
   */
  channelMatched?: boolean;
  /** Detection threshold on the normalized correlation coefficient. */
  threshold?: number;
}

/** The TX preamble waveform for a config (what the sender actually plays). */
export function buildChirp(cfg: ModemConfig): Float32Array {
  return linearChirp(cfg.sampleRate, cfg.bandLowHz, cfg.bandHighHz, cfg.chirpLengthSamples);
}

/** The receiver's correlation template (unit energy). */
export function buildTemplate(cfg: ModemConfig, channelMatched: boolean): Float32Array {
  let t = buildChirp(cfg);
  if (channelMatched) {
    t = filterAligned(t, phoneTransducerFir(cfg.sampleRate));
  }
  let e = 0;
  for (let i = 0; i < t.length; i++) e += t[i]! * t[i]!;
  const g = 1 / Math.sqrt(e);
  for (let i = 0; i < t.length; i++) t[i]! *= g;
  return t;
}

export class PreambleDetector {
  private readonly T: number; // template length
  private readonly N: number; // FFT block size
  private readonly hop: number; // new samples consumed per block = N − T + 1
  private readonly fft: FFT;
  /** Conjugated template spectrum (template time-reversed → correlation). */
  private readonly tmplRe: Float32Array;
  private readonly tmplIm: Float32Array;
  private readonly threshold: number;

  /** Rolling input: previous T−1 samples + up to `hop` new ones. */
  private readonly window: Float32Array;
  private filled: number; // valid samples in `window`
  private absBase = 0; // absolute index of window[0]

  /** Deferred peak across block boundaries (a peak near an edge may continue). */
  private pending: { index: number; frac: number; corr: number } | null = null;
  private lastEmittedIndex = -Infinity;

  private readonly scratchRe: Float32Array;
  private readonly scratchIm: Float32Array;
  private readonly corr: Float32Array;
  /** Largest T-window energy seen so far — floors the denominator so digital
   *  silence after a burst cannot produce 0/0 correlation spikes. */
  private maxEnergy = 0;

  constructor(cfg: ModemConfig, opts: SyncOptions = {}) {
    const template = buildTemplate(cfg, opts.channelMatched ?? true);
    this.T = template.length;
    this.N = 1 << Math.ceil(Math.log2(this.T * 4));
    this.hop = this.N - this.T + 1;
    this.threshold = opts.threshold ?? 0.3;
    this.fft = new FFT(this.N);

    // Precompute FFT of the time-reversed template (correlation = convolution
    // with reversed kernel).
    this.tmplRe = new Float32Array(this.N);
    this.tmplIm = new Float32Array(this.N);
    for (let i = 0; i < this.T; i++) this.tmplRe[i] = template[this.T - 1 - i]!;
    this.fft.forward(this.tmplRe, this.tmplIm);

    this.window = new Float32Array(this.N);
    this.filled = this.T - 1; // leading zeros stand in for "before time 0"
    this.absBase = -(this.T - 1);

    this.scratchRe = new Float32Array(this.N);
    this.scratchIm = new Float32Array(this.N);
    this.corr = new Float32Array(this.N);
  }

  /** Feed capture samples; returns any completed detections. */
  push(chunk: Float32Array): Detection[] {
    const out: Detection[] = [];
    let off = 0;
    while (off < chunk.length) {
      const space = this.N - this.filled;
      const n = Math.min(space, chunk.length - off);
      this.window.set(chunk.subarray(off, off + n), this.filled);
      this.filled += n;
      off += n;
      if (this.filled === this.N) {
        this.processBlock(out);
        // Slide: keep last T−1 samples for overlap.
        this.window.copyWithin(0, this.hop);
        this.absBase += this.hop;
        this.filled = this.T - 1;
      }
    }
    return out;
  }

  /** Flush trailing samples (end of stream): process the final partial block. */
  flush(): Detection[] {
    const out: Detection[] = [];
    if (this.filled > this.T - 1) {
      this.window.fill(0, this.filled);
      this.processBlock(out);
      this.filled = this.T - 1;
    }
    if (this.pending) {
      out.push(this.emit(this.pending));
      this.pending = null;
    }
    return out;
  }

  private emit(p: { index: number; frac: number; corr: number }): Detection {
    this.lastEmittedIndex = p.index;
    return { sampleIndex: p.index, fracOffset: p.frac, corr: p.corr };
  }

  private processBlock(out: Detection[]): void {
    const { N, T, hop } = this;
    const re = this.scratchRe;
    const im = this.scratchIm;
    re.set(this.window);
    im.fill(0);
    this.fft.forward(re, im);
    for (let k = 0; k < N; k++) {
      const ar = re[k]!;
      const ai = im[k]!;
      const br = this.tmplRe[k]!;
      const bi = this.tmplIm[k]!;
      re[k] = ar * br - ai * bi;
      im[k] = ar * bi + ai * br;
    }
    this.fft.inverse(re, im);
    // Linear correlation outputs: num[n] = Σ x[n+i] t[i] lands at re[n + T − 1]
    // for n = 0 … hop−1 (n indexes into `window`).

    // Signal energy over each T-window via prefix sums (Float64 for stability).
    // E[n] = Σ_{i=0}^{T−1} window[n+i]².
    const c = this.corr;
    let energy = 0;
    for (let i = 0; i < T; i++) energy += this.window[i]! * this.window[i]!;
    for (let n = 0; n < hop; n++) {
      if (energy > this.maxEnergy) this.maxEnergy = energy;
      // Floor at −30 dB below the loudest window seen: windows of near-silence
      // (e.g. after a burst ends) must not divide by ~0 and fake a correlation.
      const floor = Math.max(1e-3 * this.maxEnergy, 1e-12);
      const den = Math.sqrt(Math.max(energy, floor));
      c[n] = re[n + T - 1]! / den;
      // Slide energy window.
      if (n + 1 < hop) {
        const drop = this.window[n]!;
        const add = this.window[n + T]!;
        energy += add * add - drop * drop;
      }
    }

    // Peak picking with refractory window T.
    for (let n = 1; n < hop - 1; n++) {
      const v = c[n]!;
      if (v < this.threshold) continue;
      if (!(v >= c[n - 1]! && v >= c[n + 1]!)) continue;
      // `n` is where the template END aligns… no: with our indexing, c[n] is
      // maximal when the chirp STARTS at window[n]. Absolute chirp start:
      const abs = this.absBase + n;
      if (abs - this.lastEmittedIndex < T && this.pending === null) {
        // Within refractory of an already-emitted stronger peak — skip.
        continue;
      }
      // Quadratic sub-sample interpolation around the peak.
      const a = c[n - 1]!;
      const b = v;
      const d = c[n + 1]!;
      const denom = a - 2 * b + d;
      const frac = denom === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (a - d)) / denom));

      if (this.pending && abs - this.pending.index < T) {
        if (v > this.pending.corr) this.pending = { index: abs, frac, corr: v };
      } else {
        if (this.pending) out.push(this.emit(this.pending));
        this.pending = { index: abs, frac, corr: v };
      }
    }
    // Emit pending peak once the refractory window has safely passed.
    if (this.pending && this.absBase + hop - this.pending.index >= T) {
      out.push(this.emit(this.pending));
      this.pending = null;
    }
  }
}

/** Offline convenience: run the streaming detector over a whole buffer. */
export function detectPreamble(
  x: Float32Array,
  cfg: ModemConfig,
  opts: SyncOptions = {},
): Detection[] {
  const det = new PreambleDetector(cfg, opts);
  const out = det.push(x);
  out.push(...det.flush());
  return out;
}
