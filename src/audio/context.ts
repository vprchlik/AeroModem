/**
 * Browser audio I/O — the ONLY module that may touch Web Audio API types.
 * DSP core stays pure Float32Array; this bridges mic/speaker ↔ modem.
 *
 * Mic constraints are non-negotiable for acoustic modem work:
 *   echoCancellation: false, noiseSuppression: false, autoGainControl: false
 * Browser voice processing will destroy the OFDM signal if left on.
 */

import type { ModemConfig } from '../config';
import playbackWorkletSource from './playbackWorklet.js?raw';
import captureWorkletSource from './captureWorklet.js?raw';

/** Compile a worklet source string into an object-URL module (revoked on close). */
function workletFromSource(source: string): string {
  const blob = new Blob([source], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

/** Resolved mic-processing flags (what the browser actually applied). */
export interface MicConstraintsStatus {
  echoCancellation: boolean | string | undefined;
  noiseSuppression: boolean | string | undefined;
  autoGainControl: boolean | string | undefined;
  /** True iff all three processing flags resolved to false. */
  rawOk: boolean;
  channelCount: number | undefined;
}

export interface AudioIO {
  readonly actualSampleRate: number;
  readonly micStatus: MicConstraintsStatus;
  /** Queue mono samples for playback. */
  play(samples: Float32Array): Promise<void>;
  /** Register a listener for capture batches (typically fftSize samples). */
  onCapture(cb: (chunk: Float32Array) => void): void;
  /** Stop capture/playback and release the mic. */
  close(): Promise<void>;
}

const RAW_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

function readMicStatus(track: MediaStreamTrack): MicConstraintsStatus {
  const s = track.getSettings();
  const echoCancellation = s.echoCancellation as boolean | string | undefined;
  const noiseSuppression = s.noiseSuppression as boolean | string | undefined;
  const autoGainControl = s.autoGainControl as boolean | string | undefined;
  const rawOk =
    echoCancellation === false &&
    noiseSuppression === false &&
    autoGainControl === false;
  return {
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    rawOk,
    channelCount: s.channelCount,
  };
}

export async function createAudio(cfg: ModemConfig): Promise<AudioIO> {
  const ctx = new AudioContext({ sampleRate: cfg.sampleRate, latencyHint: 'interactive' });

  // Resume may be required after a user gesture.
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...RAW_CONSTRAINTS,
      sampleRate: cfg.sampleRate,
    },
    video: false,
  });

  const track = stream.getAudioTracks()[0];
  if (!track) {
    await ctx.close();
    throw new Error('No audio track returned by getUserMedia');
  }
  const micStatus = readMicStatus(track);

  const playbackUrl = workletFromSource(playbackWorkletSource);
  const captureUrl = workletFromSource(captureWorkletSource);
  await Promise.all([
    ctx.audioWorklet.addModule(playbackUrl),
    ctx.audioWorklet.addModule(captureUrl),
  ]);
  // Keep blob URLs alive until close(); some engines resolve the module lazily.

  const playbackNode = new AudioWorkletNode(ctx, 'aeromodem-playback', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  // Master gain for both one-shot buffer playback and the streaming worklet.
  const masterGain = ctx.createGain();
  masterGain.gain.value = 1;
  masterGain.connect(ctx.destination);
  playbackNode.connect(masterGain);

  const captureNode = new AudioWorkletNode(ctx, 'aeromodem-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    processorOptions: { batchSize: cfg.fftSize },
  });

  const source = ctx.createMediaStreamSource(stream);
  source.connect(captureNode);

  let captureCb: ((chunk: Float32Array) => void) | null = null;
  captureNode.port.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as { type: string; samples?: Float32Array };
    if (msg.type === 'capture' && msg.samples && captureCb) {
      captureCb(msg.samples);
    }
  };

  let closed = false;

  return {
    get actualSampleRate() {
      return ctx.sampleRate;
    },
    micStatus,
    async play(samples: Float32Array) {
      if (closed) return;
      // User-gesture / autoplay policies can leave the context suspended.
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      // One-shot path via AudioBufferSourceNode — reliable for tone bursts.
      // Continuous streaming (Phase 6) uses the playback worklet ring instead.
      const copy = samples.slice();
      const buf = ctx.createBuffer(1, copy.length, ctx.sampleRate);
      buf.copyToChannel(copy, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(masterGain);
      src.start();
    },
    onCapture(cb: (chunk: Float32Array) => void) {
      captureCb = cb;
    },
    async close() {
      if (closed) return;
      closed = true;
      captureCb = null;
      playbackNode.port.postMessage({ type: 'stop' });
      try {
        source.disconnect();
        captureNode.disconnect();
        playbackNode.disconnect();
        masterGain.disconnect();
      } catch {
        /* already disconnected */
      }
      for (const t of stream.getTracks()) t.stop();
      URL.revokeObjectURL(playbackUrl);
      URL.revokeObjectURL(captureUrl);
      await ctx.close();
    },
  };
}

/**
 * Generate a unit-amplitude real cosine of `freqHz` for `durationSec` seconds.
 * Pure function — usable in tests and the tone-generator UI.
 */
export function generateTone(
  freqHz: number,
  durationSec: number,
  sampleRate: number,
  amplitude = 0.4,
): Float32Array {
  const n = Math.max(1, Math.round(durationSec * sampleRate));
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freqHz) / sampleRate;
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.cos(w * i);
  }
  // 5 ms raised-cosine fade in/out to avoid speaker clicks.
  const fade = Math.min(Math.round(0.005 * sampleRate), Math.floor(n / 2));
  for (let i = 0; i < fade; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    out[i]! *= g;
    out[n - 1 - i]! *= g;
  }
  return out;
}
