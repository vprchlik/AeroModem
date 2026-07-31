/**
 * LT (Luby Transform) fountain encoder / decoder.
 *
 * Encoder: each packetSeed independently draws a robust-soliton degree and a
 * set of distinct source-block neighbors via splitmix32(packetSeed); the
 * payload is the XOR of those blocks (truncated last block zero-padded).
 *
 * Decoder: peeling (belief propagation). When peeling stalls with ≥ K received
 * packets, solve the residual sparse system over GF(2) by Gaussian elimination
 * (inactivation). This cuts mean overhead well below pure-peeling levels.
 */

import type { ModemConfig } from '../config';
import { splitmix32 } from '../util/prng';
import { assert } from '../util/assert';
import { robustSolitonCdf, sampleDegree } from './soliton';

/** Deterministic neighbor set for (K, packetSeed, degree). */
export function ltNeighbors(K: number, packetSeed: number, degree: number): number[] {
  assert(degree >= 1 && degree <= K, 'degree out of range');
  const rng = splitmix32(packetSeed ^ 0x4c540001);
  // Skip the degree draw's corresponding entropy by using a dedicated stream.
  const chosen = new Set<number>();
  while (chosen.size < degree) {
    chosen.add(Math.floor(rng() * K));
  }
  return [...chosen].sort((a, b) => a - b);
}

export function ltDegree(K: number, packetSeed: number, c: number, delta: number): number {
  const cdf = robustSolitonCdf(K, c, delta);
  const rng = splitmix32(packetSeed ^ 0x4c540000);
  return sampleDegree(cdf, rng());
}

function xorBlock(dst: Uint8Array, src: Uint8Array): void {
  for (let i = 0; i < dst.length; i++) dst[i]! ^= src[i]!;
}

export class LtEncoder {
  readonly K: number;
  readonly blockSize: number;
  readonly fileLength: number;
  readonly sessionSeed: number;
  private readonly blocks: Uint8Array[];
  private readonly c: number;
  private readonly delta: number;
  private readonly cdf: Float64Array;

  constructor(source: Uint8Array, blockSize: number, sessionSeed: number, cfg: ModemConfig) {
    assert(blockSize > 0, 'blockSize must be > 0');
    this.fileLength = source.length;
    this.blockSize = blockSize;
    this.sessionSeed = sessionSeed;
    this.c = cfg.ltSolitonC;
    this.delta = cfg.ltSolitonDelta;
    this.K = Math.max(1, Math.ceil(source.length / blockSize));
    this.cdf = robustSolitonCdf(this.K, this.c, this.delta);

    this.blocks = [];
    for (let i = 0; i < this.K; i++) {
      const b = new Uint8Array(blockSize);
      const off = i * blockSize;
      const n = Math.min(blockSize, Math.max(0, source.length - off));
      if (n > 0) b.set(source.subarray(off, off + n));
      this.blocks.push(b);
    }
  }

  /** Degree + neighbors for a packet seed (exposed for tests). */
  degreeAndNeighbors(packetSeed: number): { degree: number; neighbors: number[] } {
    const rng = splitmix32(packetSeed ^ 0x4c540000);
    const degree = sampleDegree(this.cdf, rng());
    const neighbors = ltNeighbors(this.K, packetSeed, degree);
    return { degree, neighbors };
  }

  /** XOR of the chosen source blocks (length = blockSize). */
  packet(packetSeed: number): Uint8Array {
    const { neighbors } = this.degreeAndNeighbors(packetSeed);
    const out = new Uint8Array(this.blockSize);
    for (const i of neighbors) xorBlock(out, this.blocks[i]!);
    return out;
  }
}

interface RxPacket {
  seed: number;
  neighbors: number[]; // unresolved block indices
  payload: Uint8Array;
}

export class LtDecoder {
  readonly fileLength: number;
  readonly K: number;
  readonly blockSize: number;
  private readonly c: number;
  private readonly delta: number;
  private readonly cdf: Float64Array;
  private readonly blocks: (Uint8Array | null)[];
  private readonly resolved: boolean[];
  private packets: RxPacket[] = [];
  private seen = new Set<number>();
  private _decoded = 0;

  constructor(fileLength: number, K: number, blockSize: number, cfg: ModemConfig) {
    this.fileLength = fileLength;
    this.K = K;
    this.blockSize = blockSize;
    this.c = cfg.ltSolitonC;
    this.delta = cfg.ltSolitonDelta;
    this.cdf = robustSolitonCdf(K, this.c, this.delta);
    this.blocks = Array.from({ length: K }, () => null);
    this.resolved = Array.from({ length: K }, () => false);
  }

  get decodedBlocks(): number {
    return this._decoded;
  }

  get complete(): boolean {
    return this._decoded >= this.K;
  }

  get packetsReceived(): number {
    return this.seen.size;
  }

  addPacket(packetSeed: number, payload: Uint8Array): void {
    if (this.complete) return;
    if (this.seen.has(packetSeed)) return;
    this.seen.add(packetSeed);
    assert(payload.length === this.blockSize, 'payload size mismatch');

    const rng = splitmix32(packetSeed ^ 0x4c540000);
    const degree = sampleDegree(this.cdf, rng());
    let neighbors = ltNeighbors(this.K, packetSeed, degree);
    const buf = payload.slice();

    // Cancel already-resolved neighbors.
    const unresolved: number[] = [];
    for (const i of neighbors) {
      if (this.resolved[i]) xorBlock(buf, this.blocks[i]!);
      else unresolved.push(i);
    }

    if (unresolved.length === 0) return; // redundant
    this.packets.push({ seed: packetSeed, neighbors: unresolved, payload: buf });
    this.peel();
    if (!this.complete && this.packets.length >= 1) this.tryGaussianElimination();
  }

