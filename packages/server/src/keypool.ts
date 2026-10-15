import { createHash } from 'node:crypto';
import { utcDay } from './tokens.js';

export interface DailyUsage {
  requests: number;
  tokens: number;
}

/** Where per-(key, model) counters and key cooldowns live. Keys are identified by fingerprint only. */
export interface UsageBackend {
  daily(fp: string, model: string, day: string): DailyUsage;
  addRequest(fp: string, model: string, day: string): void;
  addTokens(fp: string, model: string, day: string, tokens: number): void;
  /** Sum over all keys of the provider, for dashboards. */
  totalToday(model: string, day: string): DailyUsage;
  cooldowns(): Map<string, number>;
  setCooldown(fp: string, until: number): void;
}

export class MemoryUsage implements UsageBackend {
  private readonly counters = new Map<string, DailyUsage>();
  private readonly cools = new Map<string, number>();
  private slot(fp: string, model: string, day: string): DailyUsage {
    const k = `${fp}|${model}|${day}`;
    let v = this.counters.get(k);
    if (!v) this.counters.set(k, (v = { requests: 0, tokens: 0 }));
    return v;
  }
  daily(fp: string, model: string, day: string): DailyUsage {
    return { ...this.slot(fp, model, day) };
  }
  addRequest(fp: string, model: string, day: string): void {
    this.slot(fp, model, day).requests++;
  }
  addTokens(fp: string, model: string, day: string, tokens: number): void {
    this.slot(fp, model, day).tokens += tokens;
  }
  totalToday(model: string, day: string): DailyUsage {
    const total = { requests: 0, tokens: 0 };
    for (const [k, v] of this.counters) {
      const [, m, d] = k.split('|');
      if (m === model && d === day) {
        total.requests += v.requests;
        total.tokens += v.tokens;
      }
    }
    return total;
  }
  cooldowns(): Map<string, number> {
    return new Map(this.cools);
  }
  setCooldown(fp: string, until: number): void {
    this.cools.set(fp, until);
  }
}

export interface KeyPoolOptions {
  now?: () => number;
  backend?: UsageBackend;
  /** Stable, non-reversible identifier for a key. Defaults to a truncated SHA-256. */
  fingerprint?: (key: string) => string;
  /** Relative share of traffic per key (default 1). */
  weights?: ReadonlyMap<string, number>;
}

export interface AcquireLimits {
  model: string;
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
}

const MINUTE = 60_000;

/**
 * Weighted round-robin key pool. Limits are enforced per (key, model): rpm/tpm with in-memory sliding windows,
 * rpd/tpd with day counters (UTC) and cooldowns kept in the usage backend, so they survive restarts
 * when the backend is persistent.
 */
export class KeyPool {
  private _keys: readonly string[];
  private cooldownUntil: Map<string, number>;
  private readonly reqWindow = new Map<string, number[]>();
  private readonly tokWindow = new Map<string, { ts: number; tokens: number }[]>();
  private readonly credit = new Map<string, number>();
  private weights = new Map<string, number>();
  private readonly now: () => number;
  private readonly backend: UsageBackend;
  private readonly fp: (key: string) => string;

  constructor(keys: readonly string[], opts: KeyPoolOptions = {}) {
    this._keys = keys;
    this.weights = new Map(opts.weights);
    this.now = opts.now ?? Date.now;
    this.backend = opts.backend ?? new MemoryUsage();
    this.fp = opts.fingerprint ?? ((k) => createHash('sha256').update(k).digest('hex').slice(0, 24));
    this.cooldownUntil = this.backend.cooldowns();
  }

  get keys(): readonly string[] {
    return this._keys;
  }

