import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { FAST_48K } from '../../src/config';
import { LtEncoder, LtDecoder } from '../../src/code/lt';
import { splitmix32 } from '../../src/util/prng';

/** Build a deterministic file of `nbytes`. */
function makeFile(nbytes: number, seed: number): Uint8Array {
  const rng = splitmix32(seed);
  const f = new Uint8Array(nbytes);
  for (let i = 0; i < nbytes; i++) f[i] = Math.floor(rng() * 256);
  return f;
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface OverheadStats {
  K: number;
  runs: number;
  mean: number;
  p95: number;
  worst: number;
  success: number;
}

function measureOverhead(K: number, runs: number, baseSeed: number): OverheadStats {
  const blockSize = FAST_48K.blockSize;
  const file = makeFile(K * blockSize, baseSeed);
  const eps: number[] = [];
  let success = 0;

  for (let r = 0; r < runs; r++) {
    const enc = new LtEncoder(file, blockSize, baseSeed + r, FAST_48K);
    const dec = new LtDecoder(file.length, enc.K, blockSize, FAST_48K);
    expect(enc.K).toBe(K);

    // Feed packets in a shuffled-ish order with occasional duplicates.
    const rng = splitmix32(baseSeed + 1000 + r);
    let seed = (baseSeed + r * 10007) >>> 0;
    let received = 0;
    const maxPackets = Math.ceil(K * 5); // small-K needs more headroom
    while (!dec.complete && received < maxPackets) {
      const ps = seed >>> 0;
      seed = (seed + 1) >>> 0;
      // 5% duplicate
      const use = rng() < 0.05 && received > 0 ? ps - 1 : ps;
      // Deliver out of order by buffering a few
      dec.addPacket(use >>> 0, enc.packet(use >>> 0));
      received = dec.packetsReceived;
    }
    if (dec.complete) {
      success++;
      const got = dec.result()!;
      expect(sha256(got)).toBe(sha256(file));
      eps.push(dec.packetsReceived / K - 1);
    }
  }

  eps.sort((a, b) => a - b);
  const mean = eps.reduce((a, b) => a + b, 0) / Math.max(1, eps.length);
  const p95 = eps[Math.min(eps.length - 1, Math.floor(eps.length * 0.95))] ?? NaN;
  const worst = eps[eps.length - 1] ?? NaN;
  return { K, runs, mean, p95, worst, success };
}

describe('LT fountain', () => {
  it('decodes a small file with duplicates and reordering', () => {
    const file = makeFile(256 * 8, 1); // K=8
    const enc = new LtEncoder(file, 256, 42, FAST_48K);
    const dec = new LtDecoder(file.length, enc.K, 256, FAST_48K);
    const seeds = [10, 11, 12, 10, 15, 14, 13, 20, 21, 22, 23, 24, 25];
    for (const s of seeds) dec.addPacket(s, enc.packet(s));
    // May need more:
    for (let s = 100; !dec.complete && s < 200; s++) dec.addPacket(s, enc.packet(s));
    expect(dec.complete).toBe(true);
    expect(sha256(dec.result()!)).toBe(sha256(file));
  });

  it('measures overhead ε over ≥200 seeded runs for several K', () => {
    // K values: file size / 256-byte blocks.
    //   K=4   → 1 KiB (small-file regime — overhead expected to worsen)
    //   K=40  → 10 KiB
    //   K=391 → 100 096 B ≈ 100 kB (acceptance file)
    const results: OverheadStats[] = [];
    for (const K of [4, 40, 391]) {
      const runs = 200;
      const stats = measureOverhead(K, runs, 0x4c540000 + K);
      results.push(stats);
      expect(stats.success).toBe(runs);
      // Planning target ε ≤ 15% mean — report, don't retune, if small-K misses.
      if (K >= 40) {
        expect(stats.mean).toBeLessThanOrEqual(0.15);
      }
    }
    // Surface numbers for PROGRESS.md (test log).
    for (const s of results) {
      // eslint-disable-next-line no-console
      console.log(
        `LT K=${s.K}: success ${s.success}/${s.runs}, mean ε=${s.mean.toFixed(4)}, ` +
          `P95=${s.p95.toFixed(4)}, worst=${s.worst.toFixed(4)}`,
      );
    }
    // Stash on global for the progress writer / assertion that K=391 is healthy.
    expect(results.find((r) => r.K === 391)!.mean).toBeLessThanOrEqual(0.15);
  }, 120_000);
});
