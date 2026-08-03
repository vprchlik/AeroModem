/**
 * Pilot-based per-symbol tracking.
 *
 * After equalizing pilots against the training-time channel estimate, the
 * residual rotation of pilot p at absolute bin k_p follows
 *
 *   φ_p ≈ θ + α·k_p
 *     θ : common phase error (CPE — residual carrier/frequency offset)
 *     α : phase slope = −2πΔ/N, Δ = accumulated timing error in samples
 *
 * and the residual magnitude ratio g tracks slow gain wander (browser AGC).
 * A weighted least-squares line fit over the pilots gives (θ, α); the caller
 * de-rotates all carriers by θ + αk and divides by g, and slips the FFT window
 * by ±1 sample when |Δ| crosses 0.5 (keeping φ small and unwrap-free forever).
 */

import type { ModemConfig, DerivedConfig } from '../config';
import { pilotValues } from './pilots';

export interface TrackingUpdate {
  /** Common phase error (radians). */
  theta: number;
  /** Phase slope per bin (radians/bin). */
  alpha: number;
  /** Accumulated timing error implied by alpha: Δ = −α·N/2π (samples). */
  timingErrSamples: number;
  /** Amplitude wander estimate (linear; 1 = no change since training). */
  gain: number;
}

export class PilotTracker {
  private readonly pilotBins: number[];
  private readonly pilotVals: Float32Array;
  private readonly hRe: Float32Array;
  private readonly hIm: Float32Array;
  private readonly N: number;
  private readonly binLow: number;

  constructor(
    cfg: ModemConfig,
    d: DerivedConfig,
    hRe: Float32Array,
    hIm: Float32Array,
  ) {
    this.pilotBins = d.pilotBins;
    this.pilotVals = pilotValues(cfg, d);
    this.hRe = hRe;
    this.hIm = hIm;
    this.N = cfg.fftSize;
    this.binLow = d.binLow;
  }

  /**
   * `symRe/symIm`: FFT output of one data symbol, ACTIVE bins only.
   * Pilot i lives at active index pilotBins[i] − binLow.
   */
  update(symRe: Float32Array, symIm: Float32Array): TrackingUpdate {
    let sw = 0;
    let swk = 0;
    let swkk = 0;
    let swp = 0;
    let swkp = 0;
    let gainNum = 0;
    let gainDen = 0;

    for (let p = 0; p < this.pilotBins.length; p++) {
      const k = this.pilotBins[p]!;
      const i = k - this.binLow;
      const hr = this.hRe[i]!;
      const hi = this.hIm[i]!;
      const hMag2 = hr * hr + hi * hi;
      if (hMag2 < 1e-12) continue; // dead carrier — no information
      // r = Y / (Ĥ · X): X = ±amp real ⇒ divide by (hr,hi) then by X.
      const yr = symRe[i]!;
      const yi = symIm[i]!;
      // Y · conj(H) / |H|²
      let rr = (yr * hr + yi * hi) / hMag2;
      let ri = (yi * hr - yr * hi) / hMag2;
      const x = this.pilotVals[p]!;
      rr /= x;
      ri /= x;
      const phi = Math.atan2(ri, rr);
      const mag = Math.hypot(rr, ri);
      const w = hMag2; // strong carriers dominate the fit
      sw += w;
      swk += w * k;
      swkk += w * k * k;
      swp += w * phi;
      swkp += w * k * phi;
      gainNum += w * mag;
      gainDen += w;
    }

    if (sw === 0) {
      return { theta: 0, alpha: 0, timingErrSamples: 0, gain: 1 };
    }
    const denom = sw * swkk - swk * swk;
    const alpha = denom !== 0 ? (sw * swkp - swk * swp) / denom : 0;
    const theta = (swp - alpha * swk) / sw;
    const timingErrSamples = (-alpha * this.N) / (2 * Math.PI);
    const gain = gainDen > 0 ? gainNum / gainDen : 1;
    return { theta, alpha, timingErrSamples, gain };
  }
}
