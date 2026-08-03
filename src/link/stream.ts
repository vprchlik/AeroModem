/**
 * Streaming link layer — pure (no Web Audio / DOM), fully testable in Node.
 *
 * StreamingSender: file → per-burst device-rate waveforms.
 * StreamingReceiver: device-rate capture chunks → detections → demod → file.
 *
 * Sample-rate handling: the modem ALWAYS runs at cfg.sampleRate (48 kHz by
 * default). When the device runs at a different rate (44.1 kHz is common,
 * especially iOS), waveforms are fractionally resampled at the boundary:
 * TX 48k → device rate, RX device rate → 48k. An unhandled mismatch would
 * present as a constant ~8.8% "drift" that no tracker can absorb.
 */

import type { ModemConfig, Modulation } from '../config';
import { resampleFractional, StreamResampler } from '../dsp/resample';
import { OfdmModulator } from '../modem/ofdmMod';
import { OfdmDemodulator } from '../modem/ofdmDemod';
import { PreambleDetector, type Detection } from '../modem/sync';
import { FileSender } from './sender';
import { FileReceiver, type ReceiveProgress } from './receiver';
import { assert } from '../util/assert';

// ---------------------------------------------------------------- sender ---

export interface StreamingSenderOptions {
  /** Actual device sample rate; defaults to cfg.sampleRate (no resample). */
  deviceSampleRate?: number;
  interleave?: boolean;
}

export class StreamingSender {
  readonly cfg: ModemConfig;
  readonly deviceSampleRate: number;
  private readonly sender: FileSender;
  private readonly mod: OfdmModulator;

  constructor(
    file: Uint8Array,
    cfg: ModemConfig,
    sessionSeed: number,
    opts: StreamingSenderOptions = {},
  ) {
    this.cfg = cfg;
    this.deviceSampleRate = opts.deviceSampleRate ?? cfg.sampleRate;
    this.sender = new FileSender(
      file,
      cfg,
      sessionSeed,
      opts.interleave === undefined ? {} : { interleave: opts.interleave },
    );
    this.mod = new OfdmModulator(cfg, { symbolMods: this.sender.symbolMods });
  }

  get packetsSent(): number {
    return this.sender.packetsSent;
  }

  get K(): number {
    return this.sender.K;
  }

  /** Burst duration in seconds of real time (device rate). */
  get burstSeconds(): number {
    return this.mod.burstSamples / this.cfg.sampleRate;
  }

  get symbolMods(): Modulation[] {
    return this.sender.symbolMods;
  }

  /** Next burst waveform at the DEVICE sample rate. */
  nextBurstSamples(): Float32Array {
    const bits = this.sender.nextBurstBits();
    const wave48 = this.mod.modulateBurst(bits);
    if (this.deviceSampleRate === this.cfg.sampleRate) return wave48;
    // y[n] = x(n · fsModem/fsDevice): same absolute-time waveform at fsDevice.
    return resampleFractional(wave48, this.cfg.sampleRate / this.deviceSampleRate);
  }
}

// -------------------------------------------------------------- receiver ---

export interface StreamingReceiverOptions {
  deviceSampleRate?: number;
  interleave?: boolean;
  /** Detection threshold override (forwarded to PreambleDetector). */
  threshold?: number;
}

export interface RxDiagnostics {
  deviceSampleRate: number;
  modemSampleRate: number;
  /** Fraction of recent capture samples at |x| ≥ 0.985 (clipping indicator). */
  clipFraction: number;
  /** Peak |x| over the most recent capture window. */
  recentPeak: number;
  burstsDetected: number;
  burstsDemodulated: number;
  /** Per-active-carrier SNR (dB) from the last burst's channel estimate. */
  lastSnrDb: Float32Array | null;
  /** Equalized constellation points from the last demodulated burst (subsampled). */
  lastConstellation: { re: Float32Array; im: Float32Array } | null;
  /** Sample-clock drift corrected on the last burst (ppm). */
  lastCorrectedPpm: number;
  progress: ReceiveProgress;
  /** 0/1 per source block. */
  blockBitmap: Uint8Array;
}

