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
| 2 | Channel simulator | ✅ |
| 3 | Sync (chirp preamble) | ✅ |
| 4 | OFDM modem core | ✅ |
| 5 | Framing + LT fountain code | ✅ |
| 6 | End-to-end product | 🟨 code+sim done; hardware run pending |
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

**Frame geometry (Phase 5 — whole number of OFDM symbols).** Header and payload
occupy separate OFDM-symbol regions. The header is **always BPSK** with rate-1/2
convolutional coding + **3× repetition** (soft-combined at the receiver),
regardless of payload modulation. The payload is rate-1/2 FEC at the configured
modulation. Both regions are bit-interleaved across subcarriers **and** across
the OFDM symbols of that region.

Info layout before coding:

```
| header 24 B | payload = blockSize B | CRC-32 4 B |
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

Coded → interleaved → mapped:

| Region | Modulation | Coding | Symbols (FAST_48K, 683 data carriers) | Symbols (QUIET_48K, 228) |
|---|---|---|---|---|
| Header | BPSK | rate-1/2 + 3× rep | **2** | **6** |
| Payload (BPSK) | BPSK | rate-1/2 | **7** (total frame **9**) | **19** (total **25**) |
| Payload (QPSK) | QPSK | rate-1/2 | **4** (total frame **6**) | **10** (total **16**) |
| Payload (16-QAM) | 16-QAM | rate-1/2 | **2** (total frame **4**) | **5** (total **11**) |

Payload bytes per frame = `blockSize` = **256** at every modulation (fixed source
block). With `dataSymbolsPerBurst = 32`: FAST QPSK packs **5 frames/burst**
(2 leftover symbols); QUIET QPSK packs **2 frames/burst**.

A lost header loses the whole frame regardless of payload FEC — hence the
heavier header protection. Full-frame CRC-32 (poly 0xEDB88320) is the final
payload arbiter; failures are silently dropped (fountain code absorbs the loss).

**Burst:** `chirp | guard | T1 T2 (training) | D1 … D32 (data symbols)`. Data
symbols carry a whole number of frames per burst; leftover symbols are
zero-filled BPSK (accounted in budgets).

**Off-axis RIR preset (observation only):** `'off-axis'` with DRR ≈ −3 dB
simulates a shadowed / off-axis direct path where early reflections dominate.
Do **not** retune sync or modem acceptance against it — it exists so the
dominant-early-reflection failure mode is not first seen on hardware.

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
run: raw mic constraints OK @ 48 kHz; 1 kHz and 5 kHz audible with spectrogram lines;
19 kHz not reproduced by laptop speakers (expected — feeds Phase 2 speaker roll-off
model). Standing by before Phase 2.

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
  sampleRate: number;
  clip?: { thresholdDbfs: number };   // digital hard clip (aliases are physical here)
  nonlinearity?: { secondOrder?: number; thirdOrder?: number }; // speaker soft-sat @2× oversampling
  bandLimit?: { speakerModel: 'phone' | 'flat' };  // REALISTIC transducer roll-off (see audit):
                                      // smooth ~54 dB/oct knee at 15.7 kHz, ≈28 dB down @ 22.5 kHz,
                                      // 2nd-order HPF at 350 Hz. NOT a brick wall.
  rir?: 'small-room' | 'living-room' | 'hallway' | Float32Array; // multipath convolution
  clockDriftPpm?: number;             // resample by (1 + ppm*1e-6)
  agcWander?: boolean;                // slow gain wander, models a browser ignoring constraints
  snrDb?: number;                     // AWGN — IN-BAND by definition
  snrBandHz?: [number, number];       // REQUIRED with snrDb; use activeBandHz(cfg)
  startOffsetSamples?: [min, max];    // random silence prepended
}
export function simulateChannel(samples: Float32Array, opts: ChannelOpts): Float32Array;
export function activeBandHz(cfg: ModemConfig): [number, number];

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

**Status:** ✅ Done (2026-07-31), then **hardened by an anti-optimism audit** (same day):

1. **SNR is now in-band by definition** — `snrBandHz` is required with `snrDb`
   (the old full-band default silently gave quiet mode +6 dB: 15.97 dB delivered
   when 10 dB was requested). Quiet-band request now delivers 9.97 dB.
2. **Realistic speaker model** — brick-wall FIR (131.7 dB @ 22.5 kHz) replaced with
   a smooth transducer response: 28.1 dB @ 22.5 kHz, 54 dB/oct roll-off, 15 dB down
   already at 19 kHz, 2nd-order HPF at 350 Hz. Group delay 255 samples (5.31 ms),
   compensated by `filterAligned`.
3. **Reverb vs CP** — measured RT60 248/439/677 ms (specs 250/450/700); energy beyond
   the 512-sample CP: 11.2% / 23.9% / 40.7% — all presets produce real ISI.
4. **Nonlinearity added** — polynomial soft-saturation at 2× oversampling:
   10 kHz @ 0.5 FS → 2nd harmonic −37.9 dBc at 20 kHz; no fake 18 kHz alias
   (−145 dBc); audible-band noise leaks +91.6 dB into the 17–23 kHz quiet band.
5. **Worst-case difficulty guard test** — 19 kHz sine through clip + nonlinearity +
   phone speaker + hallway + 50 ppm + AGC + 0 dB SNR: tone-to-noise collapses
   105 → 9.1 dB, drift measured exactly (19000.950 Hz), and the global spectral
   peak is a clip-alias intermod at 9 kHz, not the tone.

95/95 tests green. Full tables in `PROGRESS.md`.

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

Detection = normalized cross-correlation computed with FFT overlap-save; threshold on
the correlation coefficient plus a refractory window. Timing = argmax + 3-point
quadratic interpolation.

**Channel-matched correlator (post-audit design).** The realistic transducer model
(15.7 kHz knee) makes a raw-chirp correlator wrong: the final octave of a 2–20 kHz
sweep arrives 15–19 dB down, so low frequencies dominate the peak and sidelobes rise.
Chosen fix: correlate against the chirp **filtered through the nominal phone response**
(channel-matched template) rather than pre-emphasizing the TX chirp. Reasons: (a) TX
pre-emphasis of +15…30 dB at the top of the band is impossible within digital full
scale without sacrificing total radiated energy; (b) in quiet mode the required boost
(≥28 dB at 23 kHz) is unrealizable; (c) a matched template costs nothing at TX, keeps
the chirp at full amplitude, and both ends ship the same nominal model in this web app;
(d) PHAT-style whitening was rejected because dividing by magnitude amplifies noise
exactly in the dead bands at low SNR. Mismatch between a real device and the nominal
model degrades gracefully (second-order correlation loss). Measured PSR gain reported
in PROGRESS.md.

**Revised acceptance (post-audit — the in-band SNR definition made the old "10 dB"
criterion ~6 dB harder than intended, and hallway smears timing):**

1. **Detection/timing curves, not a single point:** sweep in-band SNR −5…+20 dB,
   ≥200 seeded runs per point, per RIR preset (small-room / living-room / hallway),
   with random start offset [0, 48000], drift +50 ppm, AGC wander, and nonlinearity
   ALL enabled simultaneously. Identify the breakdown SNR (detection < 99%) per preset.
   Curves generated by `scripts/sync-sweep.ts`, numbers in PROGRESS.md.
2. **Regression tests pin measured operating points** per preset (chosen from the
   curves with explicit margin, justified in PROGRESS.md) — detection rate and
   per-preset timing thresholds (median + P95) set from measurement. If hallway
   cannot meet a useful timing bound, that is documented with its Phase 4 implication
   (equalizer must tolerate coarser sync), not hidden by loosening until green.
3. **False-alarm test:** 60 s of seeded noise + music-like bursts ⇒ 0 detections.
4. **Documented failure point:** one run set against `worst-case-quiet` (quiet-band
   chirp, 0 dB in-band SNR, hallway, clip, nonlinearity, AGC, drift) — expected to
   fail; the measured failure rate is pinned in a test so accidental "improvement"
   (i.e. an optimistic channel regression) is flagged.

**Status:** ✅ Done (2026-07-31). Curves measured (200 runs/point, all impairments
simultaneously): small-room/living-room 100% detection down to −10 dB in-band
(breakdown at −12.5 dB), hallway breakdown between −10 and −7.5 dB. Timing P95
0.17–0.19 samples at all operating points — hallway did NOT smear timing (direct
path stays dominant at DRR 0 dB). Worst-case-quiet failure curve: 100% @ 0 dB,
96% @ −3, 74% @ −6, 43% @ −9, 3% @ −12 dB — sync at the preset's 0 dB point works;
breakdown pinned at −9 dB in a two-sided regression test. Channel-matched template
chosen over TX pre-emphasis; A/B: +17 pp detection at quiet −6 dB, at the cost of
5.4 vs 2.6 sample P95 (both ≪ 8). 104/104 tests green. Numbers in `PROGRESS.md`.

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

**Tests (amended post-Phase-3 — aggregate BER over a tilted channel would be
dominated by dying top carriers and would only look "textbook" on a flat channel,
hiding exactly what Phase 7 needs to fix):**

1. `tests/modem/loopback.test.ts` — mod→demod with no channel: 0 bit errors, all
   three modulations, both band presets; +1-sample artificial shift is measured by
   the tracker to within 0.1 sample (sign convention pinned).
2. **(a) Implementation-correctness check:** BER vs SNR through `simulateChannel`
   AWGN-only (flat channel — this is deliberately synthetic): each modulation within
   **3 dB** of the textbook AWGN curve (Q-function reference in the test).
3. **(b) Per-subcarrier-group BER on realistic presets:** active band split into
   8 equal groups; BER per group for BPSK/QPSK/16-QAM through `living-room-20db`
   (phone speaker + reverb + 20 dB in-band). PROGRESS.md states which groups are
   **effectively unusable (uncoded BER > 5×10⁻²) per modulation** — this is the
   Phase 7 bit-loading baseline. Test pins the qualitative shape (top group ≫
   bottom group for 16-QAM; low groups usable at QPSK).
4. **Long-transmission drift test:** ≥10 s continuous data symbols (single burst,
   no re-sync) at **±50 ppm** (≈ ±24 samples of accumulated slip): report
   constellation EVM and BER for the FIRST vs LAST second, per modulation. If
   pilot tracking cannot hold 16-QAM for 10 s, the measured maximum sustainable
   duration is reported instead of shortening the test.

`scripts/ber-sweep.ts` emits `artifacts/ber-*.csv` for the bench page.

**Accept:** flat-AWGN curves within 3 dB of textbook; per-group tables recorded with
unusable-carrier baseline for Phase 7; 10 s ± 50 ppm EVM/BER first-vs-last-second
reported; all tests green.

**Status:** ✅ Done (2026-07-31). Flat-AWGN implementation loss ≈ 0.5–1.5 dB (well
inside 3 dB). Two findings along the way: (1) the simulator's cubic resampler was
adding −17.5 dB interpolation distortion at the band top — replaced with a 32-tap
Kaiser-sinc polyphase interpolator (physical drift adds no distortion of its own);
(2) window slipping alone leaves within-symbol ICI, so the demodulator gained
two-pass drift correction (pilot-slope rate estimate → resample by 1/(1+ε̂) →
re-demod), which measures ±50 ppm to 0.1 ppm and holds 16-QAM error-free over
10.7 s. Per-group baseline for Phase 7 recorded (top group 17.8–20 kHz unusable
at every modulation on realistic presets; living-room reverb floor makes ALL
uncoded QPSK groups > 5×10⁻² — the inner FEC carries those). 123/123 tests green.
Numbers in `PROGRESS.md`.

---

### Phase 5 — Framing + LT fountain code

**Goal:** file → endless packet stream → file, robust to arbitrary frame loss;
headers far more robust than payloads; coded bits interleaved across subcarriers
and OFDM symbols; LT overhead **measured**, not assumed.

**Files:** `src/code/crc32.ts`, `src/code/crc16.ts`, `src/code/convolutional.ts`,
`src/code/viterbi.ts`, `src/code/interleave.ts`, `src/code/soliton.ts`,
`src/code/lt.ts`, `src/code/geometry.ts`, `src/code/frame.ts`,
`src/link/sender.ts`, `src/link/receiver.ts`. Carry-over: `'off-axis'` RIR
preset (DRR ≈ −3 dB) in `src/channel/rir.ts` — observation only.

**Key signatures:**

```ts
// code/geometry.ts — whole-symbol frame layout (see §5)
export function frameGeometry(cfg: ModemConfig): FrameGeometry;
export function burstSymbolMods(cfg: ModemConfig): Modulation[]; // BPSK hdr + payload mod

