/**
 * Remembers how quickly each target (provider|model) starts answering, as an exponentially weighted average
 * of the time until response headers. Used only as a tie-breaker when routing: quality tier and measured
 * score still come first, and latencies are grouped into coarse buckets so ordinary jitter never reshuffles
 * the order. A target that fails is recorded at the timeout, which pushes it behind healthy ones.
 */
export interface LatencyOptions {
  /** Weight of the newest sample (0-1). */
  alpha?: number;
  /** Anything faster than this is "fast enough": all such targets share bucket 0. */
  floorMs?: number;
  /** Each bucket is this many times slower than the previous one. */
  growth?: number;
  /** Measurements older than this are forgotten, so a slow target gets another chance. */
  staleMs?: number;
  now?: () => number;
}

export class LatencyTracker {
  private readonly avg = new Map<string, { ms: number; samples: number; at: number }>();
  private readonly alpha: number;
  private readonly floorMs: number;
  private readonly growth: number;
  private readonly staleMs: number;
  private readonly now: () => number;

  constructor(opts: LatencyOptions = {}) {
    this.alpha = opts.alpha ?? 0.3;
    this.floorMs = opts.floorMs ?? 400;
    this.growth = opts.growth ?? 2;
    this.staleMs = opts.staleMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  record(target: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const t = this.now();
    const cur = this.avg.get(target);
    const live = cur && t - cur.at < this.staleMs ? cur : undefined;
    this.avg.set(target, live ? { ms: live.ms + this.alpha * (ms - live.ms), samples: live.samples + 1, at: t } : { ms, samples: 1, at: t });
  }

  /** Smoothed latency in ms, or undefined when the target has never been measured. */
  average(target: string): number | undefined {
    const v = this.avg.get(target);
    return v && this.now() - v.at < this.staleMs ? v.ms : undefined;
  }

  /** 0 for unmeasured or fast targets, +1 for every doubling beyond the floor. */
  bucket(target: string): number {
    const ms = this.average(target);
    if (ms === undefined || ms <= this.floorMs) return 0;
    return Math.floor(Math.log(ms / this.floorMs) / Math.log(this.growth)) + 1;
  }

  snapshot(): { target: string; ms: number; samples: number }[] {
    return [...this.avg.entries()]
      .filter(([target]) => this.average(target) !== undefined)
      .map(([target, v]) => ({ target, ms: Math.round(v.ms), samples: v.samples }))
      .sort((a, b) => a.ms - b.ms);
  }
}
