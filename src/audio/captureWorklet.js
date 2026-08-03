/**
 * Capture AudioWorkletProcessor — copies mic input into batches and posts
 * Float32Array chunks to the main thread.
 * Plain JS so Vite emits a real worklet module (not a TS data-URL).
 *
 * Default batch = 2048 samples (~42.7 ms @ 48 kHz), matching the OFDM FFT size.
 */

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.batchSize = (options && options.processorOptions && options.processorOptions.batchSize) || 2048;
    this.buf = new Float32Array(this.batchSize);
    this.filled = 0;
    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === 'setBatchSize' && msg.batchSize && msg.batchSize > 0) {
        this.flush();
        this.batchSize = msg.batchSize | 0;
        this.buf = new Float32Array(this.batchSize);
        this.filled = 0;
      }
    };
  }

  flush() {
    if (this.filled === 0) return;
    const chunk = this.buf.slice(0, this.filled);
    this.port.postMessage({ type: 'capture', samples: chunk }, [chunk.buffer]);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;

    let i = 0;
    while (i < input.length) {
      const space = this.batchSize - this.filled;
      const n = Math.min(space, input.length - i);
      this.buf.set(input.subarray(i, i + n), this.filled);
      this.filled += n;
      i += n;
      if (this.filled >= this.batchSize) {
        const chunk = this.buf.slice();
        this.port.postMessage({ type: 'capture', samples: chunk }, [chunk.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('aeromodem-capture', CaptureProcessor);
