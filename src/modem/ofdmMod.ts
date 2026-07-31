/**
 * OFDM modulator — bits → one burst of time-domain samples.
 *
 * Burst layout (PLAN.md §1.4):
 *   [ chirp preamble | guard | T1 T2 training | D1 … Dm data symbols ]
 *
 * Each OFDM symbol:
 *   frequency domain: X[k] for active bins k (pilots at comb positions, data
 *   elsewhere); Hermitian symmetry X[N−k] = conj(X[k]) makes the IFFT real.
 *   time domain: N-sample IFFT output, prefixed by its last `cpLength` samples
 *   (cyclic prefix — makes room reverb a circular convolution within the CP).
 *
 * All symbols share one time-domain gain g chosen so the burst RMS ≈
 * txAmplitude·0.35 (≈ 9 dB PAPR headroom before digital full scale). The chirp
 * is scaled to the same RMS so the simulator's SNR definition (signal power
 * averaged over the waveform) treats preamble and payload alike.
 */

import type { ModemConfig, DerivedConfig, Modulation } from '../config';
import { derive, MOD_BITS } from '../config';
import { FFT } from '../dsp/fft';
import { buildChirp } from './sync';
import { pilotValues, trainingValues } from './pilots';
import { mapCarriers } from './mapping';
import { assert } from '../util/assert';

export interface ModulatorOptions {
  /** Override cfg.dataSymbolsPerBurst (long-transmission tests). */
  dataSymbols?: number;
  /**
   * Per-data-symbol modulation (length = dataSymbols). When set, every data
   * carrier in symbol s uses `symbolMods[s]` — used by Phase 5 for BPSK
   * headers + QPSK/16-QAM payloads inside the same burst.
   */
  symbolMods?: Modulation[];
}

export class OfdmModulator {
  readonly cfg: ModemConfig;
  readonly d: DerivedConfig;
  readonly dataSymbols: number;
  private readonly fft: FFT;
  private readonly pilotVals: Float32Array;
  private readonly trainVals: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly timeGain: number;
  /** Default per-carrier mods when symbolMods is not used. */
  private readonly carrierMods: Modulation[];
  /** Optional per-symbol override (uniform across carriers within the symbol). */
  private readonly symbolMods: Modulation[] | null;

  constructor(cfg: ModemConfig, opts: ModulatorOptions = {}) {
    this.cfg = cfg;
    this.d = derive(cfg);
    this.dataSymbols = opts.dataSymbols ?? cfg.dataSymbolsPerBurst;
    this.fft = new FFT(cfg.fftSize);
    this.pilotVals = pilotValues(cfg, this.d);
    this.trainVals = trainingValues(cfg, this.d);
    this.re = new Float32Array(cfg.fftSize);
    this.im = new Float32Array(cfg.fftSize);

    this.carrierMods = [];
    for (let i = 0; i < this.d.dataBins.length; i++) {
      if (Array.isArray(cfg.bitLoading)) {
        // bitLoading array is indexed by LOCAL active-carrier index.
        const local = this.d.dataBins[i]! - this.d.binLow;
        this.carrierMods.push(cfg.bitLoading[local]!);
      } else {
        this.carrierMods.push(cfg.bitLoading.uniform);
      }
    }

    if (opts.symbolMods) {
      assert(
        opts.symbolMods.length === this.dataSymbols,
        `symbolMods length ${opts.symbolMods.length} ≠ dataSymbols ${this.dataSymbols}`,
      );
      this.symbolMods = opts.symbolMods.slice();
    } else {
      this.symbolMods = null;
    }

    // Time gain: unit-power carriers → time RMS = sqrt(2·Σp)/N (Hermitian pair
    // doubles power). Target RMS = txAmplitude·0.35.
    let sumPower = this.d.dataBins.length; // data carriers at unit power
    const pilotAmp = Math.pow(10, cfg.pilotBoostDb / 20);
    sumPower += this.d.pilotBins.length * pilotAmp * pilotAmp;
    const naturalRms = Math.sqrt(2 * sumPower) / cfg.fftSize;
    this.timeGain = (cfg.txAmplitude * 0.35) / naturalRms;
  }

  /** Mods used for data symbol `s`. */
  modsForSymbol(s: number): Modulation[] {
    if (this.symbolMods) {
      const m = this.symbolMods[s]!;
      return this.d.dataBins.map(() => m);
    }
    return this.carrierMods;
  }

  /** Coded bits carried by one data symbol (symbol 0 if schedule varies). */
  get bitsPerSymbol(): number {
    return this.bitsPerDataSymbol(0);
  }

