# AeroModem — Build Plan

Browser-based, zero-install, phone-to-phone file transfer over sound. Pure static web app
(Vanilla TypeScript + Vite), all DSP in the browser, fountain-coded link layer, OFDM physical
layer. Targets: **≥ 5 kbit/s sustained goodput in audible fast mode (≈2–20 kHz)** and
**≥ 2 kbit/s in near-ultrasonic quiet mode (≈17–23 kHz)** at 0.5–1 m, with reproducible
measurements to back the claim.

This document is the living build plan. It is updated at the end of every phase.
Status legend: ⬜ not started · 🟨 in progress · ✅ done.

| Phase | Name | Status |
|---|---|---|
| 0 | Scaffold | ✅ |
| 1 | Audio plumbing + visualizer | ✅ |
| 2 | Channel simulator | ⬜ |
| 3 | Sync (chirp preamble) | ⬜ |
| 4 | OFDM modem core | ⬜ |
| 5 | Framing + LT fountain code | ⬜ |
| 6 | End-to-end product | ⬜ |
| 7 | Adaptation (bit-loading) | ⬜ |
| 8 | Benchmark & writeup | ⬜ |

---

## 1. Design decisions and deviations from the brief

The brief's system design is sound. I adopt it with the following clarifications and two
small deviations, each justified below.

### 1.1 OFDM numerology: keep FFT 2048 / CP 512, but make CP sweepable

**Delay-spread math.** At 0.5–1 m transmitter–receiver distance in a typical room
(RT60 ≈ 0.3–0.6 s), the channel is dominated by the direct path: the critical distance
(where direct and reverberant energy are equal) in a living room is roughly 0.5–1 m, so at
arm's length the direct-to-reverberant ratio is ≥ 0 dB. What the cyclic prefix must absorb
is the *strong early reflections* — floor, tabletop, nearby walls. A reflection with 1–3.5 m
of excess path arrives 3–10 ms after the direct sound. CP = 512 samples at 48 kHz = **10.67 ms**,
which covers all first-order reflections at these geometries.

The reverb tail beyond the CP is not zero: with RT60 = 0.5 s the tail decays 60 dB / 500 ms
= 0.12 dB/ms, so energy arriving after 10.67 ms is only ~1.3 dB down *relative to the start
of the tail* — but the tail as a whole sits 10–20 dB below the direct path at ≤ 1 m. Net
effect: residual ISI puts an effective SINR ceiling of roughly **15–25 dB** on the channel.
That is comfortable for QPSK (needs ~10 dB for BER 1e-3 uncoded), marginal for 16-QAM
(~17 dB) — which is precisely what Phase 7 per-subcarrier bit-loading addresses. No change
to symbol sizes is warranted; instead:

- CP length is a `ModemConfig` field and the Phase 8 bench sweeps CP ∈ {256, 384, 512} to
  quantify the throughput/robustness trade (CP 512 costs 20% of airtime: 512/2560).
- FFT 2048 gives subcarrier spacing 48000/2048 = **23.4375 Hz** and symbol rate
  48000/2560 = **18.75 sym/s**. Spacing ≫ residual CFO after tracking (< 1 Hz), and the
  42.7 ms useful symbol is long enough that CP overhead stays reasonable. Larger FFT (4096)
  would halve CP overhead but doubles latency, halves pilot tracking rate, and makes the
  system more sensitive to clock drift within a symbol. Keep 2048.

### 1.2 Inner FEC: convolutional (K=7, rate 1/2, punctured) with soft-decision Viterbi — not Reed–Solomon

Justification:

- The OFDM demapper produces **soft LLRs** weighted by per-subcarrier channel gain. A
  convolutional code with soft-decision Viterbi captures ~2 dB of gain from that soft
  information; Reed–Solomon is a hard-decision code and would throw it away.
- On a frequency-selective channel, errors cluster on faded subcarriers. RS handles bursts
  well, but a **frequency/bit interleaver** in front of the convolutional code disperses
  them just as effectively (this is exactly the 802.11a/DAB design, proven for OFDM).
- Implementation cost is small and testable: 64-state Viterbi over `Float32Array` LLRs,
  ~150 lines. RS over GF(256) with soft input would be substantially more code for less gain.
- Residual frame errors after Viterbi are caught by the CRC-32 and rendered harmless by the
  fountain code, so we do not need RS's guaranteed correction radius.

Code: industry-standard K=7, generators (133, 171) octal, rate 1/2, with optional
puncturing to 2/3 and 3/4 for Phase 7 bit-loading experiments. Tail-biting is avoided for
simplicity; each frame is terminated with 6 zero tail bits (overhead < 0.3%).

### 1.3 LT decoder: peeling + on-stall Gaussian elimination (inactivation)

A pure peeling (belief-propagation) decoder on a robust-soliton LT code needs ε ≈ 10–20%
overhead for K in the hundreds, and has high variance. Adding a **Gaussian-elimination
fallback** when peeling stalls (solve the remaining small dense system over GF(2)) cuts
average overhead to ε ≈ 3–8% at negligible cost for K ≤ 4096. The Phase 5 acceptance bar
(ε ≤ 15% mean over 100 seeded runs) is met with margin, and the bench reports the actual
distribution.