  /** Replaces the key set, keeping state of keys that remain. `weights` (default 1 each) bias the rotation. */
  setKeys(keys: readonly string[], weights?: ReadonlyMap<string, number>): void {
    const keep = new Set(keys.map((k) => this.fp(k)));
    this.weights = new Map(weights);
    for (const k of [...this.credit.keys()]) if (!keep.has(k)) this.credit.delete(k);
    for (const k of [...this.cooldownUntil.keys()]) if (!keep.has(k)) this.cooldownUntil.delete(k);
    for (const map of [this.reqWindow, this.tokWindow] as Map<string, unknown>[]) {
      for (const k of [...map.keys()]) if (!keep.has(k.split('|')[0]!)) map.delete(k);
    }
    this._keys = keys;
  }

  /** Returns the next key allowed to serve `limits.model`, or undefined if none is. Counts the request. */
  acquire(limits: AcquireLimits, exclude: ReadonlySet<string> = new Set()): string | undefined {
    const t = this.now();
    const day = utcDay(t);
    const eligible: { key: string; fp: string; reqs: number[] }[] = [];
    for (const key of this._keys) {
      if (exclude.has(key)) continue;
      const fp = this.fp(key);
      if ((this.cooldownUntil.get(fp) ?? 0) > t) continue;
      const slot = `${fp}|${limits.model}`;
      const reqs = (this.reqWindow.get(slot) ?? []).filter((ts) => t - ts < MINUTE);
      this.reqWindow.set(slot, reqs);
      if (limits.rpm !== undefined && reqs.length >= limits.rpm) continue;
      const toks = (this.tokWindow.get(slot) ?? []).filter((e) => t - e.ts < MINUTE);
      this.tokWindow.set(slot, toks);
      if (limits.tpm !== undefined && toks.reduce((n, e) => n + e.tokens, 0) >= limits.tpm) continue;
      if (limits.rpd !== undefined || limits.tpd !== undefined) {
        const d = this.backend.daily(fp, limits.model, day);
        if (limits.rpd !== undefined && d.requests >= limits.rpd) continue;
        if (limits.tpd !== undefined && d.tokens >= limits.tpd) continue;
      }
      eligible.push({ key, fp, reqs });
    }
    if (eligible.length === 0) return undefined;

    // Smooth weighted round-robin (as in nginx): equal weights give plain rotation, a key with weight 3
    // serves three requests for every one of a weight-1 key, interleaved rather than in bursts.
    let total = 0;
    let best = eligible[0]!;
    let bestScore = -Infinity;
    for (const e of eligible) {
      const w = this.weights.get(e.key) ?? 1;
      const score = (this.credit.get(e.fp) ?? 0) + w;
      this.credit.set(e.fp, score);
      total += w;
      if (score > bestScore) {
        best = e;
        bestScore = score;
      }
    }
    this.credit.set(best.fp, bestScore - total);
    best.reqs.push(t);
    this.backend.addRequest(best.fp, limits.model, day);
    return best.key;
  }

  /** Records tokens reported by the provider for a completed request. */
  recordTokens(key: string, model: string, tokens: number): void {
    if (!(tokens > 0)) return;
    const t = this.now();
    const fp = this.fp(key);
    const slot = `${fp}|${model}`;
    const toks = this.tokWindow.get(slot) ?? [];
    toks.push({ ts: t, tokens });
    this.tokWindow.set(slot, toks);
    this.backend.addTokens(fp, model, utcDay(t), tokens);
  }

  /** Requests/tokens served today for a model, summed over all keys. */
  usageToday(model: string): DailyUsage {
    return this.backend.totalToday(model, utcDay(this.now()));
  }

  /** Number of keys currently cooling down. */
  coolingCount(): number {
    const t = this.now();
    return this._keys.filter((k) => (this.cooldownUntil.get(this.fp(k)) ?? 0) > t).length;
  }

  /** Rests a key for `ms`. A longer cooldown already in place is never shortened. */
  cooldown(key: string, ms: number): void {
    const fp = this.fp(key);
    const until = Math.max(this.now() + ms, this.cooldownUntil.get(fp) ?? 0);
    this.cooldownUntil.set(fp, until);
    this.backend.setCooldown(fp, until);
  }
}