// code/soliton.ts
export function robustSolitonCdf(K: number, c: number, delta: number): Float64Array;
export function sampleDegree(cdf: Float64Array, rng: () => number): number;

// code/lt.ts
export class LtEncoder {
  constructor(source: Uint8Array, blockSize: number, sessionSeed: number, cfg: ModemConfig);
  readonly K: number;
  packet(packetSeed: number): Uint8Array;
}
export class LtDecoder {
  constructor(fileLength: number, K: number, blockSize: number, cfg: ModemConfig);
  addPacket(packetSeed: number, payload: Uint8Array): void;
  readonly decodedBlocks: number;
  readonly complete: boolean;
  result(): Uint8Array | null;
}

// code/frame.ts — separate BPSK header region + payload region
export function encodeFrame(h: FrameHeader, payload: Uint8Array, cfg: ModemConfig, opts?: { interleave?: boolean }): EncodedFrame;
export function decodeFrame(llrs: Float32Array, cfg: ModemConfig, opts?: { interleave?: boolean }): { frame: DecodedFrame | null; stats: FrameDecodeStats };

// link/sender.ts / receiver.ts
export class FileSender {
  constructor(file: Uint8Array, cfg: ModemConfig, sessionSeed: number);
  nextBurstBits(): Uint8Array;
  readonly symbolMods: Modulation[];
  readonly packetsSent: number;
}
export class FileReceiver {
  constructor(cfg: ModemConfig);
  pushLlrs(llrs: Float32Array): void;
  readonly progress: ReceiveProgress; // includes framesHeaderFail vs framesPayloadFail
  onComplete(cb: (file: Uint8Array) => void): void;
}
```

**LT parameters (chosen, then measured):** `c = 0.05`, `δ = 0.05` (Luby mid-range;
modest average degree; GE fallback covers peeling variance). For small K,
`R = c·ln(K/δ)·√K` is clamped to ≥ 1 — the robust spike is weak and **mean ε is
expected to exceed 15%**; that is reported as a tradeoff, not tuned away.
K under test = fileSize / 256 B blocks: **K = 4 (1 KiB), 40 (10 KiB), 391 (≈100 kB)**.

**Tests:**
- Unit: CRC, conv/Viterbi round-trip + soft gain, interleaver invertibility +
  symbol-spreading, soliton χ², frame geometry numbers, clean-LLR frame round-trip.
- **Interleave A/B:** same living-room @ 20 dB channel, interleaving on vs off →
  frame-success rates for both (PROGRESS.md).
- **Header vs payload:** failure rates reported separately at Phase 4 operating
  SNRs (small/living/hallway @ 20 dB in-band).
- **LT ε:** ≥200 seeded runs per K; report mean / P95 / worst.
- **100 kB @ 20% random frame loss:** SHA-256 match.
- **Full pipeline:** 20 kB through modulator → `simulateChannel` (phone + RIR +
  drift + nonlinearity) → demod → receiver for small-room / living-room /
  hallway at 20 dB (Phase 4 BER operating point). Off-axis is **not** an
  acceptance preset.

**Accept:** 100 kB survives 20% frame loss; mean ε ≤ 15% at K≥40 (small-K
exception documented); full-pipeline reconstructs at Phase 4 operating points;
PROGRESS.md logs all measured numbers.

**Status:** ✅ Done (2026-07-31). See `PROGRESS.md` for measured ε, interleave A/B,
header/payload rates, and pipeline goodput. Hallway remains ISI-blocked for QPSK
payloads (headers still decode) — Phase 7 bit-loading.

---

### Phase 6 — End-to-end product

**Goal:** the actual send/receive UI, wired to real audio, plus `TESTING.md`.
Real-hardware requirements are first-class: actual-sample-rate handling,
verified (not just requested) raw audio, iOS gesture/wake-lock constraints,
TX level control with an RX clipping indicator.

**Files:** `src/link/stream.ts` (StreamingSender/StreamingReceiver — pure,
Node-tested), `src/dsp/resample.ts` (`StreamResampler`, phase-continuous),
`src/ui/app.ts` (finalized), `src/ui/snrBars.ts`, `src/ui/constellation.ts`,
`src/ui/blockGrid.ts`, `src/ui/wakeLock.ts`, `src/audio/context.ts` (streaming
ring + gain + capture-optional), `TESTING.md`. Pre-Phase-6 carry-over:
`ROBUST_48K` preset (BPSK payloads for reverberant rooms).

**Sample-rate policy (do not assume 48 kHz):** `AudioContext.sampleRate` is
read back after creation (44.1 kHz is common, especially iOS). The modem always
runs at `cfg.sampleRate`; the link layer fractionally resamples TX 48k→device
and RX device→48k with a phase-continuous streaming resampler. Sender and
receiver at DIFFERENT device rates is a tested case (44.1↔48 both directions).
The active device rate + modem rate are displayed on both ends — an unhandled
mismatch would present as constant unexplained "drift" (~81000 ppm for
44.1↔48, ~1700× the tracker's range).

**Raw audio is verified, not requested:** after `getUserMedia`, the UI reads
`track.getSettings()` and shows the actual echoCancellation / noiseSuppression /
autoGainControl values, with a warning (not a silent failure) when the platform
refused.

**iOS:** AudioContext created strictly inside click handlers; screen wake lock
(`navigator.wakeLock`) held during transfers with visibility-change re-acquire;
Safari testing is a mandatory row in TESTING.md's device matrix.

**TX level:** volume slider on the sender (master GainNode); the receiver
shows a live clipping indicator (fraction of |x| ≥ 0.985 over the last second)
plus a recent-peak readout — the Phase 2 nonlinearity model predicts harmonic
distortion at high drive, and this is the user-visible knob/meter pair to fix it.

**Diagnostics live during real transfers:** spectrogram, per-subcarrier SNR
bars (from each burst's channel estimate), equalized constellation, block grid,
frames ok/header-fail/payload-fail counters, corrected drift ppm.

**Tests:** `tests/dsp/streamResample.test.ts` (streaming = whole-buffer
resampler, tone frequency preserved across rates); `tests/link/stream.test.ts`
(chunked-capture e2e; cross-rate 44.1↔48 both directions; clipping indicator;
quiet-mode-through-phone-speaker verdict; robust preset streaming e2e).

**Accept:** TESTING.md matrix filled from at least one real phone-to-phone
session with at least one mode achieving reliable 20 kB transfers at arm's
length. (Cloud-agent caveat: the physical two-phone run needs a human; all
simulator gates + the protocol + the app are delivered, table left to fill.)

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