  bitsPerDataSymbol(s: number): number {
    const mods = this.modsForSymbol(s);
    let b = 0;
    for (const m of mods) b += MOD_BITS[m];
    return b;
  }

  /** Coded bits carried by one whole burst. */
  get bitsPerBurst(): number {
    let total = 0;
    for (let s = 0; s < this.dataSymbols; s++) total += this.bitsPerDataSymbol(s);
    return total;
  }

  /** Total burst length in samples. */
  get burstSamples(): number {
    const sym = this.cfg.fftSize + this.cfg.cpLength;
    return (
      this.cfg.chirpLengthSamples +
      this.cfg.chirpGuardSamples +
      (this.cfg.trainingSymbols + this.dataSymbols) * sym
    );
  }

  /**
   * Modulate `bits` (Uint8Array of 0/1, length = bitsPerBurst) into one burst.
   */
  modulateBurst(bits: Uint8Array): Float32Array {
    assert(bits.length >= this.bitsPerBurst, `need ${this.bitsPerBurst} bits`);
    const { cfg, d } = this;
    const N = cfg.fftSize;
    const cp = cfg.cpLength;
    const symLen = N + cp;
    const out = new Float32Array(this.burstSamples);

    // Chirp preamble at matched RMS.
    const chirp = buildChirp(cfg);
    let chirpRms = 0;
    for (let i = 0; i < chirp.length; i++) chirpRms += chirp[i]! * chirp[i]!;
    chirpRms = Math.sqrt(chirpRms / chirp.length);
    const chirpGain = (cfg.txAmplitude * 0.35) / chirpRms;
    for (let i = 0; i < chirp.length; i++) out[i] = chirp[i]! * chirpGain;

    let w = cfg.chirpLengthSamples + cfg.chirpGuardSamples;

    // Training symbols: every active bin = trainVals (BPSK ±1).
    for (let t = 0; t < cfg.trainingSymbols; t++) {
      this.clearSpectrum();
      for (let i = 0; i < d.nActive; i++) {
        this.setBin(d.binLow + i, this.trainVals[i]!, 0);
      }
      this.emitSymbol(out, w);
      w += symLen;
    }

    // Data symbols.
    const carRe = new Float32Array(d.dataBins.length);
    const carIm = new Float32Array(d.dataBins.length);
    let bitPos = 0;
    for (let s = 0; s < this.dataSymbols; s++) {
      this.clearSpectrum();
      // Pilots.
      for (let p = 0; p < d.pilotBins.length; p++) {
        this.setBin(d.pilotBins[p]!, this.pilotVals[p]!, 0);
      }
      // Data carriers (may be mixed modulations under bit-loading / symbolMods).
      const mods = this.modsForSymbol(s);
      let c = 0;
      while (c < d.dataBins.length) {
        // Group consecutive carriers with the same modulation for mapCarriers.
        const mod = mods[c]!;
        let end = c + 1;
        while (end < d.dataBins.length && mods[end] === mod) end++;
        bitPos += mapCarriers(bits, bitPos, mod, end - c, carRe, carIm, c);
        c = end;
      }
      for (let i = 0; i < d.dataBins.length; i++) {
        this.setBin(d.dataBins[i]!, carRe[i]!, carIm[i]!);
      }
      this.emitSymbol(out, w);
      w += symLen;
    }
    return out;
  }

  private clearSpectrum(): void {
    this.re.fill(0);
    this.im.fill(0);
  }

  /** Set bin k and its Hermitian mirror (real time-domain signal). */
  private setBin(k: number, re: number, im: number): void {
    const N = this.cfg.fftSize;
    this.re[k] = re;
    this.im[k] = im;
    this.re[N - k] = re;
    this.im[N - k] = -im;
  }

  /** IFFT current spectrum, apply gain, write CP + body at out[w…]. */
  private emitSymbol(out: Float32Array, w: number): void {
    const N = this.cfg.fftSize;
    const cp = this.cfg.cpLength;
    this.fft.inverse(this.re, this.im);
    // re[] now holds the real time-domain symbol (im ≈ 0; the IFFT's 1/N is
    // part of naturalRms in the constructor). inverse() destroys the spectrum —
    // clearSpectrum() rebuilds it for the next symbol.
    const g = this.timeGain;
    for (let i = 0; i < cp; i++) out[w + i] = this.re[N - cp + i]! * g;
    for (let i = 0; i < N; i++) out[w + cp + i] = this.re[i]! * g;
  }
}
