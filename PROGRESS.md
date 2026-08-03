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

---

## Phase 2 audit — anti-optimism hardening (2026-07-31)

Five audit questions answered with measurements; three real problems found and fixed.

**1. SNR band definition (PROBLEM — fixed).** Old behavior: `snrDb` defaulted to a
full-band (0–24 kHz) definition. Measured: quiet-mode signal (17–23 kHz), 10 dB
requested → **15.97 dB delivered in-band** (+6.0 dB optimistic, = 10·log10(24/6)).
Fix: `snrBandHz` is now **required** whenever `snrDb` is set (assertion), taken from
the modem band via `activeBandHz(cfg)`. After fix: 10 dB requested → **9.97 dB
measured in-band**.

**2. Speaker roll-off (PROBLEM — fixed).** Old brick-wall FIR measured 131.7 dB at
22.5 kHz. Replaced with `designFirFromMagnitude` transducer model (2nd-order
Butterworth HPF −3 dB @ 350 Hz; smooth |H| = 1/√(1+(f/15.7 kHz)^18) top end).
Measured response (dB attenuation): 0.5 k: 1.05 · 1 k: 0.07 · 5 k: 0.00 · 10 k: 0.00 ·
15 k: 1.59 · 17 k: 7.15 · 19 k: 15.05 · 20 k: 18.97 · 21 k: 22.76 · **22.5 k: 28.13** ·
23 k: 29.85. Slope 20→22.5 kHz: **53.9 dB/oct** (spec 40–60, no cliff). Group delay
(511−1)/2 = **255 samples = 5.31 ms**, removed by `filterAligned` slice — output
sample-aligned with input. Tests now assert 22.5 kHz ∈ [25, 35] dB and slope ∈ [40, 60]
dB/oct. Note: 19–20 kHz is now 15–19 dB down — the top of fast mode is genuinely hard,
as on real phones.

**3. Reverb tails (verified — no change needed).** Schroeder-fit RT60 vs spec and
ISI energy past the 512-sample (10.67 ms) CP:

| Preset | RT60 measured | RT60 spec | τ_rms | Energy beyond CP |
|---|---|---|---|---|
| small-room | 248 ms | 250 ms | 10.8 ms | 11.2% |
| living-room | 439 ms | 450 ms | 23.8 ms | 23.9% |
| hallway | 677 ms | 700 ms | 43.1 ms | **40.7%** |

All three presets exceed the CP in delay spread terms (τ_rms ≥ CP for all; hallway
puts 40.7% of RIR energy past the CP) — ISI genuinely occurs in every reverberant test.

**4. Nonlinearity (PROBLEM — was clamp-only; fixed).** Old: hard clamp only; a tone
below threshold passed with zero distortion. Added `nonlinearity` impairment:
y = x + a2·x² − a3·x³ (defaults a2 = 0.05, a3 = 0.1) applied at **2× oversampling**
with anti-alias filtering, so products above Nyquist are removed the way a mic's
anti-alias filter removes them — no fake folded tones. Measured, 10 kHz at 0.5 FS:
2nd harmonic at 20 kHz = **−37.9 dBc** (≈1.3% HD2, plausible for a driven phone
speaker); residual at 18 kHz (where the 30 kHz 3rd harmonic would alias) =
**−145 dBc** (30 kHz is above Nyquist and correctly removed). Audible-band noise
(8.5–11.5 kHz) leaks **+91.6 dB** into the 17–23 kHz quiet band vs the linear path.
Digital hard clip stays at 1× rate deliberately: clipping done in the digital TX
chain aliases in reality too.

**5. Worst-case difficulty guard (added).** New preset `worst-case-quiet` (clip −6 dBFS,
nonlinearity, phone speaker, hallway RIR, +50 ppm, AGC wander, 0 dB in-band SNR) and a
regression test: 19 kHz sine → tone-to-adjacent-noise ratio collapses **105.2 → 9.1 dB**;
drift measured **19000.950 Hz** (expected 19000.95); spurious energy at 17–18.5 kHz up
**+77 dB**; the unrestricted global spectral peak is a clip-alias intermod at
**9000.5 Hz**, not the transmitted tone. Any future change that cleans this channel
fails the test.

**Tests: 95/95 green** (10 new audit assertions).

---

## Phase 3 — Sync (2026-07-31)