const CLIP_LEVEL = 0.985;
const CLIP_WINDOW_SEC = 1.0;

export class StreamingReceiver {
  readonly cfg: ModemConfig;
  readonly deviceSampleRate: number;
  private readonly resampler: StreamResampler | null;
  private readonly detector: PreambleDetector;
  private readonly demod: OfdmDemodulator;
  private readonly rx: FileReceiver;
  private readonly burstSamples: number;
  private readonly postSlack = 1024;

  /** Rolling 48k-domain buffer. absBase = absolute index of buf[0]. */
  private buf = new Float32Array(0);
  private absBase = 0;
  private pending: Detection[] = [];

  /** Clip stats over a rolling window of device samples. */
  private clipWindow: number[] = [];
  private clipCounts: number[] = [];
  private clipTotal = 0;
  private clipSamples = 0;
  private peak = 0;

  private burstsDetected = 0;
  private burstsDemodulated = 0;
  private lastSnrDb: Float32Array | null = null;
  private lastConstellation: { re: Float32Array; im: Float32Array } | null = null;
  private lastCorrectedPpm = 0;

  constructor(cfg: ModemConfig, opts: StreamingReceiverOptions = {}) {
    this.cfg = cfg;
    this.deviceSampleRate = opts.deviceSampleRate ?? cfg.sampleRate;
    this.resampler =
      this.deviceSampleRate === cfg.sampleRate
        ? null
        : new StreamResampler(this.deviceSampleRate / cfg.sampleRate);
    this.detector = new PreambleDetector(
      cfg,
      opts.threshold !== undefined ? { threshold: opts.threshold } : {},
    );
    this.rx = new FileReceiver(
      cfg,
      opts.interleave === undefined ? {} : { interleave: opts.interleave },
    );
    this.demod = new OfdmDemodulator(cfg, { symbolMods: this.rx.symbolMods });
    const d = cfg.fftSize + cfg.cpLength;
    this.burstSamples =
      cfg.chirpLengthSamples +
      cfg.chirpGuardSamples +
      (cfg.trainingSymbols + cfg.dataSymbolsPerBurst) * d;
  }

  onComplete(cb: (file: Uint8Array) => void): void {
    this.rx.onComplete(cb);
  }

  get progress(): ReceiveProgress {
    return this.rx.progress;
  }

  result(): Uint8Array | null {
    return this.rx.result();
  }

  get diagnostics(): RxDiagnostics {
    return {
      deviceSampleRate: this.deviceSampleRate,
      modemSampleRate: this.cfg.sampleRate,
      clipFraction: this.clipSamples > 0 ? this.clipTotal / this.clipSamples : 0,
      recentPeak: this.peak,
      burstsDetected: this.burstsDetected,
      burstsDemodulated: this.burstsDemodulated,
      lastSnrDb: this.lastSnrDb,
      lastConstellation: this.lastConstellation,
      lastCorrectedPpm: this.lastCorrectedPpm,
      progress: this.rx.progress,
      blockBitmap: this.rx.blockBitmap(),
    };
  }

  /** Feed device-rate capture samples (any chunk size). */
  push(deviceChunk: Float32Array): void {
    this.trackClipping(deviceChunk);
    const chunk48 = this.resampler ? this.resampler.push(deviceChunk) : deviceChunk;
    if (chunk48.length === 0) return;

    // Append to the rolling buffer.
    const merged = new Float32Array(this.buf.length + chunk48.length);
    merged.set(this.buf);
    merged.set(chunk48, this.buf.length);
    this.buf = merged;

    // Detections come with absolute 48k-domain indices.
    for (const det of this.detector.push(chunk48)) {
      this.pending.push(det);
      this.burstsDetected++;
    }

    this.drainPending();
    this.trimBuffer();
  }

