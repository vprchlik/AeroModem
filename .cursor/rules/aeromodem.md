- Never modify files under src/dsp/ or src/channel/ unless the current
  phase explicitly covers them. They are test-locked.
- Report measurements as numbers with units, never adjectives.
  "82.5% vs 0%" not "much better".
- Never weaken a test threshold or assertion to make a test pass. If a
  target is unachievable, report the measured value and say so.
- If a fix changes any pinned threshold or moves a test to a different
  channel/SNR, state old and new explicitly in the summary.
- If a simulator change invalidates previously pinned numbers, flag
  which phases' thresholds are affected.
- Update PLAN.md and PROGRESS.md at the end of every phase.
- Reproduce hardware failures in the simulator before fixing them.
- Do not claim tests are green while any test file is still being edited.
