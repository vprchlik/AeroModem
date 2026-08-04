/**
 * AeroModem UI — role selection, mode toggle, real send/receive (Phase 6),
 * plus the Phase 1 audio-check panel.
 *
 * Real-hardware constraints honored here:
 *  - AudioContext is only created inside click handlers (iOS requires a
 *    user gesture; a context created elsewhere stays suspended forever).
 *  - The ACTIVE sample rate is displayed on both ends; the modem always runs
 *    at cfg.sampleRate and the link layer resamples when the device differs
 *    (44.1 kHz devices are common — a silent mismatch looks like huge drift).
 *  - Mic processing flags are VERIFIED via track.getSettings() and surfaced.
 *  - Screen wake lock is held during transfers where supported.
 *  - TX has a volume slider; RX has a mic-gain slider + live clipping indicator.
 *    Safari/iOS often delivers ~1% FS peaks even while talking — raise mic gain
 *    until speech hits ~20–50% peak before judging the acoustic link.
 */

import {
  FAST_48K,
  QUIET_48K,
  ROBUST_48K,
  derive,
  type ModemConfig,
} from '../config';
import { createAudio, generateTone, type AudioIO } from '../audio/context';
import { FFT, realSpectrumDb } from '../dsp/fft';
import { hann } from '../dsp/window';
import { Spectrogram } from './spectrogram';
import { SnrBars } from './snrBars';
import { ConstellationPlot } from './constellation';
import { BlockGrid } from './blockGrid';
import { WakeLockKeeper } from './wakeLock';
import { StreamingSender, StreamingReceiver } from '../link/stream';
import { frameGeometry } from '../code/geometry';
import { CaptureRecorder } from '../audio/wav';

export type Role = 'idle' | 'send' | 'receive' | 'audio';
export type Mode = 'fast' | 'robust' | 'quiet';

const MAX_FILE_BYTES = 1_048_576;

