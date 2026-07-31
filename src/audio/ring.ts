/**
 * Single-producer / single-consumer float ring buffer.
 * SharedArrayBuffer-free: used on one thread at a time (main-thread queue, or
 * inside a worklet). Cross-thread transfer is via postMessage of Float32Array chunks.
 *
 * Capacity is fixed at construction. Write returns samples actually written;
 * read returns samples actually read. Overflow/underflow counters accumulate
 * for diagnostics (never throw — audio threads must not explode).
 */

export class FloatRing {
  readonly capacity: number;
  private readonly buf: Float32Array;
  private writePos = 0;
  private readPos = 0;
  private length_ = 0;
  /** Cumulative samples dropped because the ring was full. */
  overflowSamples = 0;
  /** Cumulative samples of silence inserted because the ring was empty. */
  underflowSamples = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`FloatRing capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.buf = new Float32Array(capacity);
  }

  get length(): number {
    return this.length_;
  }

  get available(): number {
    return this.capacity - this.length_;
  }

  clear(): void {
    this.writePos = 0;
    this.readPos = 0;
    this.length_ = 0;
  }

  /**
   * Write `src[offset … offset+count)` into the ring.
   * Returns the number of samples actually stored; remainder counted as overflow.
   */
  write(src: ArrayLike<number>, offset = 0, count = src.length - offset): number {
    const n = Math.max(0, Math.min(count, src.length - offset));
    let written = 0;
    for (let i = 0; i < n; i++) {
      if (this.length_ >= this.capacity) {
        this.overflowSamples += n - i;
        break;
      }
      this.buf[this.writePos] = src[offset + i]!;
      this.writePos++;
      if (this.writePos >= this.capacity) this.writePos = 0;
      this.length_++;
      written++;
    }
    return written;
  }

  /**
   * Read up to `dst.length` samples (or `count`) into `dst`.
   * Short reads zero-fill the remainder and count underflow.
   * Returns samples actually taken from the ring (before zero-fill).
   */
  read(dst: Float32Array, offset = 0, count = dst.length - offset): number {
    const n = Math.max(0, Math.min(count, dst.length - offset));
    let got = 0;
    for (let i = 0; i < n; i++) {
      if (this.length_ === 0) {
        // Underflow: emit silence for the rest.
        for (let j = i; j < n; j++) dst[offset + j] = 0;
        this.underflowSamples += n - i;
        break;
      }
      dst[offset + i] = this.buf[this.readPos]!;
      this.readPos++;
      if (this.readPos >= this.capacity) this.readPos = 0;
      this.length_--;
      got++;
    }
    return got;
  }
}
