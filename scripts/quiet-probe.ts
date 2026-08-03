/**
 * Quiet-mode link-budget probe through the phone speaker model.
 * Run: ./node_modules/.bin/tsx scripts/quiet-probe.ts
 */
import { QUIET_48K, type ModemConfig, type Modulation } from '../src/config';
import { StreamingSender, StreamingReceiver } from '../src/link/stream';
import { simulateChannel, activeBandHz } from '../src/channel/simulator';
import { splitmix32 } from '../src/util/prng';

function makeFile(n: number, seed: number): Uint8Array {
  const rng = splitmix32(seed);
  const f = new Uint8Array(n);
  for (let i = 0; i < n; i++) f[i] = Math.floor(rng() * 256);
  return f;
}

function probe(label: string, cfg: ModemConfig, snrDb: number): void {
  const file = makeFile(1_000, 0xaaa);
  const tx = new StreamingSender(file, cfg, 0xaaa);
  const rx = new StreamingReceiver(cfg);
  let done = false;
  rx.onComplete(() => {
    done = true;
  });
  let bursts = 0;
  while (!done && bursts < 25) {
    const wave = tx.nextBurstSamples();
    const heard = simulateChannel(wave, {
      seed: 0x4f00 + bursts,
      sampleRate: cfg.sampleRate,
      bandLimit: { speakerModel: 'phone' },
      rir: 'small-room',
      snrDb,
      snrBandHz: activeBandHz(cfg),
      clockDriftPpm: 10,
      startOffsetSamples: [100, 1500],
    });
    let off = 0;
    while (off < heard.length) {
      rx.push(heard.subarray(off, Math.min(heard.length, off + 2048)));
      off += 2048;
    }
    bursts++;
  }
  const p = rx.progress;
  console.log(
    `${label} @ ${snrDb} dB: complete=${p.complete} bursts=${bursts} ok=${p.framesOk} ` +
      `hdrFail=${p.framesHeaderFail} payFail=${p.framesPayloadFail} det=${rx.diagnostics.burstsDetected}`,
  );
}

for (const mod of ['qpsk', 'bpsk'] as Modulation[]) {
  for (const snr of [20, 25, 30]) {
    const cfg: ModemConfig = { ...QUIET_48K, bitLoading: { uniform: mod } };
    probe(`quiet-${mod}`, cfg, snr);
  }
}
// NOTE: truncating the quiet band (e.g. 17–20.5 kHz) shrinks carriers/symbol
// until a frame no longer fits in one burst — per-band frame geometry is
// Phase 7 (bit-loading) work, not probed here.