### 1.4 Burst structure (clarification, not deviation)

A fountain code only "feels magical" if a receiver can start listening at any moment. A
single preamble at t=0 would forbid late join and let clock drift accumulate unboundedly
(50 ppm = 2.4 samples/s = 144 samples/min — many times the CP). Therefore the transmission
is organized as an endless sequence of **bursts**:

```
burst := [ chirp preamble | 2 training symbols | M data symbols ]   (repeats forever)
```

M ≈ 32 data symbols ⇒ burst ≈ 2.0 s, re-sync overhead ≈ 8–10% of airtime (included in all
throughput budgets below). Each burst is self-contained: a receiver that hears any burst
from the middle of a transfer can demodulate it, and every frame header carries everything
needed to join the fountain decode.

### 1.5 Sample-rate reality on phones (risk handled by design)

`AudioContext.sampleRate` is 48000 on most Android devices but can be 44100 on some
iOS/macOS configurations. All DSP is parameterized by `ModemConfig.sampleRate`; the app
ships two derived profiles (48 kHz canonical, 44.1 kHz fallback with rescaled band edges
and bin indices) and **both ends display the active profile** so users can confirm they
match. Cross-rate operation (one phone at 44.1 k, one at 48 k) is out of scope for v1 and
documented in `TESTING.md`; the simulator's ±50 ppm drift model covers same-nominal-rate
mismatch, which pilots track continuously.

---

## 2. Numerology and link budget (the math the targets rest on)

Sample rate 48 kHz, FFT N = 2048, CP = 512 ⇒ symbol = 2560 samples = 53.33 ms,
R_sym = 18.75 sym/s. Subcarrier spacing Δf = 23.4375 Hz.

**Fast mode (2–20 kHz):** bins 86…853 ⇒ 768 active carriers. Comb pilots 1-per-9 carriers
⇒ 85 pilots + 683 data carriers.

- QPSK, rate-1/2: 683 × 2 × 18.75 × 1/2 = **12.8 kbit/s** coded-payload rate.
- Minus burst overhead (~9%), frame headers (28 B per 256 B payload ⇒ ~10%), and LT
  overhead ε ≈ 8%: **goodput ≈ 9.5 kbit/s** — ~1.9× the 5 kbit/s target. 16-QAM
  bit-loading on strong carriers (Phase 7) pushes this further.

**Quiet mode (17–23 kHz):** bins 726…981 ⇒ 256 carriers ⇒ 228 data + 28 pilots.
Real phone speakers roll off steeply above ~21 kHz (modeled in the simulator), so upper
carriers will carry BPSK or be dropped by bit-loading.

- QPSK, rate-1/2 on ~200 usable carriers: 200 × 2 × 18.75 × 1/2 = 3.75 kbit/s coded;
  after overheads **goodput ≈ 2.8 kbit/s** — ~1.4× the 2 kbit/s target. Rate-2/3
  puncturing on good carriers provides margin.

These budgets are recomputed by the bench harness from live `ModemConfig` values so the
plan and the code cannot drift apart.

---

## 3. Repository layout

```
aeromodem/
├── index.html                  # app shell (role selection → send / receive)
├── bench.html                  # hidden /bench page (second Vite entry point)
├── package.json  vite.config.ts  tsconfig.json  vitest.config.ts
├── PLAN.md  PROGRESS.md  TESTING.md  RESULTS.md
├── public/                     # static assets only (favicon); no runtime fetches of data
├── src/
│   ├── config.ts               # ModemConfig type + presets (THE single source of magic numbers)
│   ├── util/
│   │   ├── prng.ts             # seedable PRNG (splitmix32) — all randomness flows through this
│   │   ├── bits.ts             # bit packing/unpacking helpers
│   │   └── assert.ts
│   ├── dsp/                    # pure functions on Float32Array — no Web Audio types allowed
│   │   ├── fft.ts              # hand-rolled radix-2 FFT (precomputed twiddles), real-FFT wrapper
│   │   ├── window.ts           # Hann etc.
│   │   ├── filters.ts          # biquad cascades, FIR design (windowed sinc), filtfilt
│   │   ├── resample.ts         # polyphase/Lagrange fractional resampler (drift model + correction)
│   │   ├── chirp.ts            # linear chirp generation
│   │   └── measure.ts          # SNR/power/BER measurement helpers used by tests & bench
│   ├── channel/
│   │   ├── simulator.ts        # simulateChannel(samples, opts) — composable impairments
│   │   ├── rir.ts              # synthetic room impulse response presets
│   │   └── presets.ts          # named ChannelOpts presets ("clean", "living-room", "hallway", …)
│   ├── modem/
│   │   ├── mapping.ts          # BPSK/QPSK/16QAM Gray map + max-log soft demap (LLRs)
│   │   ├── pilots.ts           # comb pilot layout + pilot symbol values (seeded PN)
│   │   ├── ofdmMod.ts          # bits → OFDM time-domain samples (per burst)
│   │   ├── ofdmDemod.ts        # samples → LLRs (uses sync, chanest, tracking)
│   │   ├── sync.ts             # chirp preamble + matched filter + timing estimator
│   │   ├── chanest.ts          # LS channel estimation on training symbols + pilot interpolation
│   │   ├── tracking.ts         # per-symbol CPE/SFO tracking from pilots, timing correction
│   │   └── modem.ts            # Modulator/Demodulator façade wiring the above
│   ├── code/
│   │   ├── crc32.ts
│   │   ├── convolutional.ts    # K=7 (133,171) encoder + puncturing
│   │   ├── viterbi.ts          # soft-decision Viterbi decoder
│   │   ├── interleave.ts       # block bit interleaver (frame ↔ subcarriers)
│   │   ├── soliton.ts          # robust soliton degree distribution (seeded)
│   │   ├── lt.ts               # LT encoder + peeling/GE decoder
│   │   └── frame.ts            # frame header ser/de + frame assembly/parse
│   ├── link/
│   │   ├── sender.ts           # file → endless frame stream → sample stream
│   │   └── receiver.ts         # sample stream → frames → LT decode → file + hash
│   ├── audio/                  # ONLY place Web Audio API types appear
│   │   ├── context.ts          # AudioContext setup, raw-audio mic constraints
│   │   ├── playbackWorklet.ts  # AudioWorkletProcessor: ring-buffer player
│   │   ├── captureWorklet.ts   # AudioWorkletProcessor: mic → ring buffer → main thread
│   │   └── ring.ts             # SharedArrayBuffer-free ring buffer (postMessage chunks)
│   ├── ui/
│   │   ├── app.ts              # role selection, page wiring (hand-rolled, no framework)
│   │   ├── spectrogram.ts      # Canvas waterfall
│   │   ├── snrBars.ts  constellation.ts  blockGrid.ts  progress.ts
│   │   └── style.css
│   └── bench/
│       ├── bench.ts            # /bench page controller
│       ├── sweeps.ts           # parameter sweep definitions & runner (Web Worker in browser, direct in Node)
│       ├── csv.ts              # CSV import/export
│       └── plots.ts            # Canvas line plots (BER vs SNR, throughput curves)
├── tests/                      # Vitest, runs in Node — mirrors src/ structure
│   ├── dsp/  channel/  modem/  code/  link/  bench/
│   └── fixtures/               # seeded reference vectors (small, generated, checked in)
└── scripts/
    └── bench-node.ts           # run the same sweeps from CLI, write CSV artifacts
```

