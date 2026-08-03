/**
 * Robust-preset measurement: frame-success rate and net throughput for
 * ROBUST_48K (BPSK payloads) vs FAST_48K (QPSK) on living-room and hallway
 * at 12 and 20 dB in-band. Run: npx tsx scripts/robust-measure.ts
 */

import { ROBUST_48K, FAST_48K, type ModemConfig } from '../src/config';
import { frameGeometry } from '../src/code/geometry';
import { FileSender } from '../src/link/sender';
import { FileReceiver } from '../src/link/receiver';
import { OfdmModulator } from '../src/modem/ofdmMod';
import { OfdmDemodulator } from '../src/modem/ofdmDemod';
import { detectPreamble } from '../src/modem/sync';
import { simulateChannel, activeBandHz } from '../src/channel/simulator';
import { splitmix32 } from '../src/util/prng';

function makeFile(n: number, seed: number): Uint8Array {
  const rng = splitmix32(seed);
  const f = new Uint8Array(n);
  for (let i = 0; i < n; i++) f[i] = Math.floor(rng() * 256);
  return f;
}

export interface RobustMeasurement {
  frameSuccess: number;
  goodputBitPerSec: number;
  ok: number;
  hdrFail: number;
  payFail: number;
  noDet: number;
}

export function measurePreset(
  cfg: ModemConfig,
  rir: 'living-room' | 'hallway' | 'small-room',
  snrDb: number,
  nBursts: number,
  seedBase = 0xa000,
): RobustMeasurement {
  const file = makeFile(50_000, 7);
  const sender = new FileSender(file, cfg, 0x22);
  const receiver = new FileReceiver(cfg);
  const mod = new OfdmModulator(cfg, { symbolMods: sender.symbolMods });
  const dem = new OfdmDemodulator(cfg, { symbolMods: receiver.symbolMods });
  const g = frameGeometry(cfg);
  let noDet = 0;
  for (let b = 0; b < nBursts; b++) {
    const bits = sender.nextBurstBits();
    const tx = mod.modulateBurst(bits);
    const rx = simulateChannel(tx, {
      seed: seedBase + b * 13,
      sampleRate: cfg.sampleRate,
      bandLimit: { speakerModel: 'phone' },
      rir,
      snrDb,
      snrBandHz: activeBandHz(cfg),
      clockDriftPpm: 30,
      agcWander: true,
      nonlinearity: {},
      startOffsetSamples: [200, 1000],
    });
    const dets = detectPreamble(rx, cfg);
    if (!dets.length) {
      noDet++;
      continue;
    }
    receiver.pushLlrs(dem.demodBurst(rx, dets[0]!.sampleIndex + dets[0]!.fracOffset).llrs);
  }
  const p = receiver.progress;
  const attempts =
    p.framesOk + p.framesHeaderFail + p.framesPayloadFail + noDet * g.framesPerBurst;
  const burstSec = mod.burstSamples / cfg.sampleRate;
  return {
    frameSuccess: p.framesOk / attempts,
    goodputBitPerSec: (p.framesOk * cfg.blockSize * 8) / (nBursts * burstSec),
    ok: p.framesOk,
    hdrFail: p.framesHeaderFail,
    payFail: p.framesPayloadFail,
    noDet,
  };
}

const isMain = process.argv[1]?.includes('robust-measure');
if (isMain) {
  const g = frameGeometry(ROBUST_48K);
  console.log(
    `ROBUST_48K geometry: ${g.headerSymbols}+${g.payloadSymbols}=${g.symbolsPerFrame} sym/frame, ` +
      `${g.framesPerBurst} frames/burst, ${g.leftoverSymbols} leftover`,
  );
  for (const [label, cfg] of [
    ['ROBUST (BPSK)', ROBUST_48K],
    ['FAST (QPSK)', FAST_48K],
  ] as const) {
    for (const rir of ['living-room', 'hallway'] as const) {
      for (const snr of [12, 20]) {
        const r = measurePreset(cfg, rir, snr, 25);
        console.log(
          `${label} ${rir} @ ${snr} dB: frameSuccess=${(100 * r.frameSuccess).toFixed(1)}% ` +
            `goodput=${r.goodputBitPerSec.toFixed(0)} bit/s ok=${r.ok} ` +
            `hdrFail=${r.hdrFail} payFail=${r.payFail} noDet=${r.noDet}`,
        );
      }
    }
  }
}