**Delivered:** `linearChirp` (Tukey-tapered), `PreambleDetector` (streaming FFT
overlap-save, normalized correlation coefficient, energy-floored denominator,
refractory peak picking, quadratic sub-sample interpolation), `detectPreamble`,
`scripts/sync-sweep.ts` (curve generator, writes `artifacts/sync-sweep.csv`).

**Correlator choice: channel-matched template (receiver-side), not TX pre-emphasis.**
Pre-emphasis was rejected because flattening the received spectrum would need +15…30 dB
of boost at the top of the band — impossible within digital full scale without
sacrificing total radiated energy, and outright unrealizable for quiet mode
(≥28 dB at 23 kHz). PHAT whitening was rejected because dividing by magnitude
amplifies noise exactly in the transducer's dead bands at low SNR.

**Measured A/B, raw vs matched template (noiseless, PSR = peak vs max |corr| outside
±16 samples within ±8192):**

| Metric | Raw template | Matched template |
|---|---|---|
| Fast mode PSR | 33.22 dB | 32.72 dB |
| Fast mode peak corr | 0.962 | 1.000 |
| Quiet mode PSR | **15.66 dB** | **10.35 dB** |
| Quiet mode peak corr | 0.837 | 1.000 |
| Quiet det. @ −3 dB hallway (60 runs) | 52/60 | **60/60** |
| Quiet det. @ −6 dB hallway (60 runs) | 36/60 | **53/60** |
| Quiet timing P95 (detected runs) | 2.6 samples | 5.4 samples |

Honest finding: the matched template *worsens* PSR in quiet mode (it concentrates
weight at the strong band edge, shrinking effective bandwidth), but wins where it
matters — detection at breakdown SNR (+17 percentage points at −6 dB) — and its peak
correlation is calibrated to 1.0, making the detection threshold meaningful. Timing
cost (P95 5.4 vs 2.6 samples) is far inside the 8-sample budget. Matched is the default.

**Detection/timing curves — fast mode, 200 seeded runs/point, ALL impairments
simultaneously (random offset [0, 48000], +50 ppm drift, AGC wander, nonlinearity,
phone speaker, in-band AWGN):**

| SNR (dB) | small-room det% / P95 | living-room det% / P95 | hallway det% / P95 |
|---|---|---|---|
| −12.5 | 89.5 / 0.19 | 83.0 / 0.19 | 76.5 / 0.19 |
| −10 | **100 / 0.18** | **100 / 0.18** | 90.5 / 0.18 |
| −7.5 | 100 / 0.17 | 100 / 0.17 | **100 / 0.18** |
| −5 | 100 / 0.17 | 100 / 0.17 | 100 / 0.18 |
| 0 | 100 / 0.17 | 100 / 0.18 | 100 / 0.17 |
| +5…+20 | 100 / 0.17 | 100 / 0.17 | 100 / 0.17 |

(Median |err| 0.07–0.11 samples throughout; detection is threshold-limited, not
timing-limited. The 85 ms × 18 kHz chirp has ≈32 dB of correlation processing gain,
which is why breakdown sits near −12 dB in-band.)

**Breakdown SNRs (<99% detection):** small-room −12.5 dB · living-room −12.5 dB ·
hallway between −10 and −7.5 dB.

**Regression operating points (pinned in `tests/modem/sync.test.ts`, 100 runs each):**
small-room & living-room at **−7.5 dB** (breakdown + 5 dB), hallway at **−5 dB**
(last fully-clean point + 2.5 dB). Thresholds: detection ≥ 99%, median ≤ 0.5,
P95 ≤ 2 samples (measured 0.17–0.19; ~10× headroom, ≪ the 8-sample Phase 4 budget).

**Hallway timing did NOT smear** despite 40.7% of RIR energy past the CP: with
DRR = 0 dB the direct path remains the strongest single coherent component, so the
correlation peak stays sharp. The predicted ≤ 8-sample risk did not materialize —
no threshold loosening was needed.

**Worst-case-quiet failure curve (100 runs/point):** 0 dB **100%** · −3 dB **96%** ·
−6 dB **74%** · −9 dB **43%** · −12 dB **3%**. Sync at the preset's 0 dB point
*succeeds* (the quiet-band chirp still has ≈27 dB of correlation gain); true failure
onset is just below −3 dB. Pinned two-sided at −9 dB (must stay in 15–70%) so an
accidentally-optimistic channel change trips the test.

