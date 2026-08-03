import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ROBUST_48K, FAST_48K } from '../../src/config';
import { frameGeometry } from '../../src/code/geometry';
import { FileSender } from '../../src/link/sender';
import { FileReceiver } from '../../src/link/receiver';
import { OfdmModulator } from '../../src/modem/ofdmMod';
import { OfdmDemodulator } from '../../src/modem/ofdmDemod';
import { detectPreamble } from '../../src/modem/sync';
import { simulateChannel, activeBandHz } from '../../src/channel/simulator';
import { splitmix32 } from '../../src/util/prng';
import { measurePreset } from '../../scripts/robust-measure';

function makeFile(nbytes: number, seed: number): Uint8Array {
  const rng = splitmix32(seed);
  const f = new Uint8Array(nbytes);
  for (let i = 0; i < nbytes; i++) f[i] = Math.floor(rng() * 256);
  return f;
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('ROBUST_48K preset (BPSK payloads)', () => {
  it('states its geometry', () => {
    const g = frameGeometry(ROBUST_48K);
    expect(g.payloadMod).toBe('bpsk');
    expect(g.headerSymbols).toBe(2);
    expect(g.payloadSymbols).toBe(7);
    expect(g.symbolsPerFrame).toBe(9);
    expect(g.framesPerBurst).toBe(3);
  });

  it('measures frame-success and throughput on living-room/hallway at 12/20 dB', () => {
    const rows: string[] = [];
    const results: Record<string, { fs: number; goodput: number }> = {};
    for (const rir of ['living-room', 'hallway'] as const) {
      for (const snr of [12, 20]) {
        const r = measurePreset(ROBUST_48K, rir, snr, 25);
        results[`${rir}@${snr}`] = { fs: r.frameSuccess, goodput: r.goodputBitPerSec };
        rows.push(
          `ROBUST ${rir}@${snr}dB: frameSuccess=${(100 * r.frameSuccess).toFixed(1)}% ` +
            `goodput=${r.goodputBitPerSec.toFixed(0)} bit/s ` +
            `(ok=${r.ok} hdrFail=${r.hdrFail} payFail=${r.payFail})`,
        );
      }
    }
    // eslint-disable-next-line no-console
    for (const row of rows) console.log(row);

    // Regression pins (measured 2026-08: LR@20 65.3% / 2108 bit/s; LR@12 16%;
    // hallway 0% at both — ISI floor beyond rate-1/2, stays a Phase 7 item).
    expect(results['living-room@20']!.fs).toBeGreaterThan(0.4);
    expect(results['living-room@20']!.goodput).toBeGreaterThan(1200);
    expect(results['living-room@12']!.fs).toBeGreaterThan(0.05);
    // Honest expectation: hallway does NOT work in robust mode either.
    expect(results['hallway@20']!.fs).toBeLessThan(0.05);
  }, 300_000);

  it('robust mode dominates QPSK on living-room @ 20 dB', () => {
    const robust = measurePreset(ROBUST_48K, 'living-room', 20, 10, 0xb000);
    const fast = measurePreset(FAST_48K, 'living-room', 20, 10, 0xb000);
    // eslint-disable-next-line no-console
    console.log(
      `living-room@20dB: ROBUST ${(100 * robust.frameSuccess).toFixed(1)}% vs ` +
        `FAST ${(100 * fast.frameSuccess).toFixed(1)}%`,
    );
    expect(robust.frameSuccess).toBeGreaterThan(fast.frameSuccess + 0.3);
  }, 180_000);

  it('delivers a 20 kB file on living-room @ 20 dB in reasonable airtime', async () => {
    const cfg = ROBUST_48K;
    const file = makeFile(20_000, 0x60d);
    const expectHash = sha256(file);
    const sender = new FileSender(file, cfg, 0x60d);
    const receiver = new FileReceiver(cfg);
    const mod = new OfdmModulator(cfg, { symbolMods: sender.symbolMods });
    const dem = new OfdmDemodulator(cfg, { symbolMods: receiver.symbolMods });
    const tick = () => new Promise<void>((r) => setImmediate(r));

    let bursts = 0;
    const maxBursts = 120;
    while (!receiver.progress.complete && bursts < maxBursts) {
      const bits = sender.nextBurstBits();
      const tx = mod.modulateBurst(bits);
      const rx = simulateChannel(tx, {
        seed: 0xc000 + bursts * 7,
        sampleRate: cfg.sampleRate,
        bandLimit: { speakerModel: 'phone' },
        rir: 'living-room',
        snrDb: 20,
        snrBandHz: activeBandHz(cfg),
        clockDriftPpm: 30,
        agcWander: true,
        nonlinearity: {},
        startOffsetSamples: [200, 1000],
      });
      const dets = detectPreamble(rx, cfg);
      if (dets.length > 0) {
        receiver.pushLlrs(
          dem.demodBurst(rx, dets[0]!.sampleIndex + dets[0]!.fracOffset).llrs,
        );
      }
      bursts++;
      if (bursts % 10 === 0) await tick();
    }
    expect(receiver.progress.complete).toBe(true);
    expect(sha256(receiver.result()!)).toBe(expectHash);
    const airtime = bursts * (mod.burstSamples / cfg.sampleRate);
    const goodput = (file.length * 8) / airtime;
    // eslint-disable-next-line no-console
    console.log(
      `ROBUST living-room@20dB 20kB: bursts=${bursts}, airtime=${airtime.toFixed(1)}s, ` +
        `goodput=${goodput.toFixed(0)} bit/s`,
    );
    // 12× better than the FAST fountain-brute-force path (173 bit/s).
    expect(goodput).toBeGreaterThan(1000);
  }, 300_000);
});
