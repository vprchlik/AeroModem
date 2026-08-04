# AeroModem — Hardware Testing Protocol (Phase 6)

The simulator (Phases 2–5) is the first gate; this protocol is the second.
**Any hardware failure gets reproduced in the simulator before it gets fixed** —
if the simulator can't reproduce it, the simulator gets extended first.

## Devices

Test at minimum one pairing from each row when hardware is available:

| Sender | Receiver | Notes |
|---|---|---|
| Android phone (Chrome) | Android phone (Chrome) | primary target |
| iPhone (Safari) | Android phone (Chrome) | iOS quirks isolated to TX |
| Android phone (Chrome) | iPhone (Safari) | iOS mic processing is the risk |
| iPhone (Safari) | iPhone (Safari) | worst case |

Record for every session: device models, OS + browser versions, room type
(e.g. "3×4 m bedroom, carpet", "6×2 m hallway, tile"), background-noise
character (quiet / speech / music).

## Setup checklist (before each session)

1. Open the deployed app on both phones. **Select the same mode on both.**
2. Both phones: media volume ≈ 80%. Do NOT use silent/vibrate mode switches
   that mute media on some phones.
3. Receiver: tap **Receive → Tap to listen**, then check the status box:
   - **Device rate** — note it (44100 on many phones, especially iOS). The
     modem resamples automatically; a mismatch is informational, not an error.
   - **Mic processing (verified)** — all three flags must read `false`. If the
     browser kept any ON, note it in the results table; expect degradation.
4. Sender: pick the test file, **Start sending**. Watch the receiver's
   **clipping indicator**: if it shows CLIPPING, lower the TX volume slider
   or Mic gain until it reads "level ok" (the Phase 2 nonlinearity model
   predicts harmonic distortion at high drive — this is the knob that fixes it).
   If peak stays under ~5% even while talking into the receiver, **raise Mic
   gain** (Safari/iPad often needs 40–100× — the digital preamp does not replace
   OS voice processing; it only scales the samples the browser delivered).
5. Keep both screens on (the app requests a wake lock; if the status box says
   it's unsupported, keep the screen awake manually).
6. iOS specifics: audio starts only after the tap (expected); if the phone
   locks anyway, transfers stall — note it. The app sets `audioSession` to
   `play-and-record` when available.

## Test file

20 kB (20480 bytes) random binary. Generate once and reuse:

```bash
node -e "const b=Buffer.alloc(20480);for(let i=0;i<b.length;i++)b[i]=(Math.imul(i,2654435761)>>>8)&255;require('fs').writeFileSync('test-20k.bin',b)"
shasum -a 256 test-20k.bin   # record; compare to the hash the receiver shows
```

## Measurement matrix

For each configuration: **3 transfer attempts**. Record success/fail, wall-clock
time from "Start sending" to the receiver's ✓, and effective bit/s
(= 20480·8 / seconds). A transfer that does not complete within **5 minutes**
counts as FAIL (note how many blocks the grid showed).

Distances: **0.3 m** and **1 m**, phones face-up on a table, speaker toward mic.

### Results

Fill in one table per device pairing + room.

**Pairing:** _________________ **Room:** _________________ **Date:** _______

| Mode | Distance | Try | Success | Time (s) | Effective bit/s | Notes (clip %, SNR bars, drift ppm) |
|---|---|---|---|---|---|---|
| fast | 0.3 m | 1 | | | | |
| fast | 0.3 m | 2 | | | | |
| fast | 0.3 m | 3 | | | | |
| fast | 1 m | 1 | | | | |
| fast | 1 m | 2 | | | | |
| fast | 1 m | 3 | | | | |
| robust | 0.3 m | 1 | | | | |
| robust | 0.3 m | 2 | | | | |
| robust | 0.3 m | 3 | | | | |
| robust | 1 m | 1 | | | | |
| robust | 1 m | 2 | | | | |
| robust | 1 m | 3 | | | | |
| quiet | 0.3 m | 1 | | | | |
| quiet | 0.3 m | 2 | | | | |
| quiet | 0.3 m | 3 | | | | |
| quiet | 1 m | 1 | | | | |
| quiet | 1 m | 2 | | | | |
| quiet | 1 m | 3 | | | | |

Simulator predictions to compare against (in-band SNR 20 dB, PROGRESS.md):

| Mode | small-room prediction | living-room prediction |
|---|---|---|
| fast (QPSK) | ~4.7 kbit/s | fails or minutes-slow (ISI floor) — use robust |
| robust (BPSK) | ~2.9 kbit/s ceiling | ~2.1 kbit/s |
| quiet (QPSK) | closes at ≥25 dB in-band only | untested |

## What to watch in the diagnostics

- **Spectrogram**: is the whole 2–20 kHz band lit during bursts, or is the top
  shelved off (speaker roll-off worse than the model)?
- **Per-subcarrier SNR bars**: which bands sit below the 15 dB line — compare
  against the Phase 4 per-group BER table (Group 8 = 17.8–20 kHz is expected
  dead; more dead groups than that is news).
- **Constellation**: rotation = residual CFO/timing; ring smear = AGC/clipping;
  fuzz = plain low SNR.
- **Block grid**: uniform fill = healthy fountain; stuck blocks with frames
  arriving = header/session bug (report immediately).
- **Drift ppm** (in the counters line): should be stable per device pair;
  a value near ±81000/44100↔48000-ish means a resampling bug, not clock drift.

## Failure triage

1. Note the failing configuration + all diagnostics.
2. Reproduce in the simulator (`tests/`, `scripts/robust-measure.ts`) by
   matching the observed SNR/drift/clip settings.
3. Only then change modem code; add the regression to the test suite.

## Acceptance (Phase 6)

At least one full pairing table filled from a real phone-to-phone session,
with **at least one mode achieving 3/3 successful 20 kB transfers at 1 m**
(arm's length). Every row must have real numbers, including the failures.
