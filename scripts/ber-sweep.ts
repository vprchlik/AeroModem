/**
 * Phase 4 BER sweeps — writes artifacts/ber-flat.csv (implementation check on
 * flat AWGN vs textbook) and artifacts/ber-groups.csv (per-subcarrier-group
 * BER on realistic presets — the Phase 7 bit-loading baseline), plus a
 * long-transmission ±50 ppm summary. Fully seeded/reproducible.
 *
 * Run: npx tsx scripts/ber-sweep.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { FAST_48K, derive, type Modulation, type ModemConfig } from '../src/config';
import { OfdmModulator } from '../src/modem/ofdmMod';
import { OfdmDemodulator } from '../src/modem/ofdmDemod';
import { hardDecisions, mapCarriers, bitsPerCarrier } from '../src/modem/mapping';
import { detectPreamble } from '../src/modem/sync';
import { simulateChannel, type ChannelOpts } from '../src/channel/simulator';
import { splitmix32 } from '../src/util/prng';

const FS = 48000;

function randomBits(n: number, seed: number): Uint8Array {
  const rng = splitmix32(seed);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = rng() < 0.5 ? 0 : 1;
  return b;
}

function qfunc(x: number): number {
  const z = x / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return 0.5 * poly * Math.exp(-z * z);
}

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

interface ChainOut {
  errors: number;
  totalBits: number;
  groupErr: number[];
  groupTot: number[];
}

function chain(
  mod: Modulation,
  channel: Omit<ChannelOpts, 'seed' | 'sampleRate'>,
  seed: number,
  nSym = 32,
): ChainOut | null {
  const cfg: ModemConfig = { ...FAST_48K, bitLoading: { uniform: mod } };
  const d = derive(cfg);
  const tx = new OfdmModulator(cfg, { dataSymbols: nSym });
  const bits = randomBits(tx.bitsPerBurst, seed ^ 0xb17);
  const sig = tx.modulateBurst(bits);
  const padded = new Float32Array(sig.length + 24000);
  padded.set(sig, 12000);
  const rx = simulateChannel(padded, { seed, sampleRate: FS, ...channel });
  const dets = detectPreamble(rx, cfg);
  if (!dets.length) return null;
  let best = dets[0]!;
  for (const dd of dets) if (dd.corr > best.corr) best = dd;
  const dem = new OfdmDemodulator(cfg, { dataSymbols: nSym });
  const res = dem.demodBurst(rx, best.sampleIndex);
  const hard = hardDecisions(res.llrs);
  const bpc = bitsPerCarrier(mod);
  const nData = d.dataBins.length;
  let errors = 0;
  for (let i = 0; i < bits.length; i++) if (hard[i] !== bits[i]) errors++;
  const groupErr = new Array<number>(8).fill(0);
  const groupTot = new Array<number>(8).fill(0);
  for (let s = 0; s < nSym; s++) {
    for (let c = 0; c < nData; c++) {
      const g = Math.min(7, Math.floor(((d.dataBins[c]! - d.binLow) / d.nActive) * 8));
      for (let b = 0; b < bpc; b++) {
        groupTot[g]!++;
        if (hard[s * nData * bpc + c * bpc + b] !== bits[s * nData * bpc + c * bpc + b])
          groupErr[g]!++;
      }
    }
  }
  return { errors, totalBits: bits.length, groupErr, groupTot };
}

mkdirSync('artifacts', { recursive: true });

// ---------- (a) flat AWGN vs textbook ----------
console.log('== flat AWGN BER vs textbook ==');
const flatRows = ['mod,snrDb,measuredBer,theoryBer,bits'];
const FLAT: { mod: Modulation; snrs: number[] }[] = [
  { mod: 'bpsk', snrs: [2, 4, 6, 8] },
  { mod: 'qpsk', snrs: [5, 7, 9, 11] },
  { mod: 'qam16', snrs: [12, 14, 16, 18] },
];
for (const { mod, snrs } of FLAT) {
  for (const snr of snrs) {
    let errors = 0;
    let total = 0;
    for (let b = 0; b < 4; b++) {
      const r = chain(mod, { snrDb: snr, snrBandHz: [2000, 20000] }, 100 + b);
      if (r) {
        errors += r.errors;
        total += r.totalBits;
      }
    }
    const measured = errors / total;
    const theory = theoryBer(mod, Math.pow(10, snr / 10));
    console.log(
      `${mod} @ ${snr} dB: measured ${measured.toExponential(2)}  theory ${theory.toExponential(2)}`,
    );
    flatRows.push(`${mod},${snr},${measured.toExponential(4)},${theory.toExponential(4)},${total}`);
  }
}
writeFileSync('artifacts/ber-flat.csv', flatRows.join('\n') + '\n');

// ---------- (b) per-group BER on realistic presets ----------
console.log('\n== per-subcarrier-group BER (8 groups, realistic presets) ==');
const groupRows = ['preset,mod,group,loHz,hiHz,ber,bits'];
const PRESETS: { name: string; ch: Omit<ChannelOpts, 'seed' | 'sampleRate'> }[] = [
  {
    name: 'small-room-20dB',
    ch: {
      bandLimit: { speakerModel: 'phone' },
      rir: 'small-room',
      snrDb: 20,
      snrBandHz: [2000, 20000],
      clockDriftPpm: 30,
      agcWander: true,
    },
  },
  {
    name: 'living-room-20dB',
    ch: {
      bandLimit: { speakerModel: 'phone' },
      rir: 'living-room',
      snrDb: 20,
      snrBandHz: [2000, 20000],
      clockDriftPpm: 30,
      agcWander: true,
    },
  },
];
const dRef = derive(FAST_48K);
const groupEdges: [number, number][] = [];
for (let g = 0; g < 8; g++) {
  const lo = dRef.binLow + (g * dRef.nActive) / 8;
  const hi = dRef.binLow + ((g + 1) * dRef.nActive) / 8;
  groupEdges.push([(lo * FS) / 2048, (hi * FS) / 2048]);
}
for (const { name, ch } of PRESETS) {
  for (const mod of ['bpsk', 'qpsk', 'qam16'] as Modulation[]) {
    const agg = { err: new Array<number>(8).fill(0), tot: new Array<number>(8).fill(0) };
    for (let b = 0; b < 3; b++) {
      const r = chain(mod, ch, 300 + b);
      if (r)
        for (let g = 0; g < 8; g++) {
          agg.err[g]! += r.groupErr[g]!;
          agg.tot[g]! += r.groupTot[g]!;
        }
    }
    const bers = agg.err.map((e, g) => e / Math.max(1, agg.tot[g]!));
    console.log(
      `${name} ${mod}: ` + bers.map((x) => x.toExponential(1)).join(' '),
    );
    for (let g = 0; g < 8; g++) {
      groupRows.push(
        `${name},${mod},${g},${groupEdges[g]![0].toFixed(0)},${groupEdges[g]![1].toFixed(0)},` +
          `${bers[g]!.toExponential(4)},${agg.tot[g]}`,
      );
    }
  }
}
writeFileSync('artifacts/ber-groups.csv', groupRows.join('\n') + '\n');
console.log('\nUnusable (uncoded BER > 5e-2) per modulation: see CSV; group edges (Hz):');
console.log(groupEdges.map(([a, b]) => `${(a / 1000).toFixed(1)}–${(b / 1000).toFixed(1)}k`).join(' '));

console.log('\nWrote artifacts/ber-flat.csv and artifacts/ber-groups.csv');
