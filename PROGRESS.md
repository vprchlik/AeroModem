# AeroModem — Progress Log

Numbers only. Updated at the end of every phase.

---

## Phase 0 — Scaffold (2026-07-31)

**Delivered:** Vite + TypeScript + Vitest project; typed `ModemConfig` + `derive()`;
seedable `splitmix32` / `gaussianPair`; empty UI shell with role selection and
fast/quiet mode toggle; dual entry points (`index.html`, `bench.html`); GitHub Actions CI.

**Measured (from `derive()`, automated tests):**

| Preset | binLow…binHigh | nActive | pilots | data | Δf (Hz) | R_sym (Hz) | estimatedNetBitRate |
|---|---|---|---|---|---|---|---|
| FAST_48K (2–20 kHz, QPSK r=1/2) | 86…853 | 768 | 85 | 683 | 23.4375 | 18.75 | **9580.8 bit/s** (target ≥ 5 kbit/s) |
| QUIET_48K (17–23 kHz, QPSK r=1/2) | 726…981 | 256 | 28 | 228 | 23.4375 | 18.75 | **3198.3 bit/s** (target ≥ 2 kbit/s) |

Net rate folds in: FEC 1/2 × burst data fraction (32 data / (chirp+guard+2 train+32 data)) × frame payload fraction (256/(24+256+4)) / (1+ε=1.08). UI rate line is driven by live `derive()` output.

**PRNG:** 1e5 uniform draws, seed 2026 → mean ∈ (0.49, 0.51), variance ∈ (0.08, 0.087);
1e5 Box–Muller samples → |mean| < 0.02, variance ∈ (0.96, 1.04). Same seed ⇒ identical sequence.

**Acceptance:** `npm test` — 16/16 green in Node; `npm run build` emits static `dist/`
(`index.html` + `bench.html`); CI workflow (typecheck + test + build) under
`.github/workflows/ci.yml`.

*Next: Phase 1 — Audio plumbing + visualizer.*