  private trackClipping(chunk: Float32Array): void {
    let clipped = 0;
    let localPeak = 0;
    for (let i = 0; i < chunk.length; i++) {
      const a = Math.abs(chunk[i]!);
      if (a >= CLIP_LEVEL) clipped++;
      if (a > localPeak) localPeak = a;
    }
    this.peak = Math.max(this.peak * 0.9, localPeak);
    this.clipWindow.push(chunk.length);
    this.clipCounts.push(clipped);
    this.clipTotal += clipped;
    this.clipSamples += chunk.length;
    const maxSamples = CLIP_WINDOW_SEC * this.deviceSampleRate;
    while (this.clipSamples - (this.clipWindow[0] ?? 0) > maxSamples && this.clipWindow.length > 1) {
      this.clipSamples -= this.clipWindow.shift()!;
      this.clipTotal -= this.clipCounts.shift()!;
    }
  }

  private drainPending(): void {
    const absEnd = this.absBase + this.buf.length;
    while (this.pending.length > 0) {
      const det = this.pending[0]!;
      const start = Math.floor(det.sampleIndex);
      if (start < this.absBase) {
        // Burst start already trimmed (shouldn't happen with correct trimming).
        this.pending.shift();
        continue;
      }
      if (absEnd < start + this.burstSamples + this.postSlack) return; // wait for more samples
      this.pending.shift();

      const local = start - this.absBase;
      const slice = this.buf.subarray(local, local + this.burstSamples + this.postSlack);
      // Copy: demod may resample the buffer (two-pass drift correction).
      const x = slice.slice();
      const frac = det.sampleIndex - start + det.fracOffset;
      try {
        const res = this.demod.demodBurst(x, frac);
        this.burstsDemodulated++;
        this.lastCorrectedPpm = res.correctedPpm;
        // SNR per active carrier in dB.
        const snr = new Float32Array(res.est.snrLin.length);
        for (let i = 0; i < snr.length; i++) {
          snr[i] = 10 * Math.log10(Math.max(res.est.snrLin[i]!, 1e-6));
        }
        this.lastSnrDb = snr;
        this.lastConstellation = subsampleConstellation(res.eqRe, res.eqIm, 600);
        this.rx.pushLlrs(res.llrs);
      } catch {
        // Malformed burst (e.g. false detection near stream end) — skip.
      }
    }
  }

  private trimBuffer(): void {
    // Keep everything needed for pending bursts; otherwise keep a tail that
    // covers a burst whose detection has not been emitted yet (detector
    // latency < 2 FFT blocks ≪ burstSamples).
    let keepFrom = this.absBase + this.buf.length - (this.burstSamples + 4 * this.postSlack);
    for (const det of this.pending) {
      keepFrom = Math.min(keepFrom, Math.floor(det.sampleIndex));
    }
    keepFrom = Math.max(keepFrom, this.absBase);
    const drop = keepFrom - this.absBase;
    if (drop > 0) {
      this.buf = this.buf.slice(drop);
      this.absBase = keepFrom;
    }
  }
}

function subsampleConstellation(
  eqRe: Float32Array[],
  eqIm: Float32Array[],
  maxPoints: number,
): { re: Float32Array; im: Float32Array } {
  let total = 0;
  for (const r of eqRe) total += r.length;
  const stride = Math.max(1, Math.floor(total / maxPoints));
  const re: number[] = [];
  const im: number[] = [];
  let idx = 0;
  for (let s = 0; s < eqRe.length; s++) {
    const rr = eqRe[s]!;
    const ii = eqIm[s]!;
    for (let i = 0; i < rr.length; i++, idx++) {
      if (idx % stride === 0) {
        re.push(rr[i]!);
        im.push(ii[i]!);
      }
    }
  }
  return { re: Float32Array.from(re), im: Float32Array.from(im) };
}

/** Ensure config invariants hold for streaming (used by UI on preset switch). */
export function assertStreamable(cfg: ModemConfig): void {
  assert(cfg.dataSymbolsPerBurst > 0, 'no data symbols per burst');
}
