import { describe, expect, it } from 'vitest';
import { makeRir, rirStats, RIR_SPECS } from '../../src/channel/rir';

describe('off-axis RIR preset (observation only)', () => {
  it('has DRR ≈ −3 dB so early reflections can dominate the direct path', () => {
    expect(RIR_SPECS['off-axis']!.drrDb).toBe(-3);
    const stats = rirStats(makeRir('off-axis', 1234, 48000), 48000);
    expect(Math.abs(stats.drrDb - -3)).toBeLessThan(0.5);
    // eslint-disable-next-line no-console
    console.log(
      `off-axis observation: DRR=${stats.drrDb.toFixed(2)} dB, ` +
        `τ_rms=${stats.rmsDelaySpreadMs.toFixed(1)} ms (not an acceptance preset)`,
    );
  });
});
