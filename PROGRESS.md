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
| Browser / OS | |
| Sample rate reported | |
| rawOk (all three flags false) | **yes** (Victor laptop, 2026-07-31 — screenshot) |
| Same-tab 1 kHz audible + line | _(retest after playback fix)_ |
| Same-tab 19 kHz line visible | _(retest — look near TOP of spectrogram; speakers may not reproduce)_ |
| Notes | Initial 19 kHz test: no audible tone (expected); status text stuck (fixed); playback hardened to AudioBufferSourceNode |

**Follow-up fix (same phase):** tone status now clears after 1.5 s; `play()` resumes a suspended AudioContext and uses `AudioBufferSourceNode` for one-shots; UI defaults to 1 kHz with preset buttons; frequency axis labeled on the Y side (top = 24 kHz).

*Next: Phase 2 — Channel simulator.*
