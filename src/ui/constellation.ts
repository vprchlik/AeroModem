/** Equalized-constellation scatter plot (unit-power axes, ±1.6 view). */

export class ConstellationPlot {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('ConstellationPlot: no 2d context');
    this.ctx = ctx;
    this.clear();
  }

  clear(): void {
    const { width: w, height: h } = this.canvas;
    const ctx = this.ctx;
    ctx.fillStyle = '#10141c';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }

  draw(re: Float32Array, im: Float32Array): void {
    this.clear();
    const { width: w, height: h } = this.canvas;
    const ctx = this.ctx;
    const scale = 1.6; // view range ±1.6 (covers 16-QAM outer points at ±0.95)
    ctx.fillStyle = 'rgba(110,190,255,0.55)';
    for (let i = 0; i < re.length; i++) {
      const x = (re[i]! / scale + 1) * 0.5 * w;
      const y = (1 - im[i]! / scale) * 0.5 * h;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }
}