Rule enforced by convention and by a lint test: **nothing under `src/dsp`, `src/channel`,
`src/modem`, `src/code`, `src/link`, `src/bench` may import from `src/audio` or `src/ui`,
or reference `AudioContext`/`window`.** The identical code runs in Vitest (Node), the
simulator, and the browser.

---

## 4. `ModemConfig` — single source of parameters

```ts
// src/config.ts
export type Modulation = 'bpsk' | 'qpsk' | 'qam16';

export interface ModemConfig {
  // clocking
  sampleRate: 48000 | 44100;

  // OFDM numerology
  fftSize: number;            // 2048
  cpLength: number;           // 512
  bandLowHz: number;          // fast: 2000, quiet: 17000
  bandHighHz: number;         // fast: 20000, quiet: 23000

  // pilots
  pilotSpacing: number;       // 9 → 1 pilot per 8 data carriers
  pilotSeed: number;          // seeds the pilot PN sequence
  pilotBoostDb: number;       // pilot power boost (e.g. 2.5 dB)

  // sync
  chirpLengthSamples: number; // 4096 (85 ms)
  chirpGuardSamples: number;  // silence after chirp before training
  trainingSymbols: number;    // 2
  dataSymbolsPerBurst: number;// 32

  // per-subcarrier modulation (Phase 7 bit-loading; uniform before that)
  bitLoading: Modulation[] | { uniform: Modulation };

  // inner FEC
  fecRate: '1/2' | '2/3' | '3/4';

  // framing / fountain
  blockSize: number;          // 256 bytes
  frameHeaderBytes: 24;
  ltSolitonC: number;         // 0.05
  ltSolitonDelta: number;     // 0.05

  // levels
  txAmplitude: number;        // 0..1 digital full scale, pre-limiter headroom
}

export const FAST_48K: ModemConfig;   // preset
export const QUIET_48K: ModemConfig;  // preset
export const FAST_44K1: ModemConfig;  // derived preset (rescaled bins)
export const QUIET_44K1: ModemConfig;

// Derived, computed (never hand-written): active bin range, pilot/data bin lists,
// bits per symbol, frames per burst, raw & net rate estimates.
export function derive(cfg: ModemConfig): DerivedConfig;
```

Every magic number in the system lives here or in `ChannelOpts` (simulator). Tests that
find numeric literals in DSP code that should be config are treated as bugs.

---

## 5. Frame and burst format

**Frame** (fixed size per config; fast-mode default payload 256 B):

```
| header 24 B | payload = blockSize B | CRC-32 4 B |   → conv-encode (+6 tail bits) → interleave → map to carriers
```

Header layout (little-endian, 24 bytes total):

| field | bytes | notes |
|---|---|---|
| magic | 4 | 'AMF1' |
| sessionId | 4 | random per transfer; receiver locks onto first session heard |
| fileLength | 4 | bytes |
| K | 2 | number of source blocks |
| blockSize | 2 | bytes |
| packetSeed | 4 | seeds soliton degree + neighbor selection for THIS packet |
| flags/mode | 2 | config profile id, FEC rate, reserved |
| headerCrc | 2 | CRC-16/CCITT over bytes 0–21 |

