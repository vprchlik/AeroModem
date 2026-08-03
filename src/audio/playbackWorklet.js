/**
 * Playback AudioWorkletProcessor — pulls samples from an internal ring filled
 * by main-thread postMessage({ type: 'samples', samples: Float32Array }).
 * Plain JS so Vite emits a real worklet module (not a TS data-URL).
 */

class FloatRingInline {
  constructor(capacity) {
    this.capacity = capacity;
    this.buf = new Float32Array(capacity);
    this.writePos = 0;
    this.readPos = 0;
    this.length_ = 0;
    this.overflowSamples = 0;
    this.underflowSamples = 0;
  }

  get length() {
    return this.length_;
  }

  write(src) {
    const n = src.length;
    let written = 0;
    for (let i = 0; i < n; i++) {
      if (this.length_ >= this.capacity) {
        this.overflowSamples += n - i;
        break;
      }
      this.buf[this.writePos++] = src[i];
      if (this.writePos >= this.capacity) this.writePos = 0;
      this.length_++;
      written++;
    }
    return written;
  }

  read(dst) {
    const n = dst.length;
    let got = 0;
    for (let i = 0; i < n; i++) {
      if (this.length_ === 0) {
        for (let j = i; j < n; j++) dst[j] = 0;
        this.underflowSamples += n - i;
        break;
      }
      dst[i] = this.buf[this.readPos++];
      if (this.readPos >= this.capacity) this.readPos = 0;
      this.length_--;
      got++;
    }
    return got;
  }

  clear() {
    this.writePos = 0;
    this.readPos = 0;
    this.length_ = 0;
  }
}

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Default ~2 s at 48 kHz; Phase 6 streaming passes ~5 s so two whole
    // bursts fit and main-thread jitter can't underrun between feeds.
    const capacity =
      (options && options.processorOptions && options.processorOptions.ringCapacity) || 96000;
    this.ring = new FloatRingInline(capacity);
    this.playing = true;
    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === 'samples' && msg.samples) {
        this.ring.write(msg.samples);
      } else if (msg.type === 'clear') {
        this.ring.clear();
      } else if (msg.type === 'stop') {
        this.playing = false;
        this.ring.clear();
      } else if (msg.type === 'start') {
        this.playing = true;
      } else if (msg.type === 'stats') {
        this.port.postMessage({
          type: 'stats',
          length: this.ring.length,
          overflow: this.ring.overflowSamples,
          underflow: this.ring.underflowSamples,
        });
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    if (!this.playing) {
      out.fill(0);
      return true;
    }
    this.ring.read(out);
    return true;
  }
}

registerProcessor('aeromodem-playback', PlaybackProcessor);
