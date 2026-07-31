/**
 * /bench research harness — Phase 0 stub.
 * Sweeps, CSV export, and plots arrive in Phases 4–8.
 */
import '../ui/style.css';

const root = document.getElementById('app');
if (!root) throw new Error('#app not found');

root.innerHTML = `
  <header class="hero">
    <p class="brand">AeroModem</p>
    <p class="tagline">Benchmark harness — stub until Phase 4.</p>
  </header>
  <p class="stub">Automated SNR / config sweeps, BER curves, and CSV export land with
    the OFDM modem and fountain-code phases. <a href="./index.html">← Back to app</a></p>
`;