The header is additionally protected by being part of the conv-coded frame; `headerCrc`
lets the receiver reject a frame early. Full-frame CRC-32 (poly 0xEDB88320) is the final
arbiter; failures are silently dropped (fountain code absorbs the loss).

**Burst:** `chirp | guard | T1 T2 (training) | D1 … D32 (data symbols)`. Data symbols carry
a whole number of frames per burst; padding bits fill the remainder (accounted in budgets).

---

## 6. Phases

### Phase 0 — Scaffold

**Goal:** repo builds, tests run green in CI and locally, empty UI shell deploys to Pages.

**Files:** `package.json`, `vite.config.ts` (two entry points: `index.html`, `bench.html`;
`base` configurable for GitHub Pages), `tsconfig.json` (strict), `vitest.config.ts`,
`src/config.ts`, `src/util/prng.ts`, `src/util/assert.ts`, `src/ui/app.ts` (role-selection
shell, mode toggle fast/quiet — buttons wired to stubs), `.github/workflows/ci.yml`
(install, typecheck, test, build), `PROGRESS.md` (created).

**Key signatures:**

```ts
// util/prng.ts — the only PRNG in the codebase
export function splitmix32(seed: number): () => number;      // uniform [0,1)
export function gaussianPair(rng: () => number): [number, number]; // Box–Muller

// config.ts
export function derive(cfg: ModemConfig): DerivedConfig;
```

**Tests:** `tests/config.test.ts` — derived bin ranges for FAST_48K are 86…853 (768
carriers), QUIET_48K 726…981 (256); pilot/data partition counts match §2; rate estimator
returns > 5 kbit/s (fast) and > 2 kbit/s (quiet) net. `tests/util/prng.test.ts` — same
seed ⇒ same sequence; distribution sanity (mean/variance bounds).

**Accept:** `npm test` green in Node; `npm run build` produces a static bundle;
CI workflow passes.

**Status:** ✅ Done (2026-07-31). See `PROGRESS.md` for measured bin ranges and rate estimates
(FAST 9580.8 bit/s, QUIET 3198.3 bit/s net).

---

### Phase 1 — Audio plumbing + visualizer

**Goal:** real-time capture and playback via AudioWorklet with raw-audio constraints;
live spectrogram; tone generator.

**Files:** `src/audio/context.ts`, `src/audio/playbackWorklet.ts`,
`src/audio/captureWorklet.ts`, `src/audio/ring.ts`, `src/ui/spectrogram.ts`,
`src/dsp/fft.ts`, `src/dsp/window.ts`, plus a temporary "audio check" panel in the UI
(tone generator 100 Hz–23 kHz slider, mic level meter, spectrogram).

**Key signatures:**

```ts
// audio/context.ts
export async function createAudio(cfg: ModemConfig): Promise<AudioIO>;
export interface AudioIO {
  readonly actualSampleRate: number;                 // verify vs cfg, surface mismatch in UI
  play(samples: Float32Array): Promise<void>;        // queued into playback worklet ring
  onCapture(cb: (chunk: Float32Array) => void): void;// 128-sample worklet quanta, batched
  close(): Promise<void>;
}
// Mic constraints (non-negotiable): { echoCancellation:false, noiseSuppression:false,
//   autoGainControl:false, channelCount:1 } — asserted from the resolved track settings
//   and shown in the UI if the browser refused them.

// dsp/fft.ts — pure, allocation-free hot path
export class FFT {
  constructor(size: number);                          // power of 2
  forward(re: Float32Array, im: Float32Array): void;  // in-place
  inverse(re: Float32Array, im: Float32Array): void;  // in-place, 1/N normalized
}
export function realSpectrumDb(x: Float32Array, fft: FFT, win: Float32Array, out: Float32Array): void;

// ui/spectrogram.ts
export class Spectrogram {
  constructor(canvas: HTMLCanvasElement, cfg: ModemConfig);
  push(spectrumDb: Float32Array): void;               // one waterfall column
}
```

**Tests (Node, no audio):** `tests/dsp/fft.test.ts` — FFT vs direct-DFT reference for
sizes 8…2048 (max abs error < 1e-4 for Float32); Parseval; impulse/sine round-trips;
`inverse(forward(x)) ≈ x`. `tests/dsp/window.test.ts` — Hann coherent gain. Ring-buffer
unit tests (wrap-around, under/overflow accounting).

**Accept (manual, documented in PROGRESS.md):** on a laptop, a generated 19 kHz tone
played from one browser tab is clearly visible in a second tab's spectrogram; mic track
settings show all three processing flags false.

**Status:** ✅ Done (2026-07-31). Automated: 40/40 tests green (FFT vs DFT max err &lt; 1e-4,
Hann coherent gain ≈ 0.5, ring wrap/overflow, 19 kHz tone peak bin). Manual laptop
protocol recorded in `PROGRESS.md` Phase 1 — **requires a human run**.

---

### Phase 2 — Channel simulator

**Goal:** a pure, composable `simulateChannel` capturing every impairment we expect from
real phones, so every later feature is proven in software first.

