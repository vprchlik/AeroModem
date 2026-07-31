/**
 * OFDM demodulator — received samples → equalized carriers → soft bits.
 *
 * Offline burst API (streaming wrapper arrives with the Phase 6 app): the
 * caller locates the burst with PreambleDetector and hands us the buffer plus
 * the detected chirp start.
 *
 * Pipeline per burst:
 *   1. FFT windows: symbol s nominally starts at
 *        base + s·(N+cp), window = start + cp − backoff + slip
 *      `backoff` (samples inside the CP) tolerates small timing error and the
 *      speaker FIR's pre-ring; the constant phase ramp it introduces is
 *      absorbed into the training-based channel estimate (same window rule).
 *   2. Training symbols → LS channel estimate + noise variance + initial
 *      drift-per-symbol (chanest.ts).
 *   3. Per data symbol: pilots → (θ, α, gain) (tracking.ts); de-rotate all
 *      carriers by θ+αk, divide by gain, equalize by Ĥ, demap to CSI-weighted
 *      LLRs. When the implied timing error |Δ| > 0.5 sample, slip subsequent
 *      windows by ±1 sample (the tracker's job is to keep Δ small forever).
 */

import type { ModemConfig, DerivedConfig, Modulation } from '../config';
import { derive, MOD_BITS } from '../config';
import { FFT } from '../dsp/fft';
import { resampleFractional } from '../dsp/resample';
import { estimateChannel, type ChannelEstimate } from './chanest';
import { PilotTracker } from './tracking';
import { trainingValues } from './pilots';
import { demapCarriers } from './mapping';
import { assert } from '../util/assert';

export interface DemodOptions {
  dataSymbols?: number;
  /** FFT window backoff into the CP (samples). */
  cpBackoff?: number;
  /**
   * Two-pass sample-clock drift correction (default true). Window slipping
   * alone fixes inter-SYMBOL timing but not within-symbol ICI: at +50 ppm the
   * top carrier sits 1 Hz off its bin (4.3% of the spacing), adding ≈ −23 dB
   * of self-noise — enough to bother 16-QAM. Pass A measures the slip rate
   * from pilots over the first ~24 symbols; if significant, the whole buffer
   * is resampled by 1/(1+ε̂) and demodulated again.
   */
  driftCorrection?: boolean;
}

export interface SymbolDiagnostics {
  theta: number;
  timingErrSamples: number; // residual after slips (should stay < ~0.6)
  gain: number;
  /** Decision-directed EVM is left to callers with known TX; this is RMS
   *  pilot residual as a cheap online quality signal. */
  pilotRmsError: number;
}

export interface BurstResult {
  /** CSI-weighted max-log LLRs for all data symbols, concatenated. */
  llrs: Float32Array;
  /** Equalized data-carrier points per symbol (for constellation/EVM). */
  eqRe: Float32Array[];
  eqIm: Float32Array[];
  /** Channel estimate from training. */
  est: ChannelEstimate;
  perSymbol: SymbolDiagnostics[];
  /** Total integer window slips applied across the burst (drift make-up). */
  totalSlips: number;
  /** Drift rate corrected by the two-pass resampler (ppm; 0 = no correction). */
  correctedPpm: number;
}

export class OfdmDemodulator {
  readonly cfg: ModemConfig;
  readonly d: DerivedConfig;
  readonly dataSymbols: number;
  private readonly cpBackoff: number;
  private readonly fft: FFT;
  private readonly train: Float32Array;
  private readonly mods: Modulation[];

  private readonly driftCorrection: boolean;

  constructor(cfg: ModemConfig, opts: DemodOptions = {}) {
    this.cfg = cfg;
    this.d = derive(cfg);
    this.dataSymbols = opts.dataSymbols ?? cfg.dataSymbolsPerBurst;
    this.cpBackoff = opts.cpBackoff ?? 96;
    this.driftCorrection = opts.driftCorrection ?? true;
    this.fft = new FFT(cfg.fftSize);
    this.train = trainingValues(cfg, this.d);
    this.mods = [];
    for (let i = 0; i < this.d.dataBins.length; i++) {
      if (Array.isArray(cfg.bitLoading)) {
        const local = this.d.dataBins[i]! - this.d.binLow;
        this.mods.push(cfg.bitLoading[local]!);
      } else {
        this.mods.push(cfg.bitLoading.uniform);
      }
    }
  }

  get llrsPerSymbol(): number {
    let b = 0;
    for (const m of this.mods) b += MOD_BITS[m];
    return b;
  }

