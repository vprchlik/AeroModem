/**
 * FileSender — file → endless fountain of OFDM-ready burst bitstreams.
 *
 * Each call to nextBurstBits() emits `framesPerBurst` LT packets, each wrapped
 * in a robust-header + FEC + interleaved frame, packed into the burst's data
 * symbols (BPSK header symbols + payload-mod symbols). Leftover symbols are
 * zero-filled. Transmission is endless: packetSeed increments forever so a
 * receiver can join late and the fountain keeps covering erasures.
 */

import type { ModemConfig } from '../config';
import { LtEncoder } from '../code/lt';
import { encodeFrame, HEADER_MAGIC, type FrameHeader } from '../code/frame';
import { frameGeometry, burstSymbolMods } from '../code/geometry';
import { assert } from '../util/assert';

export interface SenderOptions {
  interleave?: boolean;
}

export class FileSender {
  readonly cfg: ModemConfig;
  readonly file: Uint8Array;
  readonly sessionId: number;
  readonly encoder: LtEncoder;
  readonly geometry: ReturnType<typeof frameGeometry>;
  readonly symbolMods: ReturnType<typeof burstSymbolMods>;
  private packetSeed: number;
  private _packetsSent = 0;
  private readonly interleave: boolean;

  constructor(
    file: Uint8Array,
    cfg: ModemConfig,
    sessionSeed: number,
    opts: SenderOptions = {},
  ) {
    this.cfg = cfg;
    this.file = file;
    this.sessionId = sessionSeed >>> 0;
    this.encoder = new LtEncoder(file, cfg.blockSize, sessionSeed, cfg);
    this.geometry = frameGeometry(cfg);
    this.symbolMods = burstSymbolMods(cfg, this.geometry);
    this.packetSeed = (sessionSeed ^ 0xa5a5_0001) >>> 0;
    this.interleave = opts.interleave !== false;
    assert(this.geometry.framesPerBurst >= 1, 'burst too short for one frame');
  }

  get packetsSent(): number {
    return this._packetsSent;
  }

  get K(): number {
    return this.encoder.K;
  }

  /** Bits for one OFDM burst (length = sum of per-symbol bit capacities). */
  nextBurstBits(): Uint8Array {
    const g = this.geometry;
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let f = 0; f < g.framesPerBurst; f++) {
      const seed = this.packetSeed >>> 0;
      this.packetSeed = (this.packetSeed + 1) >>> 0;
      const payload = this.encoder.packet(seed);
      const header: FrameHeader = {
        magic: HEADER_MAGIC,
        sessionId: this.sessionId,
        fileLength: this.file.length,
        K: this.encoder.K,
        blockSize: this.cfg.blockSize,
        packetSeed: seed,
        flags: 0,
      };
      const enc = encodeFrame(header, payload, this.cfg, { interleave: this.interleave });
      parts.push(enc.bits);
      total += enc.bits.length;
      this._packetsSent++;
    }
    // Leftover symbol capacity (BPSK zeros).
    const leftoverBits = g.leftoverSymbols * g.headerBitsPerSymbol;
    total += leftoverBits;

    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    // leftover already zero-filled
    return out;
  }
}