**Files:** `src/channel/simulator.ts`, `src/channel/rir.ts`, `src/channel/presets.ts`,
`src/dsp/filters.ts`, `src/dsp/resample.ts`, `src/dsp/measure.ts`.

**Key signatures:**

```ts
// channel/simulator.ts
export interface ChannelOpts {
  seed: number;                       // drives ALL randomness below
  bandLimit?: { speakerModel: 'phone' | 'flat' };  // steep roll-off > ~21 kHz + HPF < ~200 Hz
  snrDb?: number;                     // AWGN measured against in-band signal power
  rir?: 'small-room' | 'living-room' | 'hallway' | Float32Array; // multipath convolution
  clockDriftPpm?: number;             // resample by (1 + ppm*1e-6)
  startOffsetSamples?: [min, max];    // random silence prepended
  clip?: { thresholdDbfs: number };   // hard/soft clipping nonlinearity
  agcRefusal?: boolean;               // slow gain wander, models a browser ignoring constraints
}
export function simulateChannel(samples: Float32Array, opts: ChannelOpts): Float32Array;

// channel/rir.ts — synthetic RIRs: direct path + N discrete early reflections with
// image-source-like delays + exponentially decaying noise tail at given RT60 & DRR.
export function makeRir(preset: string, seed: number, sampleRate: number): Float32Array;

// dsp/measure.ts
export function bandPowerDb(x: Float32Array, fs: number, lo: number, hi: number): number;
export function measureSnrDb(clean: Float32Array, noisy: Float32Array, fs: number, lo: number, hi: number): number;

// dsp/resample.ts
export function resampleFractional(x: Float32Array, ratio: number): Float32Array; // Lagrange-3, used for drift
```

Impairments are applied in fixed physical order: TX clip → speaker band-limit → RIR →
clock drift → AWGN → start offset. Every random draw comes from `splitmix32(opts.seed)`.

**Tests:** `tests/channel/simulator.test.ts` —
AWGN: measured in-band SNR within **±0.5 dB** of target across {0, 10, 20, 30} dB
(seeded, 10 trials each). Band-limit: 22.5 kHz probe attenuated ≥ 30 dB while 10 kHz
probe within 1 dB. RIR: delay spread of `makeRir` output matches preset spec (RMS delay
spread within tolerance); DRR within 2 dB of spec. Drift: a 10 kHz tone resampled at
+50 ppm measures 10000.5 Hz ± 0.1 Hz via FFT peak interpolation. Offset: output length
increases by draw within `[min,max]`. Clipping: THD of a sine rises above threshold vs
clean. Determinism: same seed ⇒ bit-identical output.

**Accept:** all impairment tests pass with the numeric tolerances above; `PROGRESS.md`
records measured-vs-target tables.

---

### Phase 3 — Sync

**Goal:** chirp preamble generation, matched-filter detection, sub-sample timing.

**Files:** `src/dsp/chirp.ts`, `src/modem/sync.ts`.

**Key signatures:**

```ts
// dsp/chirp.ts
export function linearChirp(fs: number, f0: number, f1: number, n: number, win?: Float32Array): Float32Array;

// modem/sync.ts
export class PreambleDetector {
  constructor(cfg: ModemConfig);      // precomputes chirp template FFT for overlap-save correlation
  /** Feed arbitrary-length capture chunks; emits detections. */
  push(chunk: Float32Array): Detection[];
}
export interface Detection {
  sampleIndex: number;    // start of training symbol 1 in the detector's absolute sample clock
  fracOffset: number;     // sub-sample refinement from quadratic peak interpolation
  peakToSidelobe: number; // detection quality metric (also drives UI "signal found" state)
  snrEstimateDb: number;
}
```

Detection = normalized cross-correlation (matched filter) computed with FFT overlap-save;
threshold on peak-to-RMS with a minimum peak-to-sidelobe ratio to reject false alarms from
speech/music. Timing = argmax + 3-point quadratic interpolation.

**Tests:** `tests/modem/sync.test.ts` — **500 seeded simulator runs** at SNR 10 dB with
`clockDriftPpm` uniform in ±50, random start offset in [0, 48000], `living-room` RIR:
detection rate ≥ 99%, |timing error| ≤ 8 samples (P100 among detections). False-alarm
test: 60 s of seeded noise + music-like signal (filtered noise bursts) produces 0
detections. Sweep test at {0, 5, 10, 20} dB records detection rate + timing RMS for
PROGRESS.md.

**Accept:** the 500-run test passes (≥ 99% detection, ≤ 8-sample error) as an automated
Vitest test.

---

### Phase 4 — OFDM modem core

**Goal:** bits ↔ sound. Modulator, demodulator, channel estimation, equalization,
pilot tracking, soft demapping — validated by BER curves through the simulator.

**Files:** `src/modem/mapping.ts`, `src/modem/pilots.ts`, `src/modem/ofdmMod.ts`,
`src/modem/ofdmDemod.ts`, `src/modem/chanest.ts`, `src/modem/tracking.ts`,
`src/modem/modem.ts`, plus `src/bench/sweeps.ts` (first real sweep: BER vs SNR).

**Key signatures:**