  /** FFT one window at absolute position `at`, extract active bins. */
  private fftWindow(
    x: Float32Array,
    at: number,
    outRe: Float32Array,
    outIm: Float32Array,
    scratchRe: Float32Array,
    scratchIm: Float32Array,
  ): void {
    const N = this.cfg.fftSize;
    assert(at >= 0 && at + N <= x.length, `FFT window [${at}, ${at + N}) out of range`);
    scratchRe.set(x.subarray(at, at + N));
    scratchIm.fill(0);
    this.fft.forward(scratchRe, scratchIm);
    for (let i = 0; i < this.d.nActive; i++) {
      const k = this.d.binLow + i;
      outRe[i] = scratchRe[k]!;
      outIm[i] = scratchIm[k]!;
    }
  }

  /**
   * Measure the timing-slip rate (samples/symbol) from pilots over the first
   * `probeSymbols` data symbols — least-squares slope of accumulated timing
   * error vs symbol index. Robust against per-symbol estimate noise.
   */
  private measureDriftRate(x: Float32Array, chirpStart: number, probeSymbols: number): number {
    const { cfg, d } = this;
    const N = cfg.fftSize;
    const cp = cfg.cpLength;
    const symLen = N + cp;
    const base = Math.round(chirpStart) + cfg.chirpLengthSamples + cfg.chirpGuardSamples;

    const scratchRe = new Float32Array(N);
    const scratchIm = new Float32Array(N);
    const t1Re = new Float32Array(d.nActive);
    const t1Im = new Float32Array(d.nActive);
    const t2Re = new Float32Array(d.nActive);
    const t2Im = new Float32Array(d.nActive);
    const winOf = (symIdx: number, slip: number) =>
      base + symIdx * symLen + cp - this.cpBackoff + slip;

    this.fftWindow(x, winOf(0, 0), t1Re, t1Im, scratchRe, scratchIm);
    this.fftWindow(x, winOf(1, 0), t2Re, t2Im, scratchRe, scratchIm);
    const est = estimateChannel(cfg, d, t1Re, t1Im, t2Re, t2Im, this.train);
    const tracker = new PilotTracker(cfg, d, est.hRe, est.hIm);

    const symRe = new Float32Array(d.nActive);
    const symIm = new Float32Array(d.nActive);
    let slip = 0;
    // Least-squares slope of A_s = slip + residual vs s.
    let sw = 0;
    let sws = 0;
    let swss = 0;
    let swa = 0;
    let swsa = 0;
    for (let s = 0; s < probeSymbols; s++) {
      const symIdx = cfg.trainingSymbols + s;
      this.fftWindow(x, winOf(symIdx, slip), symRe, symIm, scratchRe, scratchIm);
      const upd = tracker.update(symRe, symIm);
      const total = slip + upd.timingErrSamples;
      sw += 1;
      sws += s;
      swss += s * s;
      swa += total;
      swsa += s * total;
      if (Math.abs(upd.timingErrSamples) > 0.5) slip += Math.round(upd.timingErrSamples);
    }
    const denom = sw * swss - sws * sws;
    return denom !== 0 ? (sw * swsa - sws * swa) / denom : 0;
  }

  /**
   * Demodulate one burst. `chirpStart` = detected chirp start (absolute index
   * into x, may include fractional part from Detection.fracOffset — the
   * integer part is used; sub-sample residue is absorbed by training).
   */
  demodBurst(x: Float32Array, chirpStart: number): BurstResult {
    if (this.driftCorrection) {
      const probe = Math.min(24, this.dataSymbols);
      if (probe >= 6) {
        const symLen = this.cfg.fftSize + this.cfg.cpLength;
        const rate = this.measureDriftRate(x, chirpStart, probe);
        // rate = d(arrival error)/d(symbol) = symLen·(1/r − 1) ⇒ ε̂ = r−1.
        const inv = 1 + rate / symLen; // = 1/r̂
        const epsHat = 1 / inv - 1;
        if (Math.abs(epsHat) > 4e-6) {
          // Undo the clock scaling: corrected[m] = x(m / r̂) via ratio 1/r̂.
          const corrected = resampleFractional(x, inv);
          const newStart = chirpStart * (1 + epsHat);
          const res = this.demodCore(corrected, newStart);
          res.correctedPpm = epsHat * 1e6;
          return res;
        }
      }
    }
    return this.demodCore(x, chirpStart);
  }

