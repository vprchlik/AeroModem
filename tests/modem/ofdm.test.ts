import { describe, expect, it } from 'vitest';
import { FAST_48K, QUIET_48K, derive, type ModemConfig, type Modulation } from '../../src/config';
import { OfdmModulator } from '../../src/modem/ofdmMod';
import { OfdmDemodulator } from '../../src/modem/ofdmDemod';
import { hardDecisions, mapCarriers, bitsPerCarrier } from '../../src/modem/mapping';
import { detectPreamble } from '../../src/modem/sync';
import { simulateChannel, type ChannelOpts } from '../../src/channel/simulator';
import { splitmix32 } from '../../src/util/prng';

const FS = 48000;

function randomBits(n: number, seed: number): Uint8Array {
  const rng = splitmix32(seed);
  const bits = new Uint8Array(n);
  for (let i = 0; i < n; i++) bits[i] = rng() < 0.5 ? 0 : 1;
  return bits;
}

interface RunResult {
  ber: number;
  errors: number;
  totalBits: number;
  evmPct: number;
  correctedPpm: number;
  totalSlips: number;
  groupBer: number[]; // 8 groups across the active band
  firstSecond?: { ber: number; evmPct: number };
  lastSecond?: { ber: number; evmPct: number };
}

/** Modulate → channel → sync → demod → compare. */
function runChain(
  mod: Modulation,
  channel: Omit<ChannelOpts, 'seed' | 'sampleRate'> | null,
  opts: { nSym?: number; seed?: number; cfgBase?: ModemConfig } = {},
): RunResult | null {
  const nSym = opts.nSym ?? 32;
  const seed = opts.seed ?? 3;
  const cfg = { ...(opts.cfgBase ?? FAST_48K), bitLoading: { uniform: mod } };
  const d = derive(cfg);
  const tx = new OfdmModulator(cfg, { dataSymbols: nSym });
  const bits = randomBits(tx.bitsPerBurst, seed ^ 0xb17);
  const sig = tx.modulateBurst(bits);
  const padded = new Float32Array(sig.length + 24000);
  padded.set(sig, 12000);
  const rx = channel
    ? simulateChannel(padded, { seed, sampleRate: FS, ...channel })
    : padded;

  const dets = detectPreamble(rx, cfg);
  if (dets.length === 0) return null;
  let best = dets[0]!;
  for (const dd of dets) if (dd.corr > best.corr) best = dd;

  const dem = new OfdmDemodulator(cfg, { dataSymbols: nSym });
  const res = dem.demodBurst(rx, best.sampleIndex);
  const hard = hardDecisions(res.llrs);

  const bpc = bitsPerCarrier(mod);
  const nData = d.dataBins.length;
  const bitsPerSym = nData * bpc;

  let errors = 0;
  for (let i = 0; i < bits.length; i++) if (hard[i] !== bits[i]) errors++;

  const groupErr = new Array<number>(8).fill(0);
  const groupTot = new Array<number>(8).fill(0);
  for (let s = 0; s < nSym; s++) {
    for (let c = 0; c < nData; c++) {
      const g = Math.min(7, Math.floor(((d.dataBins[c]! - d.binLow) / d.nActive) * 8));
      for (let b = 0; b < bpc; b++) {
        const idx = s * bitsPerSym + c * bpc + b;
        groupTot[g]!++;
        if (hard[idx] !== bits[idx]) groupErr[g]!++;
      }
    }
  }

  const seg = (s0: number, s1: number) => {
    let err = 0;
    let tot = 0;
    let num = 0;
    let den = 0;
    const cRe = new Float32Array(nData);
    const cIm = new Float32Array(nData);
    for (let s = s0; s < s1; s++) {
      for (let b = 0; b < bitsPerSym; b++) {
        tot++;
        if (hard[s * bitsPerSym + b] !== bits[s * bitsPerSym + b]) err++;
      }
      mapCarriers(bits, s * bitsPerSym, mod, nData, cRe, cIm, 0);
      for (let c = 0; c < nData; c++) {
        num += (res.eqRe[s]![c]! - cRe[c]!) ** 2 + (res.eqIm[s]![c]! - cIm[c]!) ** 2;
        den += cRe[c]! ** 2 + cIm[c]! ** 2;
      }
    }
    return { ber: err / tot, evmPct: 100 * Math.sqrt(num / den) };
  };

  const whole = seg(0, nSym);
  const out: RunResult = {
    ber: errors / bits.length,
    errors,
    totalBits: bits.length,
    evmPct: whole.evmPct,
    correctedPpm: res.correctedPpm,
    totalSlips: res.totalSlips,
    groupBer: groupErr.map((e, i) => e / groupTot[i]!),
  };
  if (nSym >= 38) {
    out.firstSecond = seg(0, 18); // 18.75 symbols ≈ 1 s
    out.lastSecond = seg(nSym - 18, nSym);
  }
  return out;
}

