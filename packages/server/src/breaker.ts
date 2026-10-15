/**
 * Per-target circuit breaker. After `threshold` consecutive failures (network errors, timeouts, 5xx)
 * a target is treated as down for an exponentially growing pause (`baseMs`, doubling up to `maxMs`).
 * When the pause ends the next request is let through as a probe: success closes the circuit,
 * another failure re-opens it for twice as long. Rate limits (429) are not failures.
 */
export interface BreakerOptions {
  threshold?: number;
  baseMs?: number;
  maxMs?: number;
  now?: () => number;
}

interface State {
  failures: number;
  trips: number;
  until: number;
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export class Breaker {
  private readonly states = new Map<string, State>();
  private readonly threshold: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly now: () => number;

  constructor(opts: BreakerOptions = {}) {
    this.threshold = opts.threshold ?? 5;
    this.baseMs = opts.baseMs ?? 30_000;
    this.maxMs = opts.maxMs ?? 300_000;
    this.now = opts.now ?? Date.now;
  }

  state(id: string): BreakerState {
    const s = this.states.get(id);
    if (!s || s.failures < this.threshold) return 'closed';
    return this.now() < s.until ? 'open' : 'half-open';
  }

  /** True while the target should be avoided. */
  isOpen(id: string): boolean {
    return this.state(id) === 'open';
  }

  success(id: string): void {
    this.states.delete(id);
  }

  failure(id: string): void {
    const s = this.states.get(id) ?? { failures: 0, trips: 0, until: 0 };
    s.failures++;
    if (s.failures >= this.threshold) {
      // Count a trip only when a fresh pause starts (first trip, or a failed probe).
      if (this.now() >= s.until) s.trips++;
      s.until = this.now() + Math.min(this.baseMs * 2 ** (s.trips - 1), this.maxMs);
    }
    this.states.set(id, s);
  }

  /** Remaining pause in ms for an open target (0 otherwise). */
  retryInMs(id: string): number {
    const s = this.states.get(id);
    return s && this.state(id) === 'open' ? Math.max(0, s.until - this.now()) : 0;
  }
}