export interface AppState {
  role: Role;
  mode: Mode;
  config: ModemConfig;
  audio: AudioIO | null;
  toneHz: number;
  txTimer: ReturnType<typeof setInterval> | null;
  rxTimer: ReturnType<typeof setInterval> | null;
  sender: StreamingSender | null;
  receiver: StreamingReceiver | null;
  wakeLock: WakeLockKeeper;
  txVolume: number;
  /** Linear capture preamp (1 = unity). Raised on quiet iOS getUserMedia paths. */
  micGain: number;
  /** Rolling recording of what the demodulator saw (kept after Stop for download). */
  recorder: CaptureRecorder | null;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

function formatRate(bps: number): string {
  if (bps >= 1000) return `${(bps / 1000).toFixed(1)} kbit/s`;
  return `${bps.toFixed(0)} bit/s`;
}

const MODE_CONFIG: Record<Mode, ModemConfig> = {
  fast: FAST_48K,
  robust: ROBUST_48K,
  quiet: QUIET_48K,
};

const MODE_LABEL: Record<Mode, string> = {
  fast: 'Fast (QPSK, audible)',
  robust: 'Robust (BPSK, reverberant rooms)',
  quiet: 'Quiet (near-ultrasonic)',
};

function renderRate(state: AppState): void {
  const d = derive(state.config);
  const g = frameGeometry(state.config);
  $('rate-estimate').textContent =
    `Estimated net goodput: ${formatRate(d.estimatedNetBitRate)} · ` +
    `${g.symbolsPerFrame} OFDM sym/frame · ${g.framesPerBurst} frames/burst · ` +
    `${d.dataBins.length} data carriers`;
}

function setMode(state: AppState, mode: Mode): void {
  state.mode = mode;
  state.config = MODE_CONFIG[mode];
  document.body.dataset.mode = mode;
  for (const m of ['fast', 'robust', 'quiet'] as Mode[]) {
    $(`mode-${m}`).classList.toggle('active', mode === m);
  }
  $('mode-label').textContent = MODE_LABEL[mode];
  renderRate(state);
}

function describeAudio(audio: AudioIO, cfg: ModemConfig, needMic: boolean): string[] {
  const lines: string[] = [];
  const dev = audio.actualSampleRate;
  lines.push(
    `Device rate: ${dev} Hz · modem rate: ${cfg.sampleRate} Hz` +
      (dev === cfg.sampleRate ? ' ✓ (no resampling)' : ' — resampling at boundary'),
  );
  if (needMic) {
    const m = audio.micStatus;
    lines.push(
      `Mic processing (verified): echoCancellation=${String(m.echoCancellation)} ` +
        `noiseSuppression=${String(m.noiseSuppression)} autoGainControl=${String(m.autoGainControl)}`,
    );
    lines.push(
      m.rawOk
        ? 'Raw audio verified ✓'
        : '⚠ Browser kept voice processing ON — expect degraded or failed transfers ' +
            '(some platforms cannot disable it).',
    );
  }
  return lines;
}

// ------------------------------------------------------------------ send ---

async function startSending(state: AppState, file: File): Promise<void> {
  if (file.size === 0 || file.size > MAX_FILE_BYTES) {
    $('send-status').textContent = `File must be 1 byte … 1 MiB (got ${file.size}).`;
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    // Inside the click-initiated async flow (iOS gesture requirement).
    const audio = await createAudio(state.config, { captureEnabled: false });
    state.audio = audio;
    audio.setGain(state.txVolume);
    const wl = await state.wakeLock.acquire();

    const sessionSeed = (Date.now() ^ (Math.floor(performance.now() * 1000) << 8)) >>> 0;
    const sender = new StreamingSender(bytes, state.config, sessionSeed, {
      deviceSampleRate: audio.actualSampleRate,
    });
    state.sender = sender;

    const lines = describeAudio(audio, state.config, false);
    lines.push(wl ? 'Screen wake lock held ✓' : '⚠ No wake lock — keep the screen on manually.');
    $('send-audio-info').textContent = lines.join('\n');

    const burstDevSamples = Math.round(sender.burstSeconds * audio.actualSampleRate);
    const started = performance.now();

    // Keep ~2 bursts queued in the playback ring.
    const feed = async (): Promise<void> => {
      const stats = await audio.ringStats();
      if (stats.length < burstDevSamples * 1.2) {
        audio.stream(sender.nextBurstSamples());
      }
      const elapsed = (performance.now() - started) / 1000;
      const g = frameGeometry(state.config);
      const bytesPerBurst = g.framesPerBurst * state.config.blockSize;
      const estSec =
        ((bytes.length * 1.1) / bytesPerBurst) * sender.burstSeconds; // ε = 10%
      $('send-progress').textContent =
        `Packets sent: ${sender.packetsSent} · K=${sender.K} · elapsed ${elapsed.toFixed(0)} s · ` +
        `~${estSec.toFixed(0)} s per pass at ε=10% (loops forever until receiver finishes)`;
    };
    audio.stream(sender.nextBurstSamples());
    audio.stream(sender.nextBurstSamples());
    state.txTimer = setInterval(() => void feed(), 250);

    $('send-status').textContent = `Transmitting “${file.name}” (${bytes.length} bytes)…`;
    ($('btn-send-stop') as HTMLButtonElement).disabled = false;
    ($('btn-send-start') as HTMLButtonElement).disabled = true;
  } catch (err) {
    $('send-status').textContent =
      `Audio failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function stopSending(state: AppState): Promise<void> {
  if (state.txTimer) {
    clearInterval(state.txTimer);
    state.txTimer = null;
  }
  state.sender = null;
  await state.wakeLock.release();
  if (state.audio) {
    state.audio.clearStream();
    await state.audio.close();
    state.audio = null;
  }
  $('send-status').textContent = 'Stopped.';
  ($('btn-send-stop') as HTMLButtonElement).disabled = true;
  ($('btn-send-start') as HTMLButtonElement).disabled = false;
}

// --------------------------------------------------------------- receive ---

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function startReceiving(state: AppState): Promise<void> {
  try {
    const audio = await createAudio(state.config, { captureEnabled: true });
    state.audio = audio;
    audio.setCaptureGain(state.micGain);
    const wl = await state.wakeLock.acquire();

    const receiver = new StreamingReceiver(state.config, {
      deviceSampleRate: audio.actualSampleRate,
    });
    state.receiver = receiver;

    const lines = describeAudio(audio, state.config, true);
    lines.push(wl ? 'Screen wake lock held ✓' : '⚠ No wake lock — keep the screen on manually.');
    if (!audio.micStatus.rawOk) {
      lines.push(
        `Mic gain ${state.micGain.toFixed(0)}× — if talking stays under ~5% peak, raise Mic gain.`,
      );
    }
    $('rx-audio-info').textContent = lines.join('\n');
    $('rx-audio-info').classList.toggle('warn', !audio.micStatus.rawOk);

    const spectrogram = new Spectrogram($('rx-spectrogram') as HTMLCanvasElement, state.config, {
      floorDb: -90,
      ceilDb: -15,
      bandOnly: false,
    });
    const snrBars = new SnrBars($('rx-snr') as HTMLCanvasElement);
    const constellation = new ConstellationPlot($('rx-constellation') as HTMLCanvasElement);
    const blockGrid = new BlockGrid($('rx-blocks') as HTMLCanvasElement);

    const N = state.config.fftSize;
    const fft = new FFT(N);
    const win = hann(N);
    const spectrum = new Float32Array(N / 2 + 1);
    const sRe = new Float32Array(N);
    const sIm = new Float32Array(N);
    let frame = new Float32Array(N);
    let filled = 0;

    receiver.onComplete((fileBytes) => {
      void (async () => {
        const hash = await sha256Hex(fileBytes);
        $('rx-result').textContent =
          `✓ File received: ${fileBytes.length} bytes · SHA-256 ${hash.slice(0, 16)}…`;
        const blob = new Blob([fileBytes.slice().buffer as ArrayBuffer]);
        const url = URL.createObjectURL(blob);
        const a = $('rx-download') as HTMLAnchorElement;
        a.href = url;
        a.download = `aeromodem-${Date.now()}.bin`;
        a.hidden = false;
      })();
    });

    // Rolling capture of exactly what the demodulator sees (post mic-gain,
    // device rate) — downloadable for offline simulator reproduction.
    const recorder = new CaptureRecorder(audio.actualSampleRate, 120);
    state.recorder = recorder;
    ($('btn-rx-save-wav') as HTMLButtonElement).disabled = false;

    audio.onCapture((chunk) => {
      receiver.push(chunk);
      recorder.push(chunk);
      // Spectrogram path (device-rate frames are fine for display).
      let off = 0;
      while (off < chunk.length) {
        const n = Math.min(N - filled, chunk.length - off);
        frame.set(chunk.subarray(off, off + n), filled);
        filled += n;
        off += n;
        if (filled >= N) {
          realSpectrumDb(frame, fft, win, spectrum, sRe, sIm);
          spectrogram.push(spectrum);
          filled = 0;
        }
      }
    });

    state.rxTimer = setInterval(() => {
      const d = receiver.diagnostics;
      const p = d.progress;
      // Clipping indicator.
      const clipEl = $('rx-clip');
      const pct = (100 * d.clipFraction).toFixed(1);
      if (d.clipFraction > 0.001) {
        clipEl.textContent = `● CLIPPING ${pct}% — lower Mic gain or sender volume`;
        clipEl.className = 'clip bad';
      } else if (d.recentPeak > 0.5) {
        clipEl.textContent = `● hot (peak ${(100 * d.recentPeak).toFixed(1)}%)`;
        clipEl.className = 'clip warn';
      } else if (d.recentPeak < 0.05) {
        clipEl.textContent =
          `● too quiet (peak ${(100 * d.recentPeak).toFixed(1)}%) — raise Mic gain`;
        clipEl.className = 'clip warn';
      } else {
        clipEl.textContent = `● level ok (peak ${(100 * d.recentPeak).toFixed(1)}%)`;
        clipEl.className = 'clip ok';
      }
      $('rx-counters').textContent =
        `bursts: ${d.burstsDetected} detected / ${d.burstsDemodulated} demodulated · ` +
        `frames: ${p.framesOk} ok / ${p.framesHeaderFail} header-fail / ` +
        `${p.framesPayloadFail} payload-fail · packets ${p.packetsAccepted}` +
        (p.K ? ` / K=${p.K}` : '') +
        (d.lastCorrectedPpm !== 0 ? ` · drift ${d.lastCorrectedPpm.toFixed(1)} ppm` : '');
      if (d.lastSnrDb) snrBars.draw(d.lastSnrDb);
      if (d.lastConstellation) constellation.draw(d.lastConstellation.re, d.lastConstellation.im);
      blockGrid.draw(d.blockBitmap);
      if (p.blocksDecoded && p.K) {
        $('rx-progress').textContent = `blocks ${p.blocksDecoded}/${p.K}`;
      }
    }, 300);

    $('rx-status').textContent = 'Listening…';
    ($('btn-rx-stop') as HTMLButtonElement).disabled = false;
    ($('btn-rx-start') as HTMLButtonElement).disabled = true;
  } catch (err) {
    $('rx-status').textContent =
      `Mic failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function stopReceiving(state: AppState): Promise<void> {
  if (state.rxTimer) {
    clearInterval(state.rxTimer);
    state.rxTimer = null;
  }
  state.receiver = null;
  await state.wakeLock.release();
  if (state.audio) {
    await state.audio.close();
    state.audio = null;
  }
  $('rx-status').textContent = 'Stopped.';
  ($('btn-rx-stop') as HTMLButtonElement).disabled = true;
  ($('btn-rx-start') as HTMLButtonElement).disabled = false;
}

// ------------------------------------------------------------ audio check ---

async function stopAudioCheck(state: AppState): Promise<void> {
  if (state.audio) {
    await state.audio.close();
    state.audio = null;
  }
  $('audio-status').textContent = 'Mic stopped.';
  $('audio-status').classList.remove('warn');
  ($('btn-mic-start') as HTMLButtonElement).disabled = false;
  ($('btn-mic-stop') as HTMLButtonElement).disabled = true;
  ($('btn-tone') as HTMLButtonElement).disabled = true;
}

async function startAudioCheck(state: AppState): Promise<void> {
  $('audio-status').textContent = 'Requesting mic…';
  $('audio-status').classList.remove('warn');
  ($('btn-mic-start') as HTMLButtonElement).disabled = true;

  try {
    const audio = await createAudio(state.config);
    state.audio = audio;
    audio.setCaptureGain(state.micGain);
    const lines = describeAudio(audio, state.config, true);
    $('audio-status').textContent = lines.join('\n');
    $('audio-status').classList.toggle('warn', !audio.micStatus.rawOk);

    const canvas = $('spectrogram') as HTMLCanvasElement;
    const spectrogram = new Spectrogram(canvas, state.config, {
      floorDb: -90,
      ceilDb: -15,
      bandOnly: false,
    });

    const fft = new FFT(state.config.fftSize);
    const win = hann(state.config.fftSize);
    const spectrum = new Float32Array(state.config.fftSize / 2 + 1);
    const scratchRe = new Float32Array(state.config.fftSize);
    const scratchIm = new Float32Array(state.config.fftSize);

    let frame = new Float32Array(state.config.fftSize);
    let filled = 0;
    let peak = 0;

    audio.onCapture((chunk) => {
      let off = 0;
      while (off < chunk.length) {
        const n = Math.min(state.config.fftSize - filled, chunk.length - off);
        frame.set(chunk.subarray(off, off + n), filled);
        filled += n;
        off += n;
        if (filled >= state.config.fftSize) {
          let localPeak = 0;
          for (let i = 0; i < frame.length; i++) {
            const a = Math.abs(frame[i]!);
            if (a > localPeak) localPeak = a;
          }
          peak = Math.max(peak * 0.92, localPeak);
          ($('mic-level') as HTMLMeterElement).value = Math.min(1, peak);
          realSpectrumDb(frame, fft, win, spectrum, scratchRe, scratchIm);
          spectrogram.push(spectrum);
          filled = 0;
        }
      }
    });

    ($('btn-mic-stop') as HTMLButtonElement).disabled = false;
    ($('btn-tone') as HTMLButtonElement).disabled = false;
  } catch (err) {
    ($('btn-mic-start') as HTMLButtonElement).disabled = false;
    $('audio-status').textContent =
      `Mic failed: ${err instanceof Error ? err.message : String(err)}`;
    $('audio-status').classList.add('warn');
  }
}

let toneStatusTimer: ReturnType<typeof setTimeout> | null = null;

function playTone(state: AppState): void {
  if (!state.audio) return;
  const hz = state.toneHz;
  const durationSec = 1.5;
  const amp = hz < 8000 ? 0.5 : 0.4;
  const samples = generateTone(hz, durationSec, state.audio.actualSampleRate, amp);
  void state.audio.play(samples);

  const tip =
    hz >= 15000
      ? ' (inaudible to most adults — watch the spectrogram near the TOP)'
      : ' (you should hear this)';
  $('tone-status').textContent = `Playing ${hz.toFixed(0)} Hz for ${durationSec} s…${tip}`;
  if (toneStatusTimer) clearTimeout(toneStatusTimer);
  toneStatusTimer = setTimeout(() => {
    $('tone-status').textContent = `Done (${hz.toFixed(0)} Hz).`;
  }, durationSec * 1000 + 100);
}

// ----------------------------------------------------------------- shell ---

function setRole(state: AppState, role: Role): void {
  const prev = state.role;
  state.role = role;
  document.body.dataset.role = role;
  const labels: Record<Role, string> = {
    idle: 'Choose a role',
    send: 'Send',
    receive: 'Receive',
    audio: 'Audio check',
  };
  $('role-label').textContent = labels[role];
  $('panel-idle').hidden = role !== 'idle';
  $('panel-send').hidden = role !== 'send';
  $('panel-receive').hidden = role !== 'receive';
  $('panel-audio').hidden = role !== 'audio';

  if (prev === 'audio' && role !== 'audio') void stopAudioCheck(state);
  if (prev === 'send' && role !== 'send') void stopSending(state);
  if (prev === 'receive' && role !== 'receive') void stopReceiving(state);
}

/** Mount the app shell into `#app`. */
export function mountApp(root: HTMLElement = $('app')): AppState {
  root.innerHTML = `
    <header class="hero">
      <p class="brand">AeroModem</p>
      <p class="tagline">File transfer through sound. No network. No app install.</p>
    </header>

    <nav class="mode-toggle" aria-label="Transmission mode">
      <button type="button" id="mode-fast" class="active">Fast</button>
      <button type="button" id="mode-robust">Robust</button>
      <button type="button" id="mode-quiet">Quiet</button>
      <span class="meta">Mode: <strong id="mode-label">Fast (QPSK, audible)</strong></span>
    </nav>

    <p id="rate-estimate" class="rate"></p>

    <section id="panel-idle" class="panel">
      <h1 id="role-label">Choose a role</h1>
      <div class="roles">
        <button type="button" id="btn-send" class="role-btn">Send a file</button>
        <button type="button" id="btn-receive" class="role-btn">Receive</button>
        <button type="button" id="btn-audio" class="role-btn">Audio check</button>
      </div>
      <p class="footnote">Both phones must use the SAME mode. Place them ~0.3–1 m apart,
        media volume ~80%. See TESTING.md for the measurement protocol.</p>
    </section>

    <section id="panel-send" class="panel" hidden>
      <h1>Send</h1>
      <label class="file-label">File (≤ 1 MiB)
        <input type="file" id="send-file" />
      </label>
      <label>TX volume
        <input type="range" id="send-volume" min="0" max="100" step="1" value="80" />
        <output id="send-volume-out">80%</output>
      </label>
      <div class="audio-controls">
        <button type="button" id="btn-send-start">Start sending</button>
        <button type="button" id="btn-send-stop" disabled>Stop</button>
      </div>
      <pre id="send-audio-info" class="status"></pre>
      <p id="send-status" class="stub">Pick a file, then start. Transmission loops until the
        receiver reports completion (fountain coding: any subset of packets works).</p>
      <p id="send-progress" class="stub"></p>
      <button type="button" class="back" data-back>← Back</button>
    </section>

    <section id="panel-receive" class="panel" hidden>
      <h1>Receive</h1>
      <label>Mic gain
        <input type="range" id="rx-mic-gain" min="1" max="100" step="1" value="40" />
        <output id="rx-mic-gain-out">40×</output>
      </label>
      <p class="footnote">If talking into the mic stays under ~5% peak, raise Mic gain until
        speech hits ~20–50%. Safari/iPad often needs 40–100×.</p>
      <div class="audio-controls">
        <button type="button" id="btn-rx-start">Tap to listen</button>
        <button type="button" id="btn-rx-stop" disabled>Stop</button>
        <span id="rx-clip" class="clip ok">● level</span>
      </div>
      <div class="audio-controls">
        <button type="button" id="btn-rx-save-wav" disabled>Save capture (WAV)</button>
        <span class="meta">Keeps the last 2 min of mic input — attach failing runs to a bug
          report so they can be replayed in the simulator.</span>
      </div>
      <pre id="rx-audio-info" class="status"></pre>
      <p id="rx-status" class="stub">Idle.</p>
      <p id="rx-counters" class="stub"></p>
      <p id="rx-progress" class="stub"></p>
      <p id="rx-result" class="stub"></p>
      <a id="rx-download" hidden>Download received file</a>

      <div class="diag-grid">
        <figure>
          <canvas id="rx-spectrogram" width="480" height="180"></canvas>
          <figcaption>Spectrogram</figcaption>
        </figure>
        <figure>
          <canvas id="rx-snr" width="480" height="120"></canvas>
          <figcaption>Per-subcarrier SNR (line = 15 dB)</figcaption>
        </figure>
        <figure>
          <canvas id="rx-constellation" width="220" height="220"></canvas>
          <figcaption>Constellation (equalized)</figcaption>
        </figure>
        <figure>
          <canvas id="rx-blocks" width="220" height="220"></canvas>
          <figcaption>Source blocks</figcaption>
        </figure>
      </div>
      <button type="button" class="back" data-back>← Back</button>
    </section>

    <section id="panel-audio" class="panel" hidden>
      <h1>Audio check</h1>
      <p class="stub">1) Start mic. 2) Play a <strong>1 kHz</strong> tone — you should <em>hear</em> it
        and see a bright line near the <em>bottom</em> of the spectrogram.
        3) Then try <strong>19 kHz</strong> — you usually will <em>not</em> hear it; look for a
        line near the <em>top</em> (many speakers can't reproduce 19 kHz).</p>

      <div class="audio-controls">
        <button type="button" id="btn-mic-start">Start mic</button>
        <button type="button" id="btn-mic-stop" disabled>Stop mic</button>
        <label class="level-label">Level
          <meter id="mic-level" min="0" max="1" low="0.05" high="0.5" optimum="0.2" value="0"></meter>
        </label>
      </div>
      <label>Mic gain
        <input type="range" id="audio-mic-gain" min="1" max="100" step="1" value="40" />
        <output id="audio-mic-gain-out">40×</output>
      </label>

      <pre id="audio-status" class="status">Mic idle.</pre>

      <div class="spec-wrap">
        <div class="freq-axis-y" aria-hidden="true">
          <span>24 kHz</span><span>18</span><span>12</span><span>6</span><span>0</span>
        </div>
        <canvas id="spectrogram" width="640" height="280" aria-label="Live spectrogram"></canvas>
      </div>
      <p class="freq-axis-caption">Frequency ↑ top of plot · time → scrolls left to right</p>

      <div class="tone-presets">
        <button type="button" data-tone="1000">1 kHz (hear me)</button>
        <button type="button" data-tone="5000">5 kHz</button>
        <button type="button" data-tone="19000">19 kHz (spectrogram)</button>
      </div>

      <div class="tone-controls">
        <label>Tone
          <input type="range" id="tone-hz" min="100" max="23000" step="50" value="1000" />
          <output id="tone-hz-out" for="tone-hz">1000 Hz</output>
        </label>
        <button type="button" id="btn-tone" disabled>Play tone</button>
        <span id="tone-status" class="stub"></span>
      </div>

      <button type="button" class="back" data-back>← Back</button>
    </section>
  `;

  const state: AppState = {
    role: 'idle',
    mode: 'fast',
    config: FAST_48K,
    audio: null,
    toneHz: 1000,
    txTimer: null,
    rxTimer: null,
    sender: null,
    receiver: null,
    wakeLock: new WakeLockKeeper(),
    txVolume: 0.8,
    // iOS Safari often needs ~40–100× to get speech into the 20–50% peak band;
    // Chrome desktop should lower this if speech clips at the default.
    micGain: 40,
    recorder: null,
  };

  $('btn-send').addEventListener('click', () => setRole(state, 'send'));
  $('btn-receive').addEventListener('click', () => setRole(state, 'receive'));
  $('btn-audio').addEventListener('click', () => setRole(state, 'audio'));
  for (const m of ['fast', 'robust', 'quiet'] as Mode[]) {
    $(`mode-${m}`).addEventListener('click', () => setMode(state, m));
  }
  root.querySelectorAll<HTMLButtonElement>('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => setRole(state, 'idle'));
  });

  // Send panel.
  $('btn-send-start').addEventListener('click', () => {
    const input = $('send-file') as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      $('send-status').textContent = 'Pick a file first.';
      return;
    }
    void startSending(state, file);
  });
  $('btn-send-stop').addEventListener('click', () => void stopSending(state));
  const vol = $('send-volume') as HTMLInputElement;
  vol.addEventListener('input', () => {
    state.txVolume = Number(vol.value) / 100;
    $('send-volume-out').textContent = `${vol.value}%`;
    state.audio?.setGain(state.txVolume);
  });

  // Receive panel.
  $('btn-rx-start').addEventListener('click', () => void startReceiving(state));
  $('btn-rx-stop').addEventListener('click', () => void stopReceiving(state));
  const rxGain = $('rx-mic-gain') as HTMLInputElement;
  const audioGain = $('audio-mic-gain') as HTMLInputElement;
  const syncMicGainUi = (v: number) => {
    state.micGain = v;
    rxGain.value = String(v);
    audioGain.value = String(v);
    $('rx-mic-gain-out').textContent = `${v}×`;
    $('audio-mic-gain-out').textContent = `${v}×`;
    state.audio?.setCaptureGain(v);
  };
  rxGain.addEventListener('input', () => syncMicGainUi(Number(rxGain.value)));
  audioGain.addEventListener('input', () => syncMicGainUi(Number(audioGain.value)));
  $('btn-rx-save-wav').addEventListener('click', () => {
    const rec = state.recorder;
    if (!rec || rec.seconds < 0.1) return;
    const wav = rec.toWav();
    const url = URL.createObjectURL(new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `aeromodem-capture-${rec.sampleRate}hz-${Date.now()}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });

  // Audio check panel.
  $('btn-mic-start').addEventListener('click', () => void startAudioCheck(state));
  $('btn-mic-stop').addEventListener('click', () => void stopAudioCheck(state));
  $('btn-tone').addEventListener('click', () => playTone(state));

  root.querySelectorAll<HTMLButtonElement>('[data-tone]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.toneHz = Number(btn.dataset.tone);
      const slider = $('tone-hz') as HTMLInputElement;
      slider.value = String(state.toneHz);
      $('tone-hz-out').textContent = `${state.toneHz} Hz`;
      if (state.audio) playTone(state);
    });
  });

  const slider = $('tone-hz') as HTMLInputElement;
  const out = $('tone-hz-out');
  slider.addEventListener('input', () => {
    state.toneHz = Number(slider.value);
    out.textContent = `${state.toneHz} Hz`;
  });

  setMode(state, 'fast');
  setRole(state, 'idle');
  return state;
}