/** Q-function Q(x) = 0.5·erfc(x/√2), Abramowitz–Stegun 7.1.26 approximation. */
function qfunc(x: number): number {
  const z = x / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return 0.5 * poly * Math.exp(-z * z);
}

/** Theoretical uncoded BER at per-carrier Es/N0 = rho (linear). */
function theoryBer(mod: Modulation, rhoLin: number): number {
  switch (mod) {
    case 'bpsk':
      return qfunc(Math.sqrt(2 * rhoLin));
    case 'qpsk':
      return qfunc(Math.sqrt(rhoLin));
    case 'qam16':
      return 0.75 * qfunc(Math.sqrt(rhoLin / 5));
  }
}

describe('loopback (no channel)', () => {
  for (const mod of ['bpsk', 'qpsk', 'qam16'] as const) {
    it(`${mod}: zero errors, EVM < 1%`, () => {
      const r = runChain(mod, null, { nSym: 4 });
      expect(r).not.toBeNull();
      expect(r!.errors).toBe(0);
      expect(r!.evmPct).toBeLessThan(1);
    });
  }

  it('quiet-mode preset loops back clean too', () => {
    const r = runChain('qpsk', null, { nSym: 4, cfgBase: QUIET_48K });
    expect(r!.errors).toBe(0);
  });
});

describe('drift estimation sign and accuracy', () => {
  it('recovers +50 ppm within 2 ppm', () => {
    const r = runChain('qpsk', { clockDriftPpm: 50, snrDb: 20, snrBandHz: [2000, 20000] });
    expect(Math.abs(r!.correctedPpm - 50)).toBeLessThan(2);
  });

  it('recovers −50 ppm within 2 ppm', () => {
    const r = runChain('qpsk', { clockDriftPpm: -50, snrDb: 20, snrBandHz: [2000, 20000] });
    expect(Math.abs(r!.correctedPpm + 50)).toBeLessThan(2);
  });
});

describe('(a) flat-AWGN BER vs textbook (implementation-correctness check)', () => {
  // Measured BER at in-band SNR ρ must lie between theory(ρ) (can't beat
  // theory) and theory(ρ − 3 dB) (≤ 3 dB implementation loss).
  const cases: { mod: Modulation; snrDb: number }[] = [
    { mod: 'bpsk', snrDb: 4 },
    { mod: 'bpsk', snrDb: 7 },
    { mod: 'qpsk', snrDb: 7 },
    { mod: 'qpsk', snrDb: 10 },
    { mod: 'qam16', snrDb: 14 },
    { mod: 'qam16', snrDb: 17 },
  ];
  for (const { mod, snrDb } of cases) {
    it(`${mod} @ ${snrDb} dB within 3 dB of theory`, () => {
      let errors = 0;
      let total = 0;
      for (let b = 0; b < 2; b++) {
        const r = runChain(mod, { snrDb, snrBandHz: [2000, 20000] }, { seed: 100 + b });
        expect(r).not.toBeNull();
        errors += r!.errors;
        total += r!.totalBits;
      }
      const measured = errors / total;
      const rho = Math.pow(10, snrDb / 10);
      const rho3 = Math.pow(10, (snrDb - 3) / 10);
      const upper = theoryBer(mod, rho3);
      const lower = theoryBer(mod, rho) * 0.3; // slack for finite sample size
      expect(measured).toBeLessThanOrEqual(upper);
      expect(measured).toBeGreaterThanOrEqual(lower);
    });
  }
});

describe('(b) per-subcarrier-group BER on realistic presets (Phase 7 baseline)', () => {
  const lr: Omit<ChannelOpts, 'seed' | 'sampleRate'> = {
    bandLimit: { speakerModel: 'phone' },
    rir: 'living-room',
    snrDb: 20,
    snrBandHz: [2000, 20000],
    clockDriftPpm: 30,
    agcWander: true,
  };

  it('16-QAM: top group is effectively unusable, far worse than the bottom', () => {
    const r = runChain('qam16', lr);
    expect(r).not.toBeNull();
    const g = r!.groupBer;
    expect(g[7]!).toBeGreaterThan(0.05); // unusable by the 5e-2 criterion
    expect(g[7]!).toBeGreaterThan(g[0]! * 1.5);
  });

  it('QPSK: reverb ISI floor is visible even in low groups; top group worst', () => {
    const r = runChain('qpsk', lr);
    const g = r!.groupBer;
    // Reverb-limited floor (living-room ≈ 6e-2): honest, documented.
    expect(g[0]!).toBeGreaterThan(1e-3);
    expect(g[7]!).toBeGreaterThan(g[0]!);
  });

  it('BPSK on small-room: low groups usable (< 5e-2), top group degraded', () => {
    const r = runChain('bpsk', {
      bandLimit: { speakerModel: 'phone' },
      rir: 'small-room',
      snrDb: 20,
      snrBandHz: [2000, 20000],
      clockDriftPpm: 30,
      agcWander: true,
    });
    const g = r!.groupBer;
    for (let i = 0; i < 6; i++) expect(g[i]!).toBeLessThan(0.05);
    expect(g[7]!).toBeGreaterThan(g[0]!);
  });
});

