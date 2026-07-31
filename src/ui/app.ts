/**
 * Hand-rolled UI shell — role selection + mode toggle.
 * Phase 0: buttons are wired to stubs; real send/receive arrives in Phase 6.
 * No framework: a few DOM helpers and a state object.
 */

import {
  FAST_48K,
  QUIET_48K,
  derive,
  type ModemConfig,
  type PresetId,
} from '../config';

export type Role = 'idle' | 'send' | 'receive';

export interface AppState {
  role: Role;
  mode: 'fast' | 'quiet';
  config: ModemConfig;
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
  const el = $('rate-estimate');
  el.textContent =
    `Estimated net goodput: ${formatRate(d.estimatedNetBitRate)} ` +
    `(${d.dataBins.length} data / ${d.pilotBins.length} pilot carriers, ` +
    `${d.binLow}…${d.binHigh})`;
}

function setRole(state: AppState, role: Role): void {
  state.role = role;
  document.body.dataset.role = role;
  $('role-label').textContent =
    role === 'idle' ? 'Choose a role' : role === 'send' ? 'Send' : 'Receive';
  $('panel-idle').hidden = role !== 'idle';
  $('panel-send').hidden = role !== 'send';
  $('panel-receive').hidden = role !== 'receive';
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

/** Mount the Phase 0 shell into `#app`. */
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
      </div>
      <p class="footnote">Phase 0 scaffold — DSP and audio arrive in later phases.
        Open <a href="./bench.html">/bench</a> for the research harness (stub).</p>
    </section>

    <section id="panel-send" class="panel" hidden>
      <h1>Send</h1>
      <p class="stub">File picker, TX spectrogram, and packet counter land in Phase 6.
        Audio plumbing arrives in Phase 1.</p>
      <button type="button" class="back" data-back>← Back</button>
    </section>

    <section id="panel-receive" class="panel" hidden>
      <h1>Receive</h1>
      <p class="stub">Tap-to-listen, SNR bars, constellation, and block grid land in Phase 6.
        Mic capture + spectrogram arrive in Phase 1.</p>
      <button type="button" class="back" data-back>← Back</button>
    </section>
  `;

  const state: AppState = {
    role: 'idle',
    mode: 'fast',
    config: FAST_48K,
  };

  $('btn-send').addEventListener('click', () => setRole(state, 'send'));
  $('btn-receive').addEventListener('click', () => setRole(state, 'receive'));
  $('mode-fast').addEventListener('click', () => setMode(state, 'fast'));
  $('mode-quiet').addEventListener('click', () => setMode(state, 'quiet'));
  root.querySelectorAll<HTMLButtonElement>('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => setRole(state, 'idle'));
  });

  setMode(state, 'fast');
  setRole(state, 'idle');
  return state;
}
