/**
 * FileReceiver — burst LLRs → deinterleave/Viterbi/frames → LT decode → file.
 *
 * Locks onto the first valid header's sessionId; frames from other sessions
 * are ignored. Reports header vs payload failures separately.
 */

import type { ModemConfig } from '../config';
import { LtDecoder } from '../code/lt';
import { decodeFrame } from '../code/frame';
import { frameGeometry, burstSymbolMods } from '../code/geometry';
import { assert } from '../util/assert';

export interface ReceiveProgress {
  sessionId: number | null;
  fileLength: number | null;
  K: number | null;
  blocksDecoded: number;
  framesOk: number;
  framesHeaderFail: number;
  framesPayloadFail: number;
  packetsAccepted: number;
  complete: boolean;
}

export interface ReceiverOptions {
  interleave?: boolean;
}

export class FileReceiver {
  readonly cfg: ModemConfig;
  readonly geometry: ReturnType<typeof frameGeometry>;
  readonly symbolMods: ReturnType<typeof burstSymbolMods>;
  private decoder: LtDecoder | null = null;
  private sessionId: number | null = null;
  private fileLength: number | null = null;
  private K: number | null = null;
  private framesOk = 0;
  private framesHeaderFail = 0;
  private framesPayloadFail = 0;
  private packetsAccepted = 0;
  private readonly interleave: boolean;
  private completeCb: ((file: Uint8Array) => void) | null = null;
  private finished = false;

  constructor(cfg: ModemConfig, opts: ReceiverOptions = {}) {
    this.cfg = cfg;
    this.geometry = frameGeometry(cfg);
    this.symbolMods = burstSymbolMods(cfg, this.geometry);
    this.interleave = opts.interleave !== false;
  }

  get progress(): ReceiveProgress {
    return {
      sessionId: this.sessionId,
      fileLength: this.fileLength,
      K: this.K,
      blocksDecoded: this.decoder?.decodedBlocks ?? 0,
      framesOk: this.framesOk,
      framesHeaderFail: this.framesHeaderFail,
      framesPayloadFail: this.framesPayloadFail,
      packetsAccepted: this.packetsAccepted,
      complete: this.finished,
    };
  }

  onComplete(cb: (file: Uint8Array) => void): void {
    this.completeCb = cb;
  }

  /**
   * Push LLRs for one full burst (concatenation of per-symbol demapper outputs
   * under the Phase 5 symbolMods schedule).
   */
  pushLlrs(llrs: Float32Array): void {
    if (this.finished) return;
    const g = this.geometry;
    const frameBits = g.headerCapacityBits + g.payloadCapacityBits;
    assert(
      llrs.length >= g.framesPerBurst * frameBits,
      `burst LLRs too short: ${llrs.length} < ${g.framesPerBurst * frameBits}`,
    );

    for (let f = 0; f < g.framesPerBurst; f++) {
      const off = f * frameBits;
      const slice = llrs.subarray(off, off + frameBits);
      const { frame, stats } = decodeFrame(slice, this.cfg, { interleave: this.interleave });
      if (!stats.headerOk) {
        this.framesHeaderFail++;
        continue;
      }
      if (!stats.payloadOk) {
        this.framesPayloadFail++;
        continue;
      }
      assert(frame, 'frame null despite ok stats');

      // Session lock.
      if (this.sessionId === null) {
        this.sessionId = frame.header.sessionId;
        this.fileLength = frame.header.fileLength;
        this.K = frame.header.K;
        assert(frame.header.blockSize === this.cfg.blockSize, 'blockSize mismatch');
        this.decoder = new LtDecoder(
          frame.header.fileLength,
          frame.header.K,
          frame.header.blockSize,
          this.cfg,
        );
      } else if (frame.header.sessionId !== this.sessionId) {
        continue;
      }

      this.framesOk++;
      this.decoder!.addPacket(frame.header.packetSeed, frame.payload);
      this.packetsAccepted = this.decoder!.packetsReceived;

      if (this.decoder!.complete && !this.finished) {
        const file = this.decoder!.result();
        assert(file, 'decoder complete but result null');
        this.finished = true;
        this.completeCb?.(file);
      }
    }
  }

  result(): Uint8Array | null {
    return this.decoder?.result() ?? null;
  }

  /** 0/1 per source block (empty until the session header is seen). */
  blockBitmap(): Uint8Array {
    return this.decoder?.blockBitmap() ?? new Uint8Array(0);
  }
}
