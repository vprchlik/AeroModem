/**
 * Canvas waterfall spectrogram.
 * Each `push(spectrumDb)` draws one column (newest on the right), scrolling left.
 * Frequency axis: bin 0 at bottom → Nyquist at top (or band-limited if cfg set).
 */

import type { ModemConfig } from '../config';
import { derive } from '../config';

export interface SpectrogramOptions {
  /** dB at the bottom of the colour map. */
  floorDb?: number;
  /** dB at the top of the colour map. */
  ceilDb?: number;
  /** If true, only show the modem’s active band; otherwise 0…Nyquist. */
  bandOnly?: boolean;
}

export class Spectrogram {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly floorDb: number;
  private readonly ceilDb: number;
  private readonly binLow: number;
  private readonly binHigh: number;
  private readonly cols: ImageData;
  private readonly width: number;
  private readonly height: number;

  constructor(canvas: HTMLCanvasElement, cfg: ModemConfig, opts: SpectrogramOptions = {}) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.canvas = canvas;
    this.ctx = ctx;
    this.floorDb = opts.floorDb ?? -90;
    this.ceilDb = opts.ceilDb ?? -10;
    const d = derive(cfg);
    const bandOnly = opts.bandOnly ?? false;
    this.binLow = bandOnly ? d.binLow : 0;
    this.binHigh = bandOnly ? d.binHigh : cfg.fftSize / 2;
    this.width = canvas.width;
    this.height = canvas.height;
    this.cols = ctx.createImageData(this.width, this.height);
    // Dark empty waterfall.
    for (let i = 0; i < this.cols.data.length; i += 4) {
      this.cols.data[i] = 8;
      this.cols.data[i + 1] = 14;
      this.cols.data[i + 2] = 18;
      this.cols.data[i + 3] = 255;
    }
    ctx.putImageData(this.cols, 0, 0);
  }

  /** Push one spectrum column (length ≥ binHigh+1). Newest column on the right. */
  push(spectrumDb: Float32Array): void {
    const { width, height, binLow, binHigh, floorDb, ceilDb } = this;
    const data = this.cols.data;
    const nBins = binHigh - binLow + 1;

    // Scroll left by 1 px.
    for (let y = 0; y < height; y++) {
      const row = y * width * 4;
      data.copyWithin(row, row + 4, row + width * 4);
    }

    const x = width - 1;
    const range = Math.max(1e-6, ceilDb - floorDb);
    for (let y = 0; y < height; y++) {
      // y=0 at top of canvas → high frequency; y=height-1 → low frequency.
      const t = 1 - y / (height - 1 || 1);
      const bin = binLow + t * (nBins - 1);
      const b0 = Math.floor(bin);
      const b1 = Math.min(binHigh, b0 + 1);
      const frac = bin - b0;
      const db0 = spectrumDb[b0] ?? floorDb;
      const db1 = spectrumDb[b1] ?? floorDb;
      const db = db0 * (1 - frac) + db1 * frac;
      const v = Math.max(0, Math.min(1, (db - floorDb) / range));
      const [r, g, b] = colourMap(v);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
    this.ctx.putImageData(this.cols, 0, 0);
  }

  /** Frequency (Hz) at a canvas Y pixel (for axis labels / click). */
  hzAtY(y: number, sampleRate: number, fftSize: number): number {
    const t = 1 - y / (this.height - 1 || 1);
    const bin = this.binLow + t * (this.binHigh - this.binLow);
    return (bin * sampleRate) / fftSize;
  }

  get element(): HTMLCanvasElement {
    return this.canvas;
  }
}

/** Teal→amber sequential map (avoids purple glow tropes). */
function colourMap(v: number): [number, number, number] {
  // Piecewise: dark teal → seafoam → amber.
  if (v < 0.5) {
    const t = v / 0.5;
    return [
      Math.round(8 + t * (40 - 8)),
      Math.round(20 + t * (160 - 20)),
      Math.round(28 + t * (140 - 28)),
    ];
  }
  const t = (v - 0.5) / 0.5;
  return [
    Math.round(40 + t * (220 - 40)),
    Math.round(160 + t * (180 - 160)),
    Math.round(140 + t * (40 - 140)),
  ];
}
