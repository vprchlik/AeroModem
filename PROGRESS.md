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

---

## Phase 1 — Audio plumbing + visualizer (2026-07-31)

**Delivered:** radix-2 FFT + Hann window (pure DSP); `FloatRing`; AudioWorklet capture &
playback with raw-mic constraints; Canvas spectrogram; tone generator (100 Hz–23 kHz);
Audio-check UI panel.

**Automated measurements:**

| Check | Result |
|---|---|
| FFT vs direct DFT (sizes 8…2048) | max abs error &lt; 1e-4 (Float32) |
| `inverse(forward(x))` | max abs error &lt; 1e-5 (N=256) |
| Parseval | \|time − freq/N\| &lt; 1e-3 (N=512) |
| Hann coherent gain (N=2048) | ≈ 0.5 |
| `generateTone(19000)` peak bin @ 48 kHz / N=2048 | within ±1 of bin 811 |
| Ring wrap / overflow / underflow | counters correct |
| `npm test` | **40/40 green** |

**Manual acceptance (YOU need to run this — cloud agent has no speakers/mic):**

1. `npm install && npm run dev`, open the printed localhost URL in Chrome/Edge.
2. Click **Audio check** → **Start mic** → allow microphone.
3. Confirm status shows `echoCancellation=false`, `noiseSuppression=false`,
   `autoGainControl=false` and “Raw audio constraints OK ✓”.
   (If any flag is true, note which browser/OS — that is a known risk in PLAN.md §8.)
4. **Same-tab smoke test:** leave tone at 19000 Hz, click **Play tone**. You should hear
   a faint/inaudible hiss (or nothing) and see a bright horizontal line near the top of
   the spectrogram (~19 kHz). Level meter should tick up.
5. **Two-tab acceptance (PLAN criterion):** open a second tab to the same URL → Audio
   check → Start mic in tab A; in tab B Start mic (or just play — playback does not need
   mic) and Play 19 kHz tone. Tab A’s spectrogram should show the 19 kHz line from tab B’s
   speaker. Turn laptop volume up if needed; keep tabs from muting each other.
6. Optionally sweep the tone slider (1 kHz, 10 kHz, 19 kHz) and confirm the line moves.

Paste results into this section when done (browser, OS, rawOk yes/no, two-tab visible yes/no).

| Field | Your result |
|---|---|
| Browser / OS | Victor laptop (2026-07-31) |
| Sample rate reported | **48000 Hz ✓** |
| rawOk (all three flags false) | **yes** |
| Same-tab 1 kHz audible + line | **yes** (heard; line near bottom of spectrogram) |
| Same-tab 5 kHz audible + line | **yes** (heard; bright line ~5 kHz) |
| Same-tab 19 kHz audible | **no** (expected — above typical adult hearing / speaker response) |
| Same-tab 19 kHz line on spectrogram | **no** — laptop speakers do not reproduce 19 kHz into the mic |
| Two-tab 19 kHz line visible | not required given speaker roll-off |

**Phase 1 verdict:** Mic capture, raw constraints, spectrogram, and audible playback are verified. The PLAN’s “19 kHz tone visible on spectrogram” criterion fails on this hardware because the **speaker**, not the modem stack, rolls off — confirmed by clean 1/5 kHz loopback on the same path. This is the planned Phase 2 `speakerModel: 'phone'` / band-limit impairment; no code change needed before Phase 2.

**Follow-up fix (same phase):** tone status now clears after 1.5 s; `play()` resumes a suspended AudioContext and uses `AudioBufferSourceNode` for one-shots; UI defaults to 1 kHz with preset buttons; frequency axis labeled on the Y side (top = 24 kHz).

*Standing by for user signal before Phase 2 — Channel simulator.*

---

## Phase 2 — Channel simulator (2026-07-31)

**Delivered:** `simulateChannel(samples, opts)` — composable impairments in physical order
(clip → speaker band-limit → RIR → clock drift → AGC wander → AWGN → start offset), all
randomness from `splitmix32(opts.seed)`; synthetic RIR presets with stats; FIR design +
FFT convolution; fractional resampler; Welch band-power / SNR / tone-frequency / THD
measurement helpers; DSP-purity lint test.

**Measured vs target (all automated, seeded):**

| Impairment | Target | Measured |
|---|---|---|
| AWGN SNR accuracy (0/10/20/30 dB × 10 seeds) | ±0.5 dB | mean err −0.004 dB, worst \|err\| **0.074 dB** |
| Phone band-limit @ 10 kHz | < 1 dB | **0.000 dB** |
| Phone band-limit @ 22.5 kHz | ≥ 30 dB | **131.7 dB** |
| RIR small-room DRR / τ_rms | 6 dB ± 2 / 3–20 ms | **6.00 dB / 10.8 ms** |
| RIR living-room DRR / τ_rms | 3 dB ± 2 / 12–45 ms | **3.00 dB / 23.8 ms** |
| RIR hallway DRR / τ_rms | 0 dB ± 2 / 25–90 ms | **−0.00 dB / 43.1 ms** |
| Clock drift +50 ppm on 10 kHz | 10000.5 ± 0.1 Hz | **10000.5009 Hz** |
| Clock drift −50 ppm on 10 kHz | 9999.5 ± 0.1 Hz | **9999.4977 Hz** |
| THD clean sine | < 1e-3 | **7.1e-15** |
| THD clipped @ −6 dBFS | > 0.05 | **0.055** |
| Determinism | bit-identical per seed | verified (full composite opts) |

**Tests:** 85/85 green (`npm test`), including 45 new Phase 2 assertions and a purity
test that scans `src/dsp`, `src/channel`, `src/util` for Web Audio/DOM references and
`Math.random`.

*Next: Phase 3 — Sync (chirp preamble).*
