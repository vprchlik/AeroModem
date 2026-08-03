import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { FAST_48K, ROBUST_48K, QUIET_48K } from '../../src/config';
import { StreamingSender, StreamingReceiver } from '../../src/link/stream';
import { simulateChannel, activeBandHz } from '../../src/channel/simulator';
import { resampleFractional } from '../../src/dsp/resample';
import { splitmix32 } from '../../src/util/prng';

function makeFile(nbytes: number, seed: number): Uint8Array {
  const rng = splitmix32(seed);
  const f = new Uint8Array(nbytes);
  for (let i = 0; i < nbytes; i++) f[i] = Math.floor(rng() * 256);
  return f;
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Push a waveform into the receiver in randomized small chunks (as capture would). */
function pushChunked(rx: StreamingReceiver, x: Float32Array, seed: number): void {
  const rng = splitmix32(seed);
  let off = 0;
  while (off < x.length) {
    const len = 128 + Math.floor(rng() * 2048);
    rx.push(x.subarray(off, Math.min(x.length, off + len)));
    off += len;
  }
}

describe('StreamingReceiver (same-rate)', () => {
  it('receives a 5 kB file over small-room @ 20 dB from chunked capture', () => {
    const cfg = FAST_48K;
    const file = makeFile(5_000, 0x777);
    const tx = new StreamingSender(file, cfg, 0x777);
    const rx = new StreamingReceiver(cfg);

    let done: Uint8Array | null = null;
    rx.onComplete((f) => {
      done = f;
    });

    let bursts = 0;
    while (!done && bursts < 30) {
      const wave = tx.nextBurstSamples();
      const heard = simulateChannel(wave, {
        seed: 0xd000 + bursts,
        sampleRate: cfg.sampleRate,
        bandLimit: { speakerModel: 'phone' },
        rir: 'small-room',
        snrDb: 20,
        snrBandHz: activeBandHz(cfg),
        clockDriftPpm: 30,
        agcWander: true,
        startOffsetSamples: [100, 2000],
      });
      pushChunked(rx, heard, 0xe000 + bursts);
      bursts++;
    }

    expect(done).not.toBeNull();
    expect(sha256(done!)).toBe(sha256(file));
    const d = rx.diagnostics;
    expect(d.burstsDemodulated).toBeGreaterThan(0);
    expect(d.lastSnrDb).not.toBeNull();
    expect(d.lastConstellation!.re.length).toBeGreaterThan(100);
    expect(d.blockBitmap.every((b) => b === 1)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(
      `stream same-rate: bursts=${bursts}, demod=${d.burstsDemodulated}, ` +
        `framesOk=${d.progress.framesOk}`,
    );
  }, 120_000);
});

describe('cross-rate: 44.1 kHz sender device, 48 kHz receiver device', () => {
  it('decodes despite the sample-rate mismatch (would be ~81000 ppm "drift")', () => {
    const cfg = FAST_48K; // modem domain stays 48 kHz on both ends
    const file = makeFile(2_000, 0x888);
    const tx = new StreamingSender(file, cfg, 0x888, { deviceSampleRate: 44100 });
    const rx = new StreamingReceiver(cfg, { deviceSampleRate: 48000 });

    let done: Uint8Array | null = null;
    rx.onComplete((f) => {
      done = f;
    });

    let bursts = 0;
    while (!done && bursts < 25) {
      // TX emits at its device rate (44.1 kHz waveform).
      const wave441 = tx.nextBurstSamples();
      // Air + room at the sender's physical rate.
      const heard441 = simulateChannel(wave441, {
        seed: 0xf000 + bursts,
        sampleRate: 44100,
        bandLimit: { speakerModel: 'phone' },
        rir: 'small-room',
        snrDb: 20,
        snrBandHz: activeBandHz(cfg),
        clockDriftPpm: 20,
        startOffsetSamples: [100, 1500],
      });
      // The receiver's 48 kHz ADC samples the same analog waveform:
      const heard48 = resampleFractional(heard441, 44100 / 48000);
      pushChunked(rx, heard48, 0x1f00 + bursts);
      bursts++;
    }

    expect(done).not.toBeNull();
    expect(sha256(done!)).toBe(sha256(file));
    // eslint-disable-next-line no-console
    console.log(`cross-rate 44.1→48: bursts=${bursts}, framesOk=${rx.progress.framesOk}`);
  }, 120_000);

  it('receiver at 44.1 kHz device rate decodes a 48 kHz-device sender', () => {
    const cfg = FAST_48K;
    const file = makeFile(2_000, 0x999);
    const tx = new StreamingSender(file, cfg, 0x999); // 48k device
    const rx = new StreamingReceiver(cfg, { deviceSampleRate: 44100 });

    let done: Uint8Array | null = null;
    rx.onComplete((f) => {
      done = f;
    });

    let bursts = 0;
    while (!done && bursts < 25) {
      const wave48 = tx.nextBurstSamples();
      const heard48 = simulateChannel(wave48, {
        seed: 0x2f00 + bursts,
        sampleRate: 48000,
        bandLimit: { speakerModel: 'phone' },
        rir: 'small-room',
        snrDb: 20,
        snrBandHz: activeBandHz(cfg),
        clockDriftPpm: -20,
        startOffsetSamples: [100, 1500],
      });
      // 44.1 kHz ADC view of the same waveform:
      const heard441 = resampleFractional(heard48, 48000 / 44100);
      pushChunked(rx, heard441, 0x3f00 + bursts);
      bursts++;
    }

    expect(done).not.toBeNull();
    expect(sha256(done!)).toBe(sha256(file));
  }, 120_000);
});

describe('clipping indicator', () => {
  it('reports high clip fraction for an overdriven capture', () => {
    const cfg = FAST_48K;
    const rx = new StreamingReceiver(cfg);
    const n = 48000;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Square-ish overdriven waveform: 30% of samples at rail.
      const s = Math.sin((2 * Math.PI * 1000 * i) / 48000) * 1.6;
      x[i] = Math.max(-1, Math.min(1, s));
    }
    rx.push(x);
    expect(rx.diagnostics.clipFraction).toBeGreaterThan(0.2);
    expect(rx.diagnostics.recentPeak).toBeGreaterThanOrEqual(0.99);

    const clean = new StreamingReceiver(cfg);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) y[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
    clean.push(y);
    expect(clean.diagnostics.clipFraction).toBe(0);
  });
});

describe('quiet mode through the phone speaker model', () => {
  it('measures whether QUIET_48K closes the link before hardware is touched', () => {
    // PLAN Phase 6 requires this test to exist and report the truth: the
    // phone transducer model is 15–28 dB down across 17–23 kHz.
    const cfg = QUIET_48K;
    const file = makeFile(1_000, 0xaaa);
    const tx = new StreamingSender(file, cfg, 0xaaa);
    const rx = new StreamingReceiver(cfg);
    let done: Uint8Array | null = null;
    rx.onComplete((f) => {
      done = f;
    });
    let bursts = 0;
    const maxBursts = 30;
    while (!done && bursts < maxBursts) {
      const wave = tx.nextBurstSamples();
      const heard = simulateChannel(wave, {
        seed: 0x4f00 + bursts,
        sampleRate: cfg.sampleRate,
        bandLimit: { speakerModel: 'phone' },
        rir: 'small-room',
        snrDb: 20,
        snrBandHz: activeBandHz(cfg),
        clockDriftPpm: 10,
        startOffsetSamples: [100, 1500],
      });
      pushChunked(rx, heard, 0x5f00 + bursts);
      bursts++;
    }
    const p = rx.progress;
    // eslint-disable-next-line no-console
    console.log(
      `quiet@20dB small-room phone-speaker: complete=${p.complete} bursts=${bursts} ` +
        `framesOk=${p.framesOk} hdrFail=${p.framesHeaderFail} payFail=${p.framesPayloadFail} ` +
        `det=${rx.diagnostics.burstsDetected}`,
    );
    if (done) {
      expect(sha256(done!)).toBe(sha256(file));
    }
    // Record the outcome either way; the assertion is only that we detected
    // and attempted bursts (the link-budget verdict goes to PROGRESS.md).
    expect(rx.diagnostics.burstsDetected).toBeGreaterThan(0);
  }, 240_000);

  it('robust preset streams end-to-end on living-room @ 20 dB', () => {
    const cfg = ROBUST_48K;
    const file = makeFile(3_000, 0xbbb);
    const tx = new StreamingSender(file, cfg, 0xbbb);
    const rx = new StreamingReceiver(cfg);
    let done: Uint8Array | null = null;
    rx.onComplete((f) => {
      done = f;
    });
    let bursts = 0;
    while (!done && bursts < 60) {
      const wave = tx.nextBurstSamples();
      const heard = simulateChannel(wave, {
        seed: 0x6f00 + bursts,
        sampleRate: cfg.sampleRate,
        bandLimit: { speakerModel: 'phone' },
        rir: 'living-room',
        snrDb: 20,
        snrBandHz: activeBandHz(cfg),
        clockDriftPpm: 30,
        agcWander: true,
        startOffsetSamples: [100, 1500],
      });
      pushChunked(rx, heard, 0x7f00 + bursts);
      bursts++;
    }
    expect(done).not.toBeNull();
    expect(sha256(done!)).toBe(sha256(file));
    // eslint-disable-next-line no-console
    console.log(`robust stream living-room: bursts=${bursts}, framesOk=${rx.progress.framesOk}`);
  }, 240_000);
});
