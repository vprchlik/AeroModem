/**
 * Per-subcarrier SNR bar plot. Downsamples the active-carrier SNR array into
 * screen-width bars; color encodes usability (green ≥ 15 dB, amber ≥ 8, red below).
 */

export class SnrBars {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('SnrBars: no 2d context');
    this.ctx = ctx;
    this.clear();
  }

  clear(): void {
    this.ctx.fillStyle = '#10141c';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** snrDb: per active carrier (binLow…binHigh order). */
  draw(snrDb: Float32Array): void {
    const { width: w, height: h } = this.canvas;
    const ctx = this.ctx;
    this.clear();
    const nBars = Math.min(128, snrDb.length);
    const per = snrDb.length / nBars;
    const barW = w / nBars;
    const minDb = -5;
    const maxDb = 35;
    for (let b = 0; b < nBars; b++) {
      // Mean SNR of this bar's carriers.
      let sum = 0;
      let cnt = 0;
      for (let i = Math.floor(b * per); i < Math.min(snrDb.length, (b + 1) * per); i++) {
        sum += snrDb[i]!;
        cnt++;
      }
      const db = cnt ? sum / cnt : minDb;
      const frac = Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb)));
      const barH = frac * (h - 4);
      ctx.fillStyle = db >= 15 ? '#41d97e' : db >= 8 ? '#e8b93e' : '#e8523e';
      ctx.fillRect(b * barW + 0.5, h - barH, Math.max(1, barW - 1), barH);
    }
    // 15 dB guide line.
    const gy = h - ((15 - minDb) / (maxDb - minDb)) * (h - 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
  }
}