**Detector hardening found by testing:** near-digital-silence windows after a burst
caused 0/0 correlation spikes (spurious detections). Fixed with an energy floor at
−30 dB below the loudest window seen. False-alarm test: 60 s of noise + 40 music-like
bursts ⇒ **0 detections**.

**Tests: 104/104 green.**

*Next: Phase 4 — OFDM modem core.*

---

## Phase 3 addendum — ground-truth definition under multipath (audit answer)

Ground-truth arrival time is **independent of the detector and of the channel
output**: the harness prepends a known `offset` of silence (drawn from the test's own
seeded RNG) and computes truth = `offset / (1 + ppm·1e-6)` — arithmetic on
construction parameters, never a peak search on the received waveform. `makeRir`
places the direct-path tap at lag 0 by construction and the speaker FIR is
group-delay-compensated, so "direct path arrives at `offset`" holds exactly through
the chain; detector bias toward reflections would appear AS error, not be hidden.
Caveat: our presets all have DRR ≥ 0 dB, so the real-hardware failure mode of locking
onto a dominant early reflection (DRR < 0 situations) is outside the simulated range.

---

## Phase 4 — OFDM modem core (2026-07-31)

**Delivered:** Gray mapping + CSI-weighted max-log soft demapping (BPSK/QPSK/16-QAM),
pilot/training PN sequences, `OfdmModulator` (burst synthesis, PAPR-headroomed),
LS channel estimation with T1→T2 drift pre-fit, `PilotTracker` (per-symbol CPE +
timing slope + gain wander), `OfdmDemodulator` with window slipping AND two-pass
sample-clock drift correction, `scripts/ber-sweep.ts` (CSV artifacts).

**Two implementation findings (both fixed and pinned by tests):**

1. **Simulator resampler artifact.** The Phase 2 cubic-Lagrange interpolator added
   −17.5 dB of interpolation error at 20 kHz (0.42·fs): drift-only EVM measured
   13.4% when physical clock drift should add ≈0. Replaced with a 32-tap
   Kaiser-windowed-sinc polyphase interpolator (1024 phases, fc = Nyquist so
   ratio→1 is the exact identity). Drift-only EVM fell to 7.0% (remaining part =
   genuine ICI, see below).
2. **Within-symbol ICI from drift.** Window slipping fixes inter-symbol timing but
   at +50 ppm the top carrier sits 1.0 Hz off its bin (4.3% of the 23.4 Hz spacing)
   ⇒ ≈ −23 dB self-noise. Added two-pass correction: pilot-slope drift-rate fit over
   the first 24 symbols → resample the burst by 1/(1+ε̂) → re-demodulate.
   Measured ε̂ accuracy: **50.1 ppm for a true 50 ppm** (0.2% error).

**(a) Flat-AWGN BER vs textbook (implementation-correctness, 175k–350k bits/point):**

| Mod | SNR | Measured | Theory | Impl. loss |
|---|---|---|---|---|
| BPSK | 4 dB | 1.29e-2 | 1.25e-2 | ≈ 0.1 dB |
| BPSK | 8 dB | 1.14e-4 | 1.91e-4 | < 0 (statistical) |
| QPSK | 7 dB | 2.05e-2 | 1.26e-2 | ≈ 1.0 dB |
| QPSK | 11 dB | 5.55e-4 | 1.94e-4 | ≈ 1.3 dB |
| 16-QAM | 14 dB | 1.68e-2 | 9.38e-3 | ≈ 1.0 dB |
| 16-QAM | 18 dB | 6.72e-4 | 1.43e-4 | ≈ 1.5 dB |

All within the 3 dB acceptance bound (losses = channel-estimation noise from 2
training symbols + pilot power overhead). Full curves: `artifacts/ber-flat.csv`.

**(b) Per-subcarrier-group uncoded BER (8 groups, 3 bursts each, drift 30 ppm +
AGC + phone speaker; groups g1…g8 = 2.0–4.3–6.5–8.8–11.0–13.3–15.5–17.8–20.0 kHz):**

*small-room @ 20 dB in-band:*