  private demodCore(x: Float32Array, chirpStart: number): BurstResult {
    const { cfg, d } = this;
    const N = cfg.fftSize;
    const cp = cfg.cpLength;
    const symLen = N + cp;
    const base = Math.round(chirpStart) + cfg.chirpLengthSamples + cfg.chirpGuardSamples;

    const scratchRe = new Float32Array(N);
    const scratchIm = new Float32Array(N);
    const t1Re = new Float32Array(d.nActive);
    const t1Im = new Float32Array(d.nActive);
    const t2Re = new Float32Array(d.nActive);
    const t2Im = new Float32Array(d.nActive);

    const winOf = (symIdx: number, slip: number) =>
      base + symIdx * symLen + cp - this.cpBackoff + slip;

    this.fftWindow(x, winOf(0, 0), t1Re, t1Im, scratchRe, scratchIm);
    this.fftWindow(x, winOf(1, 0), t2Re, t2Im, scratchRe, scratchIm);
    const est = estimateChannel(cfg, d, t1Re, t1Im, t2Re, t2Im, this.train);

    const tracker = new PilotTracker(cfg, d, est.hRe, est.hIm);
    const nData = d.dataBins.length;
    const llrs = new Float32Array(this.llrsPerSymbol * this.dataSymbols);
    const eqRe: Float32Array[] = [];
    const eqIm: Float32Array[] = [];
    const perSymbol: SymbolDiagnostics[] = [];

    const symRe = new Float32Array(d.nActive);
    const symIm = new Float32Array(d.nActive);
    const csi = new Float32Array(nData);
    // CSI weight per data carrier: |Ĥ|²/σ² (constant over the burst; the
    // per-symbol gain wander is small and folded into equalization).
    for (let i = 0; i < nData; i++) {
      const a = d.dataBins[i]! - d.binLow;
      const h2 = est.hRe[a]! * est.hRe[a]! + est.hIm[a]! * est.hIm[a]!;
      csi[i] = h2 / est.noiseVar;
    }

    let slip = 0; // integer window adjustment accumulated so far
    let llrPos = 0;

    for (let s = 0; s < this.dataSymbols; s++) {
      const symIdx = cfg.trainingSymbols + s;
      this.fftWindow(x, winOf(symIdx, slip), symRe, symIm, scratchRe, scratchIm);

      const upd = tracker.update(symRe, symIm);
      // Residual timing beyond what slips already absorb; slip more if needed.
      if (Math.abs(upd.timingErrSamples) > 0.5) {
        // Positive Δ = signal arriving later than window ⇒ move window later.
        slip += Math.round(upd.timingErrSamples);
      }

      // Correct all active bins: de-rotate by θ + αk, normalize gain wander.
      const invGain = upd.gain > 1e-6 ? 1 / upd.gain : 1;
      const re = new Float32Array(nData);
      const im = new Float32Array(nData);
      let pilotErr = 0;
      let pilotCount = 0;
      for (let i = 0; i < nData; i++) {
        const a = d.dataBins[i]! - d.binLow;
        const k = d.dataBins[i]!;
        const ang = -(upd.theta + upd.alpha * k);
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        const yr = (symRe[a]! * c - symIm[a]! * sn) * invGain;
        const yi = (symRe[a]! * sn + symIm[a]! * c) * invGain;
        // One-tap equalizer: Z = Y/Ĥ (CP makes the room a per-bin multiply).
        const hr = est.hRe[a]!;
        const hi = est.hIm[a]!;
        const h2 = hr * hr + hi * hi;
        if (h2 > 1e-12) {
          re[i] = (yr * hr + yi * hi) / h2;
          im[i] = (yi * hr - yr * hi) / h2;
        } else {
          re[i] = 0;
          im[i] = 0;
        }
      }
      // Pilot residual RMS (diagnostic): re-run pilots through the correction.
      for (const kp of d.pilotBins) {
        const a = kp - d.binLow;
        const hr = est.hRe[a]!;
        const hi = est.hIm[a]!;
        const h2 = hr * hr + hi * hi;
        if (h2 < 1e-12) continue;
        const ang = -(upd.theta + upd.alpha * kp);
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        const yr = (symRe[a]! * c - symIm[a]! * sn) * invGain;
        const yi = (symRe[a]! * sn + symIm[a]! * c) * invGain;
        const zr = (yr * hr + yi * hi) / h2;
        const zi = (yi * hr - yr * hi) / h2;
        // Expected pilot value: ±pilotAmp — compare magnitude of error to it.
        pilotErr += (Math.abs(zr) - Math.pow(10, cfg.pilotBoostDb / 20)) ** 2 + zi * zi;
        pilotCount++;
      }

      // Demap contiguous same-modulation runs with per-carrier CSI weights.
      let c0 = 0;
      while (c0 < nData) {
        const mod = this.mods[c0]!;
        let end = c0 + 1;
        while (end < nData && this.mods[end] === mod) end++;
        llrPos += demapCarriers(
          re,
          im,
          c0,
          mod,
          end - c0,
          csi.subarray(c0, end),
          llrs,
          llrPos,
        );
        c0 = end;
      }

      eqRe.push(re);
      eqIm.push(im);
      perSymbol.push({
        theta: upd.theta,
        timingErrSamples: upd.timingErrSamples,
        gain: upd.gain,
        pilotRmsError: pilotCount ? Math.sqrt(pilotErr / pilotCount) : 0,
      });
    }

    return { llrs, eqRe, eqIm, est, perSymbol, totalSlips: slip, correctedPpm: 0 };
  }
}
