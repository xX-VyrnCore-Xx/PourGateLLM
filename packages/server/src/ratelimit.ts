/** In-memory sliding-window limiter keyed by an arbitrary id. */
export class SlidingWindow {
  private readonly hits = new Map<number, number[]>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns true if it fits under `limit`; otherwise records nothing. */
  take(id: number, limit: number): boolean {
    const t = this.now();
    const recent = (this.hits.get(id) ?? []).filter((ts) => t - ts < this.windowMs);
    if (recent.length >= limit) {
      this.hits.set(id, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(id, recent);
    return true;
  }
}