describe('long-transmission drift test (10.7 s, ±50 ppm)', () => {
  // 200 data symbols = 10.67 s; ±50 ppm ⇒ ≈ 26 samples of accumulated slip.
  // Two-pass drift correction (measured +50.1 ppm) holds 16-QAM the whole way.
  it('16-QAM @ 25 dB, +50 ppm: error-free first AND last second', { timeout: 120_000 }, () => {
    const r = runChain(
      'qam16',
      { clockDriftPpm: 50, snrDb: 25, snrBandHz: [2000, 20000], agcWander: true },
      { nSym: 200, seed: 11 },
    );
    expect(r!.firstSecond!.ber).toBeLessThan(1e-3);
    expect(r!.lastSecond!.ber).toBeLessThan(1e-3);
    // EVM must not grow materially across the burst (tracking holds).
    expect(r!.lastSecond!.evmPct - r!.firstSecond!.evmPct).toBeLessThan(3);
  });

  it('16-QAM @ 25 dB, −50 ppm: same, opposite drift sign', { timeout: 120_000 }, () => {
    const r = runChain(
      'qam16',
      { clockDriftPpm: -50, snrDb: 25, snrBandHz: [2000, 20000], agcWander: true },
      { nSym: 200, seed: 12 },
    );
    expect(r!.firstSecond!.ber).toBeLessThan(1e-3);
    expect(r!.lastSecond!.ber).toBeLessThan(1e-3);
  });

  it('QPSK @ 20 dB, +50 ppm: error-free both ends', { timeout: 120_000 }, () => {
    const r = runChain(
      'qpsk',
      { clockDriftPpm: 50, snrDb: 20, snrBandHz: [2000, 20000], agcWander: true },
      { nSym: 200, seed: 13 },
    );
    expect(r!.firstSecond!.ber).toBeLessThan(1e-3);
    expect(r!.lastSecond!.ber).toBeLessThan(1e-3);
  });

  it('drift correction measurably beats slip-only tracking (EVM guard)', { timeout: 120_000 }, () => {
    // Measured (see PROGRESS.md): slip-only tracking survives ±50 ppm with the
    // clean sinc resampler (BER 9e-6, EVM 10.4%), but the two-pass corrector
    // removes the within-symbol ICI (EVM 7.9%, BER 0). Pin the gap so neither
    // path silently regresses.
    const cfg = { ...FAST_48K, bitLoading: { uniform: 'qam16' as const } };
    const d = derive(cfg);
    const tx = new OfdmModulator(cfg, { dataSymbols: 200 });
    const bits = randomBits(tx.bitsPerBurst, 11 ^ 0xb17);
    const sig = tx.modulateBurst(bits);
    const padded = new Float32Array(sig.length + 24000);
    padded.set(sig, 12000);
    const rx = simulateChannel(padded, {
      seed: 11,
      sampleRate: FS,
      clockDriftPpm: 50,
      snrDb: 25,
      snrBandHz: [2000, 20000],
      agcWander: true,
    });
    const dets = detectPreamble(rx, cfg);
    let best = dets[0]!;
    for (const dd of dets) if (dd.corr > best.corr) best = dd;

    const evmOf = (driftCorrection: boolean) => {
      const dem = new OfdmDemodulator(cfg, { dataSymbols: 200, driftCorrection });
      const res = dem.demodBurst(rx, best.sampleIndex);
      const nData = d.dataBins.length;
      const cRe = new Float32Array(nData);
      const cIm = new Float32Array(nData);
      let num = 0;
      let den = 0;
      for (let s = 0; s < 200; s++) {
        mapCarriers(bits, s * nData * 4, 'qam16', nData, cRe, cIm, 0);
        for (let c = 0; c < nData; c++) {
          num += (res.eqRe[s]![c]! - cRe[c]!) ** 2 + (res.eqIm[s]![c]! - cIm[c]!) ** 2;
          den += cRe[c]! ** 2 + cIm[c]! ** 2;
        }
      }
      return 100 * Math.sqrt(num / den);
    };

    const withCorr = evmOf(true);
    const withoutCorr = evmOf(false);
    expect(withCorr).toBeLessThan(9); // measured 7.9%
    expect(withoutCorr - withCorr).toBeGreaterThan(1.5); // measured gap ≈ 2.6 points
  });
});