  result(): Uint8Array | null {
    if (!this.complete) return null;
    const out = new Uint8Array(this.fileLength);
    for (let i = 0; i < this.K; i++) {
      const b = this.blocks[i]!;
      const off = i * this.blockSize;
      const n = Math.min(this.blockSize, this.fileLength - off);
      if (n > 0) out.set(b.subarray(0, n), off);
    }
    return out;
  }

  private resolve(index: number, value: Uint8Array): void {
    if (this.resolved[index]) return;
    // Copy first: callers often pass a packet's own payload buffer; XORing
    // that buffer with itself while updating neighbors would zero it mid-loop
    // and corrupt the cancellation into other packets.
    const v = value.slice();
    this.blocks[index] = v;
    this.resolved[index] = true;
    this._decoded++;
    for (const p of this.packets) {
      const idx = p.neighbors.indexOf(index);
      if (idx >= 0) {
        xorBlock(p.payload, v);
        p.neighbors.splice(idx, 1);
      }
    }
  }

  private peel(): void {
    let progressed = true;
    while (progressed && !this.complete) {
      progressed = false;
      // Collect degree-1 packets.
      for (let i = 0; i < this.packets.length; i++) {
        const p = this.packets[i]!;
        if (p.neighbors.length === 1) {
          const bi = p.neighbors[0]!;
          if (!this.resolved[bi]) {
            this.resolve(bi, p.payload);
            progressed = true;
          }
        }
      }
      // Drop empty / fully-resolved packets.
      this.packets = this.packets.filter((p) => p.neighbors.length > 0);
    }
  }

  /**
   * On peel stall: build the residual GF(2) system (one row per unresolved
   * packet over unresolved blocks) and solve via Gaussian elimination.
   * Block values are recovered by back-substitution using the XOR payloads.
   */
  private tryGaussianElimination(): void {
    if (this.complete) return;

    const unresolvedIdx: number[] = [];
    for (let i = 0; i < this.K; i++) if (!this.resolved[i]) unresolvedIdx.push(i);
    const u = unresolvedIdx.length;
    if (u === 0) return;

    // Map block index → column.
    const colOf = new Map<number, number>();
    for (let c = 0; c < u; c++) colOf.set(unresolvedIdx[c]!, c);

    // Keep packets that touch the residual; need ≥ u equations.
    const rows = this.packets.filter((p) => p.neighbors.some((n) => colOf.has(n)));
    if (rows.length < u) return;

    // Bit-packed GF(2) matrix: each row is a Uint8Array of ceil(u/8) bytes +
    // we store RHS as a separate Uint8Array[blockSize] per row.
    const width = (u + 7) >> 3;
    const A: Uint8Array[] = [];
    const rhs: Uint8Array[] = [];
    for (const p of rows) {
      const row = new Uint8Array(width);
      for (const n of p.neighbors) {
        const c = colOf.get(n);
        if (c === undefined) continue;
        row[c >> 3]! |= 1 << (c & 7);
      }
      A.push(row);
      rhs.push(p.payload.slice());
    }

    const m = A.length;
    const pivotCol = new Int32Array(u).fill(-1);
    let rank = 0;

    for (let col = 0; col < u && rank < m; col++) {
      // Find pivot.
      let piv = -1;
      for (let r = rank; r < m; r++) {
        if (A[r]![col >> 3]! & (1 << (col & 7))) {
          piv = r;
          break;
        }
      }
      if (piv < 0) continue;
      // Swap into place.
      if (piv !== rank) {
        const tmpA = A[rank]!;
        A[rank] = A[piv]!;
        A[piv] = tmpA;
        const tmpR = rhs[rank]!;
        rhs[rank] = rhs[piv]!;
        rhs[piv] = tmpR;
      }
      pivotCol[col] = rank;

      // Eliminate.
      for (let r = 0; r < m; r++) {
        if (r === rank) continue;
        if (A[r]![col >> 3]! & (1 << (col & 7))) {
          for (let w = 0; w < width; w++) A[r]![w]! ^= A[rank]![w]!;
          xorBlock(rhs[r]!, rhs[rank]!);
        }
      }
      rank++;
    }

    if (rank < u) return; // underdetermined — wait for more packets

    // Back-substitute: full column rank ⇒ unique solution.
    const solved = Array.from({ length: u }, () => new Uint8Array(this.blockSize));
    for (let col = u - 1; col >= 0; col--) {
      const pr = pivotCol[col]!;
      if (pr < 0) return; // should not happen when rank === u
      const val = rhs[pr]!.slice();
      for (let c2 = col + 1; c2 < u; c2++) {
        if (A[pr]![c2 >> 3]! & (1 << (c2 & 7))) xorBlock(val, solved[c2]!);
      }
      solved[col] = val;
    }

    // Consistency: zero-rows must have zero RHS.
    for (let r = 0; r < m; r++) {
      let empty = true;
      for (let w = 0; w < width; w++) {
        if (A[r]![w]) {
          empty = false;
          break;
        }
      }
      if (!empty) continue;
      for (let i = 0; i < this.blockSize; i++) {
        if (rhs[r]![i]) return; // inconsistent
      }
    }

    for (let c = 0; c < u; c++) this.resolve(unresolvedIdx[c]!, solved[c]!);
    this.peel();
  }
}
