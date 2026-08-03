/**
 * Screen wake lock during transfers (phones sleep mid-transfer otherwise).
 * Uses the Screen Wake Lock API where available (Chrome Android, iOS 16.4+
 * Safari); silently degrades elsewhere — the caller can show a hint.
 */

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', cb: () => void): void;
}

export class WakeLockKeeper {
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;
  private readonly onVisibility = (): void => {
    if (this.wanted && document.visibilityState === 'visible') {
      void this.request();
    }
  };

  get supported(): boolean {
    return 'wakeLock' in navigator;
  }

  get active(): boolean {
    return this.sentinel !== null;
  }

  async acquire(): Promise<boolean> {
    this.wanted = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    return this.request();
  }

  private async request(): Promise<boolean> {
    if (!this.supported) return false;
    try {
      const nav = navigator as Navigator & {
        wakeLock: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
      };
      this.sentinel = await nav.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
      });
      return true;
    } catch {
      this.sentinel = null;
      return false;
    }
  }

  async release(): Promise<void> {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.sentinel) {
      try {
        await this.sentinel.release();
      } catch {
        /* already released */
      }
      this.sentinel = null;
    }
  }
}
