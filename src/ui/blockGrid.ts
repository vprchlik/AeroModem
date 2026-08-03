/** Torrent-style source-block grid: filled cell = block decoded. */

export class BlockGrid {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('BlockGrid: no 2d context');
    this.ctx = ctx;
    this.clear();
  }

  clear(): void {
    this.ctx.fillStyle = '#10141c';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(bitmap: Uint8Array): void {
    this.clear();
    const K = bitmap.length;
    if (K === 0) return;
    const { width: w, height: h } = this.canvas;
    const cols = Math.ceil(Math.sqrt((K * w) / h));
    const rows = Math.ceil(K / cols);
    const cw = w / cols;
    const ch = h / rows;
    const ctx = this.ctx;
    for (let i = 0; i < K; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      ctx.fillStyle = bitmap[i] ? '#41d97e' : 'rgba(255,255,255,0.08)';
      ctx.fillRect(c * cw + 0.5, r * ch + 0.5, Math.max(1, cw - 1), Math.max(1, ch - 1));
    }
  }
}