```ts
// modem/mapping.ts
export function mapBits(bits: Uint8Array, mod: Modulation, outRe: Float32Array, outIm: Float32Array): void;
/** Max-log LLRs, scaled by CSI weight |H|²/σ² so faded carriers contribute weak beliefs. */
export function softDemap(re: Float32Array, im: Float32Array, csiWeight: Float32Array,
                          mod: Modulation, outLlr: Float32Array): void;

// modem/ofdmMod.ts
export class OfdmModulator {
  constructor(cfg: ModemConfig);
  /** One burst: preamble + training + data symbols carrying `bits` (padded). Returns time samples. */
  modulateBurst(bits: Uint8Array): Float32Array;
}

// modem/chanest.ts
/** LS estimate Ĥ[k] = Y[k]/X[k] on the 2 training symbols (averaged), then
 *  per-symbol pilot re-estimation with linear interpolation across frequency. */
export function estimateChannel(trainRx: ComplexSpectra, cfg: ModemConfig): ChannelEstimate;

// modem/tracking.ts — per data symbol, from pilots:
//   common phase error (CPE)      → residual CFO correction (de-rotate all carriers)
//   phase slope vs bin index k    → timing drift; accumulate and slip samples when |Δ| > 0.5
export class PilotTracker {
  update(pilotRx: Complex[], symbolIndex: number): { cpeRad: number; timingErrSamples: number };
}

// modem/ofdmDemod.ts
export class OfdmDemodulator {
  constructor(cfg: ModemConfig);
  /** Consumes capture chunks; uses PreambleDetector; emits per-burst soft bits + diagnostics. */
  push(chunk: Float32Array): DemodEvent[];
}
export interface DemodEvent {
  kind: 'burst';
  llrs: Float32Array;                    // soft bits for the burst's data symbols
  perCarrierSnrDb: Float32Array;         // for UI bars + Phase 7
  constellation: { re: Float32Array; im: Float32Array }; // equalized symbols for UI
  cpeTrace: Float32Array; timingTrace: Float32Array;     // diagnostics
}
```

**Math documentation duty:** every buffer annotated with domain (time/frequency), units,
and index meaning; equalizer comment derives the one-tap model Y[k]=H[k]X[k]+W[k] and why
CP makes convolution circular. (Target reader: knows Fourier, not comms.)

**Tests:** `tests/modem/loopback.test.ts` — mod→demod with no channel: 0 bit errors, all
three modulations, both band presets. `tests/modem/ber.test.ts` — BER vs SNR through
`simulateChannel` (AWGN-only): for each modulation, measured uncoded BER at each SNR
within **3 dB** of the textbook AWGN curve (Q-function reference implemented in
`dsp/measure.ts`); with `living-room` RIR + drift ±30 ppm: QPSK BER < 1e-3 at 20 dB SNR.
`tests/modem/tracking.test.ts` — 60 s continuous stream at +50 ppm drift: residual
timing error stays < 0.5 sample throughout (i.e., tracking actually locks); with tracking
disabled the same test shows failure (guards against silent regression).
`scripts/bench-node.ts` emits `artifacts/ber-vs-snr.csv`.

**Accept:** BER curves within a few dB of textbook AWGN generated by the bench harness
(CSV + plotted on /bench); all tracking tests green.

---

### Phase 5 — Framing + LT fountain code

**Goal:** file → endless packet stream → file, robust to arbitrary frame loss.

**Files:** `src/code/crc32.ts`, `src/code/convolutional.ts`, `src/code/viterbi.ts`,
`src/code/interleave.ts`, `src/code/soliton.ts`, `src/code/lt.ts`, `src/code/frame.ts`,
`src/link/sender.ts`, `src/link/receiver.ts`.

**Key signatures:**

```ts
// code/soliton.ts
export function robustSolitonCdf(K: number, c: number, delta: number): Float64Array;
export function sampleDegree(cdf: Float64Array, rng: () => number): number;

// code/lt.ts
export class LtEncoder {
  constructor(source: Uint8Array, blockSize: number, sessionSeed: number, cfg: ModemConfig);
  readonly K: number;
  /** Deterministic packet for a given seed: degree + neighbor set from splitmix32(seed). */
  packet(packetSeed: number): Uint8Array;      // XOR of chosen source blocks
}
export class LtDecoder {
  constructor(fileLength: number, K: number, blockSize: number, cfg: ModemConfig);
  /** Peeling; on stall with ≥K packets, Gaussian elimination over the residual system. */
  addPacket(packetSeed: number, payload: Uint8Array): void;
  readonly decodedBlocks: number;              // for the UI block grid
  readonly complete: boolean;
  result(): Uint8Array | null;
}

// code/frame.ts
export function buildFrame(h: FrameHeader, payload: Uint8Array): Uint8Array;        // + CRC32
export function parseFrame(bytes: Uint8Array): { header: FrameHeader; payload: Uint8Array } | null; // null on CRC fail

// code/convolutional.ts / viterbi.ts
export function convEncode(bits: Uint8Array, rate: FecRate): Uint8Array;
export function viterbiDecode(llrs: Float32Array, rate: FecRate): Uint8Array;

// link/sender.ts
export class FileSender {
  constructor(file: Uint8Array, cfg: ModemConfig, sessionSeed: number);
  nextBurstBits(): Uint8Array;   // frames for one burst; endless (packetSeed increments)
  readonly packetsSent: number;
}
// link/receiver.ts
export class FileReceiver {
  constructor(cfg: ModemConfig);
  pushLlrs(llrs: Float32Array): void;          // deinterleave → viterbi → frames → LT
  readonly progress: ReceiveProgress;          // blocks decoded, frames ok/bad, session info
  onComplete(cb: (file: Uint8Array) => void): void;
}
```

