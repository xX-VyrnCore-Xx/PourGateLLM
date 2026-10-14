/** In-memory sliding-window limiter keyed by a token id or any string. */
export class SlidingWindow {
  private readonly hits = new Map<string | number, number[]>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns true if it fits under `limit`; otherwise records nothing. */
  take(id: string | number, limit: number): boolean {
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
