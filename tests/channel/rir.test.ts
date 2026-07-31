import { describe, expect, it } from 'vitest';
import { makeRir, rirStats, RIR_SPECS } from '../../src/channel/rir';

const FS = 48000;

describe('makeRir', () => {
  for (const [name, spec] of Object.entries(RIR_SPECS)) {
    describe(`preset '${name}'`, () => {
      const h = makeRir(name, 1234, FS);
      const stats = rirStats(h, FS);

      it('has a unit direct tap and expected length (0.5·RT60)', () => {
        expect(h[0]).toBeCloseTo(1, 6);
        expect(h.length).toBe(Math.round(0.5 * spec.rt60Sec * FS));
      });

      it(`DRR within 2 dB of spec (${spec.drrDb} dB)`, () => {
        expect(Math.abs(stats.drrDb - spec.drrDb)).toBeLessThan(2);
      });

      it(`RMS delay spread within spec range [${spec.expectedDelaySpreadMs}] ms`, () => {
        expect(stats.rmsDelaySpreadMs).toBeGreaterThan(spec.expectedDelaySpreadMs[0]);
        expect(stats.rmsDelaySpreadMs).toBeLessThan(spec.expectedDelaySpreadMs[1]);
      });
    });
  }

  it('delay spread orders as small-room < living-room < hallway', () => {
    const s = rirStats(makeRir('small-room', 5, FS), FS).rmsDelaySpreadMs;
    const l = rirStats(makeRir('living-room', 5, FS), FS).rmsDelaySpreadMs;
    const h = rirStats(makeRir('hallway', 5, FS), FS).rmsDelaySpreadMs;
    expect(s).toBeLessThan(l);
    expect(l).toBeLessThan(h);
  });

  it('is deterministic per seed and varies across seeds', () => {
    const a = makeRir('living-room', 42, FS);
    const b = makeRir('living-room', 42, FS);
    const c = makeRir('living-room', 43, FS);
    expect(a).toEqual(b);
    let differs = false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== c[i]) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });

  it('rejects unknown presets', () => {
    expect(() => makeRir('cathedral', 1, FS)).toThrow(/unknown RIR preset/);
  });
});