**Tests:** `tests/code/crc32.test.ts`, `conv.test.ts` (encode/decode round-trip at
LLR-clean; coded BER at 4 dB Eb/N0 ≪ uncoded), `soliton.test.ts` (distribution matches
analytic PMF, chi-squared over 1e5 seeded draws), `lt.test.ts` — **100 seeded runs**,
K = 400 (100 kB / 256 B): decode success 100%, mean ε ≤ 15% (expect ~5–8% with GE
fallback; record distribution), any-order and duplicate-packet delivery.
`tests/link/e2e-loss.test.ts` — 100 kB seeded file through frame layer with **20% random
frame loss**: file reconstructed, SHA-256 matches. `tests/link/e2e-channel.test.ts` —
full stack (sender → modulator → `simulateChannel` @ 15 dB, living-room, drift →
demodulator → receiver): 20 kB file reconstructs; records airtime and goodput.

**Accept:** 100 kB survives 20% frame loss; mean ε ≤ 15% over 100 seeded runs (both as
automated tests); PROGRESS.md logs the measured ε distribution and full-stack goodput.

---

### Phase 6 — End-to-end product

**Goal:** the actual send/receive UI, wired to real audio, plus `TESTING.md`.

**Files:** `src/ui/app.ts` (finalized), `src/ui/snrBars.ts`, `src/ui/constellation.ts`,
`src/ui/blockGrid.ts`, `src/ui/progress.ts`, `src/link` glue to `src/audio`,
`TESTING.md`.

**Send flow:** pick file (≤ 1 MB enforced), pick mode (fast/quiet) → `FileSender`
produces burst bits → `OfdmModulator` → playback worklet loops forever until stopped;
UI: live TX spectrogram, packets-sent counter, estimated time for ε = 10%.

**Receive flow:** tap to listen (mic permission with raw constraints; refusal of the
constraints surfaced as a warning) → capture worklet → `OfdmDemodulator` →
`FileReceiver`; UI: live spectrogram, per-subcarrier SNR bars, constellation plot,
torrent-style block grid, frames-ok/frames-dropped counters; on completion: SHA-256
computed via WebCrypto, displayed with ✓, automatic download via object URL.

Demodulation runs off the audio thread (main thread or a Web Worker if profiling shows
> 30% of a 53 ms symbol budget; the DSP-purity rule makes moving it trivial).

**Tests:** UI logic tests where they pay off (state machine send/receive/idle, file-size
cap, hash display); the full DSP path is already covered by Phase 5 e2e tests. A
`tests/link/e2e-quiet.test.ts` runs the quiet-mode preset through the phone band-limit
simulator preset (speaker roll-off at 21 kHz active) to prove quiet mode closes the link
before hardware is touched.

**`TESTING.md` protocol:** device matrix (Android Chrome / iPhone Safari), placement
(0.5 m and arm's length, on a table), volume calibration step (play calibration tone,
adjust to ~80% volume), quiet room vs. background-noise cases, what to record per run
(file size, mode, time, retries, failure symptoms), and the rule: any hardware failure
gets reproduced in the simulator as a new `ChannelOpts` case + regression test before
being fixed.

**Accept:** manual protocol in `TESTING.md` executed and logged in PROGRESS.md: a 20 kB
file transfers phone-to-phone in **quiet mode at arm's length**. (Cloud-agent caveat: I
cannot perform the physical two-phone test myself; the protocol, all simulator gates, and
a laptop tab-to-tab loopback are delivered, with the phone table in PROGRESS.md left for
a human run to fill in.)

---

### Phase 7 — Adaptation (per-subcarrier bit-loading)

**Goal:** measure the channel, load bits where the SNR is, drop dead carriers.

**Files:** `src/modem/probe.ts` (wideband probe = repeated training symbols over the full
band), `src/modem/bitload.ts`, UI: "Measure channel" button on receive side showing
per-carrier SNR and a **recommended preset string** (compact base64 config blob) that the
human carries to the sender (no back-channel yet); sender accepts pasted/selected preset.

**Key signatures:**

```ts
// modem/bitload.ts
/** Greedy margin-based loading: per carrier choose OFF/BPSK/QPSK/16QAM from measured SNR
 *  against per-modulation SNR thresholds (from Phase 4 BER curves) + hysteresis margin. */
export function computeBitLoading(perCarrierSnrDb: Float32Array, cfg: ModemConfig,
                                  targetBerPostFec: number): Modulation[] /* + 'off' */;
export function encodeLoadingPreset(loading: Modulation[], cfg: ModemConfig): string;  // base64
export function decodeLoadingPreset(s: string): { loading: Modulation[]; cfgPatch: Partial<ModemConfig> };
```

Frame `flags/mode` field carries the loading-preset id so the receiver demaps correctly;
full loading vector is implied by the shared preset string (both ends must select it —
enforced by a checksum in the flags field).

