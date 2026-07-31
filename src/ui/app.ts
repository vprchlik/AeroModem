/**
 * Hand-rolled UI shell — role selection, mode toggle, Phase 1 audio-check panel.
 * No framework: a few DOM helpers and a state object.
 */

import {
  FAST_48K,
  QUIET_48K,
  derive,
  type ModemConfig,
  type PresetId,
} from '../config';
import { createAudio, generateTone, type AudioIO } from '../audio/context';
import { FFT, realSpectrumDb } from '../dsp/fft';
import { hann } from '../dsp/window';
import { Spectrogram } from './spectrogram';

export type Role = 'idle' | 'send' | 'receive' | 'audio';

export interface AppState {
  role: Role;
  mode: 'fast' | 'quiet';
  config: ModemConfig;
  audio: AudioIO | null;
  toneHz: number;
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

function configFor(mode: 'fast' | 'quiet'): ModemConfig {
  return mode === 'fast' ? FAST_48K : QUIET_48K;
}

function presetId(mode: 'fast' | 'quiet'): PresetId {
  return mode === 'fast' ? 'fast-48k' : 'quiet-48k';
}

function renderRate(state: AppState): void {
  const d = derive(state.config);
  $('rate-estimate').textContent =
    `Estimated net goodput: ${formatRate(d.estimatedNetBitRate)} ` +
    `(${d.dataBins.length} data / ${d.pilotBins.length} pilot carriers, ` +
    `${d.binLow}…${d.binHigh})`;
}

async function stopAudio(state: AppState): Promise<void> {
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

  if (prev === 'audio' && role !== 'audio') {
    void stopAudio(state);
  }
}

function setMode(state: AppState, mode: 'fast' | 'quiet'): void {
  state.mode = mode;
  state.config = configFor(mode);
  document.body.dataset.mode = mode;
  $('mode-fast').classList.toggle('active', mode === 'fast');
  $('mode-quiet').classList.toggle('active', mode === 'quiet');
  $('mode-label').textContent = mode === 'fast' ? 'Fast (audible)' : 'Quiet (near-ultrasonic)';
  $('preset-id').textContent = presetId(mode);
  renderRate(state);
}

async function startAudio(state: AppState): Promise<void> {
  $('audio-status').textContent = 'Requesting mic…';
  $('audio-status').classList.remove('warn');
  ($('btn-mic-start') as HTMLButtonElement).disabled = true;

  try {
    const audio = await createAudio(state.config);
    state.audio = audio;

    const srMismatch = Math.abs(audio.actualSampleRate - state.config.sampleRate) > 1;
    const mic = audio.micStatus;
    const lines = [
      `Sample rate: ${audio.actualSampleRate} Hz` +
        (srMismatch ? ` ⚠ config wants ${state.config.sampleRate}` : ' ✓'),
      `echoCancellation=${String(mic.echoCancellation)}`,
      `noiseSuppression=${String(mic.noiseSuppression)}`,
      `autoGainControl=${String(mic.autoGainControl)}`,
      mic.rawOk
        ? 'Raw audio constraints OK ✓'
        : '⚠ Browser refused raw constraints — signal may be damaged',
    ];
    $('audio-status').textContent = lines.join('\n');
    $('audio-status').classList.toggle('warn', !mic.rawOk || srMismatch);

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

function playTone(state: AppState): void {
  if (!state.audio) return;
  const hz = state.toneHz;
  const samples = generateTone(hz, 1.5, state.audio.actualSampleRate, 0.35);
  void state.audio.play(samples);
  $('tone-status').textContent = `Playing ${hz.toFixed(0)} Hz for 1.5 s…`;
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
      <button type="button" id="mode-quiet">Quiet</button>
      <span class="meta">Mode: <strong id="mode-label">Fast (audible)</strong>
        · preset <code id="preset-id">fast-48k</code></span>
    </nav>

    <p id="rate-estimate" class="rate"></p>

    <section id="panel-idle" class="panel">
      <h1 id="role-label">Choose a role</h1>
      <div class="roles">
        <button type="button" id="btn-send" class="role-btn">Send a file</button>
        <button type="button" id="btn-receive" class="role-btn">Receive</button>
        <button type="button" id="btn-audio" class="role-btn">Audio check</button>
      </div>
      <p class="footnote">Phase 1: verify mic + speaker with the audio-check panel
        (19 kHz tone → spectrogram). Send/receive land in Phase 6.
        Open <a href="./bench.html">/bench</a> for the research harness (stub).</p>
    </section>

    <section id="panel-send" class="panel" hidden>
      <h1>Send</h1>
      <p class="stub">File picker, TX spectrogram, and packet counter land in Phase 6.</p>
      <button type="button" class="back" data-back>← Back</button>
    </section>

    <section id="panel-receive" class="panel" hidden>
      <h1>Receive</h1>
      <p class="stub">Tap-to-listen, SNR bars, constellation, and block grid land in Phase 6.</p>
      <button type="button" class="back" data-back>← Back</button>
    </section>

    <section id="panel-audio" class="panel" hidden>
      <h1>Audio check</h1>
      <p class="stub">Start the mic in this tab, open another tab on the same page, play a
        19 kHz tone there — you should see a bright horizontal line on this spectrogram.</p>

      <div class="audio-controls">
        <button type="button" id="btn-mic-start">Start mic</button>
        <button type="button" id="btn-mic-stop" disabled>Stop mic</button>
        <label class="level-label">Level
          <meter id="mic-level" min="0" max="1" low="0.05" high="0.5" optimum="0.2" value="0"></meter>
        </label>
      </div>

      <pre id="audio-status" class="status">Mic idle.</pre>

      <canvas id="spectrogram" width="640" height="280" aria-label="Live spectrogram"></canvas>
      <div class="freq-axis" aria-hidden="true">
        <span>0</span><span>6 kHz</span><span>12 kHz</span><span>18 kHz</span><span>24 kHz</span>
      </div>

      <div class="tone-controls">
        <label>Tone
          <input type="range" id="tone-hz" min="100" max="23000" step="50" value="19000" />
          <output id="tone-hz-out" for="tone-hz">19000 Hz</output>
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
    toneHz: 19000,
  };

  $('btn-send').addEventListener('click', () => setRole(state, 'send'));
  $('btn-receive').addEventListener('click', () => setRole(state, 'receive'));
  $('btn-audio').addEventListener('click', () => setRole(state, 'audio'));
  $('mode-fast').addEventListener('click', () => setMode(state, 'fast'));
  $('mode-quiet').addEventListener('click', () => setMode(state, 'quiet'));
  root.querySelectorAll<HTMLButtonElement>('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => setRole(state, 'idle'));
  });

  $('btn-mic-start').addEventListener('click', () => void startAudio(state));
  $('btn-mic-stop').addEventListener('click', () => void stopAudio(state));
  $('btn-tone').addEventListener('click', () => playTone(state));

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
