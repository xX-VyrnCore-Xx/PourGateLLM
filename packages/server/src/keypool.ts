export interface KeyPoolOptions {
  now?: () => number;
}

/**
 * Round-robin key pool with per-key cooldown and a sliding-window RPM limiter.
 * Counters are in memory; persistence arrives with the SQLite layer.
 */
export class KeyPool {
  private readonly cooldownUntil = new Map<string, number>();
  private readonly hits = new Map<string, number[]>();
  private cursor = 0;
  private readonly now: () => number;

  constructor(
    readonly keys: readonly string[],
    opts: KeyPoolOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Returns the next usable key, or undefined if all are cooling down / over the rpm limit. */
  acquire(rpm?: number, exclude: ReadonlySet<string> = new Set()): string | undefined {
    const t = this.now();
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[(this.cursor + i) % this.keys.length]!;
      if (exclude.has(key)) continue;
      if ((this.cooldownUntil.get(key) ?? 0) > t) continue;
      const recent = (this.hits.get(key) ?? []).filter((ts) => t - ts < 60_000);
      if (rpm !== undefined && recent.length >= rpm) {
        this.hits.set(key, recent);
        continue;
      }
      recent.push(t);
      this.hits.set(key, recent);
      this.cursor = (this.cursor + i + 1) % this.keys.length;
      return key;
    }
    return undefined;
  }

  cooldown(key: string, ms: number): void {
    this.cooldownUntil.set(key, this.now() + ms);
  }
}