**Future-work design (documented in PLAN.md §8 / RESULTS.md):** acoustic back-channel —
receiver transmits a short low-rate BPSK burst in a reserved sub-band (e.g. 1–2 kHz below
the data band) during sender listen-gaps between bursts; sender's existing mic + a second
`PreambleDetector` instance receives it. TDD schedule sketched, not built.

**Tests:** `tests/modem/bitload.test.ts` — on the band-limited simulator channel
(phone speaker model + living-room RIR at 20 dB), throughput with computed loading vs
uniform QPSK: **≥ 30% gain** (automated, seeded); dead carriers (> 21 kHz in quiet mode)
are all OFF; loading round-trips through preset encode/decode; post-FEC frame error rate
with loading ≤ uniform-QPSK baseline.

**Accept:** the ≥ 30% bench gain test passes; /bench renders the loading map and both
throughput bars.

---

### Phase 8 — Benchmark & writeup

**Goal:** /bench as a research instrument; `RESULTS.md` reproducible from CSV artifacts.

**Files:** `src/bench/bench.ts`, `src/bench/sweeps.ts` (finalized), `src/bench/csv.ts`,
`src/bench/plots.ts`, `scripts/bench-node.ts` (CI-runnable, writes `artifacts/*.csv`),
`RESULTS.md`.

**Sweeps (each N seeded trials, defaults N = 50):**

1. Throughput & frame-loss vs SNR (−5…30 dB), fast & quiet presets, each RIR preset.
2. Uncoded/coded BER vs SNR per modulation (extends Phase 4 CSV).
3. LT overhead ε distribution vs K ∈ {100, 400, 1600} and vs frame-loss rate.
4. CP sweep {256, 384, 512} × RIR presets (validates §1.1).
5. Bit-loading gain vs SNR (validates Phase 7 across conditions).
6. Live mode: /bench drives real speaker/mic loopback on one device or two, logging the
   same CSV schema — this fills the throughput-vs-distance table.

**`RESULTS.md` contents:** all plots regenerated from `artifacts/*.csv` by
`npm run bench:report`; throughput vs SNR; throughput vs distance (live table, filled
from hardware runs per TESTING.md); ε stats; comparison table vs published
ggwave (~140 bit/s typical, up to ~1 kbit/s modes) / Chirp / BatNet figures with citations;
**Shannon estimate**: from measured per-carrier SNR, C = Σ_k Δf·log2(1 + SNR_k) computed
by `dsp/measure.ts`, reported next to achieved goodput as % of capacity.

**Tests:** `tests/bench/csv.test.ts` (schema round-trip), `tests/bench/repro.test.ts` —
running sweep #1 twice with the same seed yields identical CSVs (byte-equal);
`npm run bench:report` regenerates RESULTS.md tables from CSV without manual edits
(checked by CI diff).

**Accept:** `RESULTS.md` fully reproducible from checked-in CSV artifacts via one command.

---

## 7. Engineering discipline (standing rules)

- **DSP purity:** `src/dsp`, `src/modem`, `src/code`, `src/channel`, `src/link`,
  `src/bench` are pure `Float32Array`-in/out TypeScript. An automated test greps their
  imports for `src/audio`, `src/ui`, `AudioContext`, `window`, `document` and fails on any hit.
- **Determinism:** every random draw goes through `splitmix32(seed)`; tests assert
  bit-identical reruns. No `Math.random()` anywhere (lint rule).
- **Per-phase exit checklist:** tests green → `PLAN.md` status table updated →
  `PROGRESS.md` entry with **numbers** (detection rates, BER points, ε stats, goodput),
  never adjectives.
- **Hardware-bug protocol:** reproduce in `ChannelOpts` first, add the failing seeded
  test, then fix.
- **Math comments:** every DSP function documents its buffers' domain (time/frequency),
  units, and index conventions, assuming a Fourier-literate, comms-naive reader.
- **Allocation discipline:** hot-path DSP (per-symbol) is allocation-free (preallocated
  scratch in class instances); enforced by profiling in Phase 6, not prematurely.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Browser ignores raw-audio constraints (AGC sneaks in) | Assert resolved track settings; `agcRefusal` simulator impairment + tracking robustness test; pilot power boost |
| 44.1 kHz devices | Derived 44.1 k presets; profile shown in UI; cross-rate out of scope v1 (documented) |
| Speaker roll-off kills quiet mode top carriers | Modeled in simulator from Phase 2; bit-loading drops dead carriers (Phase 7); quiet preset upper edge conservative by default |
| Clock drift breaks long transfers | Pilot CPE/slope tracking + sample slipping (Phase 4), per-burst re-sync (§1.4), dedicated 60 s drift regression test |
| Demod too slow on old phones | Pure-DSP design allows Web Worker move; radix-2 FFT with preallocated twiddles; profile gate in Phase 6 |
| Peeling-only LT overhead too high | GE/inactivation fallback (§1.3), ε measured in CI |
| False sync in noisy cafés | Peak-to-sidelobe threshold + false-alarm test corpus (Phase 3) |
| No physical phones available to the agent | All acceptance gates that can be automated are simulator-based; TESTING.md gives an exact human protocol; live /bench mode logs the same CSVs |

---

*Next step: awaiting approval of this plan before starting Phase 0.*