| Mod | g1 | g2 | g3 | g4 | g5 | g6 | g7 | g8 |
|---|---|---|---|---|---|---|---|---|
| BPSK | 1.1e-3 | 4.9e-3 | 3.8e-3 | 2.8e-3 | 4.2e-3 | 2.5e-3 | 8.2e-3 | 3.7e-2 |
| QPSK | 9.9e-3 | 1.5e-2 | 1.3e-2 | 1.2e-2 | 2.3e-2 | 1.5e-2 | 2.8e-2 | **1.0e-1** |
| 16-QAM | **7.0e-2** | **9.2e-2** | **8.5e-2** | **8.2e-2** | **1.1e-1** | **9.2e-2** | **1.3e-1** | **2.2e-1** |

*living-room @ 20 dB in-band:*

| Mod | g1 | g2 | g3 | g4 | g5 | g6 | g7 | g8 |
|---|---|---|---|---|---|---|---|---|
| BPSK | 2.1e-2 | 2.4e-2 | 1.9e-2 | 3.1e-2 | 3.3e-2 | 3.6e-2 | 3.9e-2 | **6.8e-2** |
| QPSK | **5.7e-2** | **6.6e-2** | **5.8e-2** | **7.2e-2** | **8.3e-2** | **8.3e-2** | **9.2e-2** | **1.4e-1** |
| 16-QAM | **1.7e-1** | **1.9e-1** | **1.7e-1** | **1.8e-1** | **2.0e-1** | **2.0e-1** | **2.2e-1** | **2.7e-1** |

**Unusable carriers (uncoded BER > 5×10⁻², bold above) — the Phase 7 baseline:**
- **Group 8 (17.8–20 kHz) is unusable at every modulation on every preset** —
  the transducer roll-off (15–19 dB down) kills it. Phase 7 must drop or BPSK it.
- 16-QAM is unusable in ALL groups uncoded on both presets — reverb-limited, not
  noise-limited (living-room pure-ISI floor measured at 5.8e-2 QPSK with no AWGN;
  SIR ≈ 6–7 dB from 23.9% of RIR energy beyond the CP). 16-QAM only becomes viable
  with the inner FEC + (Phase 7) per-carrier loading on low-reverb channels.
- Living-room QPSK sits at 5.7–9.2e-2 across the band — above 5e-2 uncoded but
  squarely in rate-1/2 soft-Viterbi territory (Phase 5 will measure post-FEC).

**Long-transmission drift test (200 data symbols = 10.67 s, single burst, no re-sync,
flat + AGC wander):**

| Run | corrected ε̂ | First-second BER / EVM | Last-second BER / EVM | slips |
|---|---|---|---|---|
| QPSK @ 20 dB, +50 ppm | +50.1 ppm | 0 / 13.6% | 0 / 14.2% | 0 |
| 16-QAM @ 25 dB, +50 ppm | +50.1 ppm | 0 / 7.6% | 0 / 8.0% | 0 |
| 16-QAM @ 25 dB, −50 ppm | −50.1 ppm | 0 / 7.5% | 0 / 7.9% | 0 |
| 16-QAM +50 ppm, correction OFF | — | BER 9.2e-6 EVM 10.4% | EVM 10.5% | −26 |

**16-QAM is sustainable indefinitely at ±50 ppm** with two-pass correction (EVM
grows only 0.4 points over 10.7 s; the correction gap — 7.9% vs 10.4% EVM — is
pinned by a regression test). No maximum-duration limit was reached.

**Tests: 123/123 green.**

*Next: Phase 5 — Framing + LT fountain code.*

---

## Phase 5 — Framing + LT fountain code (2026-07-31)

**Delivered:** CRC-16/32, rate-1/2 K=7 conv + soft Viterbi, mandatory bit
interleaver (across subcarriers **and** OFDM symbols), BPSK header region with
3× repetition (independent of payload mod), frame geometry helpers, LT encoder/
decoder (peeling + GF(2) GE fallback), `FileSender` / `FileReceiver`, per-symbol
modulation schedule on the OFDM modem. Carry-over: `'off-axis'` RIR preset.

### Off-axis observation preset (not an acceptance target)

| Preset | Spec DRR | Measured DRR | τ_rms |
|---|---|---|---|
| off-axis | −3 dB | **−3.00 dB** | 33.4 ms |

Dominant-early-reflection failure mode now exists in the simulator. Sync/modem
thresholds were **not** retuned against it.

### Frame geometry (whole OFDM symbols)

FAST_48K (683 data carriers), header always BPSK + rate-1/2 + 3× rep:

| Payload mod | Hdr sym | Pay sym | Total | Bytes/frame | Frames/burst (32 sym) |
|---|---|---|---|---|---|
| BPSK | 2 | 7 | 9 | 256 | 3 |
| QPSK | 2 | 4 | **6** | 256 | **5** |
| 16-QAM | 2 | 2 | 4 | 256 | 8 |

QUIET_48K (228 carriers, QPSK): 6 + 10 = **16** symbols/frame, 2 frames/burst.

### Interleave A/B (same channel)

small-room @ 12 dB in-band, phone speaker, 30 ppm drift, AGC, 40 frames:

| Interleaving | Frame success |
|---|---|
| **ON** | **33/40 (82.5%)** |
| OFF | **0/40 (0.0%)** |

(Living-room @ 20 dB is ISI-limited — both ON and OFF near zero — so the A/B
uses small-room where Group-8 / frequency-selective fades dominate without the
reverb floor.)

### Header vs payload failure @ Phase 4 operating SNR (20 dB, QPSK payload)

30 single-frame trials each (phone + RIR + 30 ppm + nonlinearity):

| Preset | OK | Hdr fail | Pay fail |
|---|---|---|---|
| small-room | **29/30** | 1 | 0 |
| living-room | 0/30 | **0** | **30** |
| hallway | 0/30 | **0** | **30** |

BPSK+repetition headers survive on every room; QPSK payloads die on living-room/
hallway (ISI floor from energy beyond CP — Phase 4 caveat confirmed post-FEC).

### LT overhead ε (c = 0.05, δ = 0.05; ≥200 seeded runs)

Justification: Luby mid-range — modest average degree, δ=0.05 theoretical
peeling-failure target; GE fallback covers residual stalls. For small K,
`R = c·ln(K/δ)·√K` is clamped to ≥1 (robust spike weak).

K = fileSize / 256-byte blocks:

| K | File | Success | Mean ε | P95 ε | Worst ε |
|---|---|---|---|---|---|
| 4 | 1 KiB | 200/200 | **0.585** | 1.75 | 3.25 |
| 40 | 10 KiB | 200/200 | **0.070** | 0.225 | 0.275 |
| 391 | ≈100 kB | 200/200 | **0.008** | 0.018 | 0.026 |

**Small-K tradeoff:** mean ε at K=4 is **58% ≫ 15%** target. Not tuned away —
short transfers pay fountain overhead; K≥40 meets the 15% mean bar with margin
(K=391 mean 0.8%).

### Acceptance

- **100 kB @ 20% random frame loss:** reconstructed (SHA-256 match) in 97 bursts;
  empirical loss 19.0%; 393 packets accepted.
- **Full pipeline @ Phase 4 20 dB operating point** (phone + RIR + drift + AGC +
  nonlinearity), 10 kB file (K=40):

| Preset | Result | Bursts | Goodput | Hdr fail | Pay fail | OK frames |
|---|---|---|---|---|---|---|
| small-room | ✅ SHA match | 9 | **4669 bit/s** | 0 | 1 | 44 |
| living-room | ✅ SHA match | 243 | **173 bit/s** | 5 | 1166 | 44 |
| hallway | ❌ ISI floor | 20 (probe) | — | 0 | 100 | **0** |

Living-room closes only because the fountain absorbs ~96% frame loss (headers
still decode). Hallway yields zero QPSK payload successes even at 30 dB — Phase 7
must drop/BPSK the dead carriers / handle the 41% beyond-CP energy. Off-axis was
not used for acceptance.

**Tests: 153/153 green.**

*Next: Phase 6 — End-to-end product.*

---

## Pre-Phase-6: ROBUST preset (2026-08-03)

Living-room QPSK payloads at 0/30 meant no usable default for ordinary
reverberant rooms (173 bit/s of fountain brute force is not a product).
Added `ROBUST_48K`: BPSK payloads, same BPSK×3 headers, same interleaving —
one preset, not adaptation. Geometry: 2+7 = 9 symbols/frame, 3 frames/burst.

**Measured (25 bursts each, phone speaker + 30 ppm + AGC + nonlinearity):**

| Preset | Channel | SNR | Frame success | Net throughput |
|---|---|---|---|---|
| ROBUST (BPSK) | living-room | 12 dB | **16.0%** | **516 bit/s** |
| ROBUST (BPSK) | living-room | 20 dB | **65.3%** | **2108 bit/s** |
| ROBUST (BPSK) | hallway | 12 dB | 0.0% | 0 |
| ROBUST (BPSK) | hallway | 20 dB | 0.0% | 0 |
| FAST (QPSK) | living-room | 12 dB | 0.0% | 0 |
| FAST (QPSK) | living-room | 20 dB | 0.0%* | ~173 bit/s via fountain |
| FAST (QPSK) | hallway | 12/20 dB | 0.0% | 0 |

