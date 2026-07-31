import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { FAST_48K } from '../../src/config';
import { FileSender } from '../../src/link/sender';
import { FileReceiver } from '../../src/link/receiver';
import { OfdmModulator } from '../../src/modem/ofdmMod';
import { OfdmDemodulator } from '../../src/modem/ofdmDemod';
import { detectPreamble } from '../../src/modem/sync';
import { simulateChannel, activeBandHz } from '../../src/channel/simulator';
import { splitmix32 } from '../../src/util/prng';
import { encodeFrame, decodeFrame, HEADER_MAGIC, type FrameHeader } from '../../src/code/frame';
import { frameGeometry } from '../../src/code/geometry';

function makeFile(nbytes: number, seed: number): Uint8Array {
  const rng = splitmix32(seed);
  const f = new Uint8Array(nbytes);
  for (let i = 0; i < nbytes; i++) f[i] = Math.floor(rng() * 256);
  return f;
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('e2e frame-loss (no channel)', () => {
  it('reconstructs a 100 kB file under 20% random frame loss', () => {
    const file = makeFile(100_000, 0x100);
    const expectHash = sha256(file);
    const sender = new FileSender(file, FAST_48K, 0x51ed);
    const receiver = new FileReceiver(FAST_48K);
    const rng = splitmix32(0x1055);
    const g = frameGeometry(FAST_48K);
    const frameBits = g.headerCapacityBits + g.payloadCapacityBits;

    let bursts = 0;
    const maxBursts = 400; // plenty of fountain headroom
    while (!receiver.progress.complete && bursts < maxBursts) {
      const bits = sender.nextBurstBits();
      // Convert bits → clean LLRs, drop 20% of frames.
      const llrs = new Float32Array(bits.length);
      for (let i = 0; i < bits.length; i++) llrs[i] = bits[i]! ? 12 : -12;

      const kept = new Float32Array(llrs.length);
      // Zero out dropped frames (decode will fail header).
      for (let f = 0; f < g.framesPerBurst; f++) {
        const drop = rng() < 0.2;
        const off = f * frameBits;
        if (!drop) {
          kept.set(llrs.subarray(off, off + frameBits), off);
        }
        // else leave zeros → header fail
      }
      receiver.pushLlrs(kept);
      bursts++;
    }

    expect(receiver.progress.complete).toBe(true);
    expect(sha256(receiver.result()!)).toBe(expectHash);
    const p = receiver.progress;
    const totalAttempts = p.framesOk + p.framesHeaderFail + p.framesPayloadFail;
    const lossRate = (p.framesHeaderFail + p.framesPayloadFail) / totalAttempts;
    // eslint-disable-next-line no-console
    console.log(
      `100kB @20% loss: bursts=${bursts}, packets=${p.packetsAccepted}, ` +
        `framesOk=${p.framesOk}, hdrFail=${p.framesHeaderFail}, ` +
        `payFail=${p.framesPayloadFail}, empiricalLoss=${lossRate.toFixed(3)}`,
    );
    expect(lossRate).toBeGreaterThan(0.1);
    expect(lossRate).toBeLessThan(0.3);
  }, 60_000);
});

describe('interleave A/B on realistic channel', () => {
  it('reports higher frame-success with interleaving on vs off (small-room @ 12 dB)', () => {
    // Living-room @ 20 dB is ISI-limited (payload rarely recovers either way).
    // small-room @ 12 dB keeps frequency-selective transducer fades (Group 8)
    // without the reverb floor — the regime where interleaving must matter.
    const cfg = FAST_48K;
    const g = frameGeometry(cfg);
    const nFrames = 40;
    const snrDb = 12;
    const hdr: FrameHeader = {
      magic: HEADER_MAGIC,
      sessionId: 1,
      fileLength: 256,
      K: 1,
      blockSize: 256,
      packetSeed: 0,
      flags: 0,
    };

    function run(interleave: boolean): { ok: number; total: number } {
      let ok = 0;
      let total = 0;
      const symbolMods = [
        ...Array(g.headerSymbols).fill('bpsk' as const),
        ...Array(g.payloadSymbols).fill('qpsk' as const),
      ];
      const mod = new OfdmModulator(cfg, {
        dataSymbols: g.symbolsPerFrame,
        symbolMods,
      });
      const dem = new OfdmDemodulator(cfg, {
        dataSymbols: g.symbolsPerFrame,
        symbolMods,
      });

      for (let i = 0; i < nFrames; i++) {
        const payload = makeFile(256, 0x2000 + i);
        const header = { ...hdr, packetSeed: 0x3000 + i };
        const enc = encodeFrame(header, payload, cfg, { interleave });
        const bits = new Uint8Array(mod.bitsPerBurst);
        bits.set(enc.bits.subarray(0, Math.min(enc.bits.length, bits.length)));
        const tx = mod.modulateBurst(bits);
        const rx = simulateChannel(tx, {
          seed: 0x4000 + i,
          sampleRate: cfg.sampleRate,
          bandLimit: { speakerModel: 'phone' },
          rir: 'small-room',
          snrDb,
          snrBandHz: activeBandHz(cfg),
          clockDriftPpm: 30,
          agcWander: true,
          startOffsetSamples: [200, 800],
        });
        const dets = detectPreamble(rx, cfg);
        if (dets.length === 0) continue;
        const det = dets[0]!;
        const result = dem.demodBurst(rx, det.sampleIndex + det.fracOffset);
        const { stats } = decodeFrame(result.llrs.subarray(0, enc.bits.length), cfg, {
          interleave,
        });
        total++;
        if (stats.headerOk && stats.payloadOk) ok++;
      }
      return { ok, total };
    }

    const on = run(true);
    const off = run(false);
    // eslint-disable-next-line no-console
    console.log(
      `Interleave A/B small-room@${snrDb}dB: ON ${on.ok}/${on.total} (${((100 * on.ok) / on.total).toFixed(1)}%), ` +
        `OFF ${off.ok}/${off.total} (${((100 * off.ok) / off.total).toFixed(1)}%)`,
    );
    expect(on.total).toBe(nFrames);
    expect(off.total).toBe(nFrames);
    expect(on.ok).toBeGreaterThan(off.ok);
    expect(on.ok / on.total).toBeGreaterThanOrEqual(0.5);
  }, 180_000);
});

describe('header vs payload failure rates', () => {
  it('separates header and payload failures at Phase 4 operating SNRs', () => {
    const cfg = FAST_48K;
    const g = frameGeometry(cfg);
    const symbolMods = [
      ...Array(g.headerSymbols).fill('bpsk' as const),
      ...Array(g.payloadSymbols).fill('qpsk' as const),
    ];
    const presets: { name: string; rir: 'small-room' | 'living-room' | 'hallway'; snrDb: number }[] =
      [
        { name: 'small-room', rir: 'small-room', snrDb: 20 },
        { name: 'living-room', rir: 'living-room', snrDb: 20 },
        { name: 'hallway', rir: 'hallway', snrDb: 20 },
      ];

    const report: Record<string, { hdrFail: number; payFail: number; ok: number; n: number }> = {};

    for (const p of presets) {
      let hdrFail = 0;
      let payFail = 0;
      let ok = 0;
      const n = 30;
      const mod = new OfdmModulator(cfg, { dataSymbols: g.symbolsPerFrame, symbolMods });
      const dem = new OfdmDemodulator(cfg, { dataSymbols: g.symbolsPerFrame, symbolMods });

      for (let i = 0; i < n; i++) {
        const payload = makeFile(256, 0x5000 + i);
        const header: FrameHeader = {
          magic: HEADER_MAGIC,
          sessionId: 1,
          fileLength: 256,
          K: 1,
          blockSize: 256,
          packetSeed: 0x6000 + i,
          flags: 0,
        };
        const enc = encodeFrame(header, payload, cfg);
        const bits = new Uint8Array(mod.bitsPerBurst);
        bits.set(enc.bits);
        const tx = mod.modulateBurst(bits);
        const rx = simulateChannel(tx, {
          seed: 0x7000 + i,
          sampleRate: cfg.sampleRate,
          bandLimit: { speakerModel: 'phone' },
          rir: p.rir,
          snrDb: p.snrDb,
          snrBandHz: activeBandHz(cfg),
          clockDriftPpm: 30,
          nonlinearity: {},
          startOffsetSamples: [100, 600],
        });
        const dets = detectPreamble(rx, cfg);
        if (dets.length === 0) {
          hdrFail++;
          continue;
        }
        const det = dets[0]!;
        const result = dem.demodBurst(rx, det.sampleIndex + det.fracOffset);
        const { stats } = decodeFrame(result.llrs.subarray(0, enc.bits.length), cfg);
        if (!stats.headerOk) hdrFail++;
        else if (!stats.payloadOk) payFail++;
        else ok++;
      }
      report[p.name] = { hdrFail, payFail, ok, n };
      // eslint-disable-next-line no-console
      console.log(
        `Header/payload ${p.name}@${p.snrDb}dB: ok=${ok}/${n}, hdrFail=${hdrFail}, payFail=${payFail}`,
      );
    }

    // At Phase 4 operating SNR (20 dB): robust BPSK headers survive on all
    // rooms; QPSK payloads die on living-room/hallway (ISI floor).
    expect(report['small-room']!.ok).toBeGreaterThan(report['small-room']!.n * 0.5);
    expect(report['living-room']!.hdrFail).toBeLessThan(report['living-room']!.payFail);
    expect(report['hallway']!.hdrFail).toBeLessThan(report['hallway']!.payFail);
    expect(report['living-room']!.payFail).toBeGreaterThan(report['living-room']!.ok);
  }, 180_000);
});

describe('full pipeline through realistic presets', () => {
  it('delivers files through small-room / living-room @ 20 dB; hallway is ISI-blocked', async () => {
    const cfg = FAST_48K;
    const file = makeFile(10_000, 0xabcd); // K=40; living-room still stresses fountain under ~95% frame loss
    const expectHash = sha256(file);

    // Yield so Vitest's worker RPC can flush during long demod loops.
    const tick = () => new Promise<void>((r) => setImmediate(r));

    // small-room and living-room must reconstruct. Hallway (41% RIR energy
    // beyond CP) yields ~0% QPSK payload success even at 30 dB — Phase 7
    // bit-loading is required; we measure and record that here.
    for (const rir of ['small-room', 'living-room'] as const) {
      const sender = new FileSender(file, cfg, 0x51ef);
      const receiver = new FileReceiver(cfg);
      const mod = new OfdmModulator(cfg, { symbolMods: sender.symbolMods });
      const dem = new OfdmDemodulator(cfg, { symbolMods: receiver.symbolMods });

      // Living-room frame-success is ~4–5% at 20 dB QPSK (ISI floor); fountain
      // absorbs it but needs hundreds of bursts for K=40.
      const maxBursts = rir === 'living-room' ? 350 : 60;
      let bursts = 0;
      const t0 = Date.now();
      while (!receiver.progress.complete && bursts < maxBursts) {
        const bits = sender.nextBurstBits();
        const tx = mod.modulateBurst(bits);
        const rx = simulateChannel(tx, {
          seed: 0x8000 + bursts * 17 + rir.length,
          sampleRate: cfg.sampleRate,
          bandLimit: { speakerModel: 'phone' },
          rir,
          snrDb: 20,
          snrBandHz: activeBandHz(cfg),
          clockDriftPpm: 30,
          agcWander: true,
          nonlinearity: {},
          startOffsetSamples: [200, 1000],
        });
        const dets = detectPreamble(rx, cfg);
        if (dets.length > 0) {
          const det = dets[0]!;
          const result = dem.demodBurst(rx, det.sampleIndex + det.fracOffset);
          receiver.pushLlrs(result.llrs);
        }
        bursts++;
        if (bursts % 10 === 0) await tick();
      }
      const ms = Date.now() - t0;
      const p = receiver.progress;
      expect(receiver.progress.complete, `${rir} did not complete`).toBe(true);
      expect(sha256(receiver.result()!)).toBe(expectHash);
      const airtimeSec = bursts * (mod.burstSamples / cfg.sampleRate);
      const goodput = (file.length * 8) / airtimeSec;
      // eslint-disable-next-line no-console
      console.log(
        `Pipeline ${rir}@20dB: bursts=${bursts}, airtime=${airtimeSec.toFixed(2)}s, ` +
          `goodput=${goodput.toFixed(0)} bit/s, hdrFail=${p.framesHeaderFail}, ` +
          `payFail=${p.framesPayloadFail}, ok=${p.framesOk}, wall=${ms}ms`,
      );
    }

    // Hallway probe: fixed burst budget, expect essentially zero payload OKs.
    {
      const sender = new FileSender(file, cfg, 0x51ef);
      const receiver = new FileReceiver(cfg);
      const mod = new OfdmModulator(cfg, { symbolMods: sender.symbolMods });
      const dem = new OfdmDemodulator(cfg, { symbolMods: receiver.symbolMods });
      const probeBursts = 20;
      for (let bursts = 0; bursts < probeBursts; bursts++) {
        const bits = sender.nextBurstBits();
        const tx = mod.modulateBurst(bits);
        const rx = simulateChannel(tx, {
          seed: 0x9000 + bursts,
          sampleRate: cfg.sampleRate,
          bandLimit: { speakerModel: 'phone' },
          rir: 'hallway',
          snrDb: 20,
          snrBandHz: activeBandHz(cfg),
          clockDriftPpm: 30,
          nonlinearity: {},
          startOffsetSamples: [200, 1000],
        });
        const dets = detectPreamble(rx, cfg);
        if (dets.length > 0) {
          const det = dets[0]!;
          receiver.pushLlrs(dem.demodBurst(rx, det.sampleIndex + det.fracOffset).llrs);
        }
      }
      const p = receiver.progress;
      // eslint-disable-next-line no-console
      console.log(
        `Pipeline hallway@20dB (probe ${probeBursts} bursts): ok=${p.framesOk}, ` +
          `hdrFail=${p.framesHeaderFail}, payFail=${p.framesPayloadFail}, ` +
          `complete=${p.complete} — ISI floor, Phase 7 required`,
      );
      expect(p.framesOk).toBe(0);
      expect(p.complete).toBe(false);
      // Headers still decode (BPSK+rep) even when payloads cannot.
      expect(p.framesHeaderFail).toBeLessThan(p.framesPayloadFail);
    }
  }, 600_000);
});