*FAST living-room measured 4–5% over longer runs (Phase 5); 0/125 here is the
same floor with fewer trials.

End-to-end: ROBUST delivers 20 kB over living-room @ 20 dB in 40 bursts
(76 s, **2101 bit/s**), SHA-256 verified — 12× the QPSK fountain path.
**Hallway remains closed at any tested setting** (~10–11% raw BER exceeds
rate-1/2 K=7 correction) — that stays a Phase 7 (bit-loading / band-drop) item,
not papered over here.

---

## Phase 6 — End-to-end product (2026-08-03)

**Delivered:** streaming link layer (`src/link/stream.ts`) with
phase-continuous fractional resampling at the audio boundary
(`StreamResampler`); real send/receive UI wired to AudioWorklets; TESTING.md
hardware protocol. All DSP remains pure and Node-tested.

### Real-hardware requirements (as implemented)

1. **No 48 kHz assumption.** The modem always runs at `cfg.sampleRate`; the
   actual `AudioContext.sampleRate` is read back and displayed on both ends.
   TX resamples modem→device, RX resamples device→modem. **Cross-rate tests
   pass both directions** (sender device 44.1 kHz ↔ receiver device 48 kHz),
   proving a rate mismatch no longer presents as unexplained drift.
2. **Raw audio verified, not requested.** `track.getSettings()` is read after
   `getUserMedia`; the UI prints the actual EC/NS/AGC values and shows an
   explicit warning when the platform kept processing on.
3. **iOS constraints.** AudioContext created only inside tap handlers; screen
   wake lock held during transfers (re-acquired on visibilitychange); Safari
   rows are mandatory in the TESTING.md device matrix. (Safari testing itself
   requires hardware — protocol row, not a sim result.)
4. **TX level control.** Volume slider (master GainNode) on the sender;
   receiver shows a clipping indicator (fraction of |x| ≥ 0.985 over 1 s,
   verified by test: overdriven capture → >20% clip flagged, clean −10 dBFS
   capture → 0%) plus recent-peak readout.
5. **Diagnostics live during transfers:** spectrogram, per-subcarrier SNR bars,
   equalized constellation, block grid, frame counters, corrected-drift ppm.

### Streaming-layer measurements (Node, seeded)

| Case | Result |
|---|---|
| 5 kB small-room @ 20 dB, random 128–2176-sample chunks | ✓ 6 bursts, SHA match |
| Cross-rate 44.1 kHz TX device → 48 kHz RX device | ✓ 3 bursts, SHA match |
| Cross-rate 48 kHz TX device → 44.1 kHz RX device | ✓ SHA match |
| ROBUST 3 kB living-room @ 20 dB streaming | ✓ 16 bursts, SHA match |
| StreamResampler vs whole-buffer reference | max err < 1e-3, tone 1000.0 Hz preserved |
| Overdriven capture clip detection | 30%-railed input → clipFraction > 0.2 |

### Quiet-mode link-budget verdict (phone speaker model, small-room)

| Payload | 20 dB | 25 dB | 30 dB |
|---|---|---|---|
| QPSK (default) | ✗ (0 frames ok, headers fine) | ✓ closes (8 ok/16 bursts) | ✓ (5 ok/9) |
| BPSK | ✓ closes (4 ok/21 bursts) | ✓ (9 ok/21) | ✓ (9 ok/21) |

Quiet mode is viable through the modeled transducer roll-off only at
**≥25 dB in-band (QPSK)** or **≥20 dB (BPSK payloads)** — expect it to be the
most fragile mode on hardware; the diagnostics exist to confirm which carriers
die. (Band truncation to 17–20.5 kHz breaks frame-per-burst fit — Phase 7.)

### Acceptance status

Code + simulator gates: **complete** (all tests green). The TESTING.md results
table requires a physical phone-to-phone session that a cloud agent cannot
perform — the matrix (3 modes × 0.3 m/1 m × 3 tries, device models, room type,
wall-clock, effective bit/s) is ready to fill, with simulator predictions
listed for comparison. **Phase 6 acceptance is pending that human run.**
