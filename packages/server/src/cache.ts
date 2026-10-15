import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type CacheMode = 'deterministic' | 'all';

/** How a cacheable request was served. */
export type CacheResult = 'hit' | 'semantic' | 'stale' | 'coalesced' | 'miss';
export const CACHE_RESULTS: readonly CacheResult[] = ['hit', 'semantic', 'stale', 'coalesced', 'miss'];

export interface CacheOptions {
  ttlMs: number;
  maxEntries: number;
  /** deterministic: only requests with temperature 0 or a seed · all: every non-streaming request. */
  mode: CacheMode;
  /** After expiry an entry is kept this long and served only when every provider is failing (default 0 = off). */
  staleMs?: number;
  /** Upper bound for stored response bytes; the oldest entries go first (default unlimited). */
  maxBytes?: number;
}

export interface CachedResponse {
  body: string;
  provider: string | null;
  model: string | null;
  tier: string | null;
  complexity: string | null;
  ageMs: number;
}

export interface CacheStats {
  entries: number;
  hits: number;
  bytes: number;
  /** Counters since the process started. */
  served: Record<CacheResult, number>;
}

/** Largest response kept in the cache. */
export const MAX_CACHED_BYTES = 256 * 1024;

// Fields that do not change the completion and must not split cache entries.
const IGNORED = new Set(['stream', 'stream_options', 'user', 'metadata']);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function parseCacheMode(v: string | undefined): CacheMode {
  const s = (v ?? 'deterministic').trim().toLowerCase();
  if (s === 'deterministic' || s === 'all') return s;
  throw new Error(`POURGATE_CACHE_MODE must be deterministic or all (got "${v}")`);
}

/**
 * Exact-match response cache. Entries are scoped to the calling client (a response is never served to a
 * different token) and to the effective privacy settings. Only completed, non-streaming 200 JSON responses are stored.
 */
export class ResponseCache {
  constructor(
    private readonly db: DatabaseSync,
    private readonly opts: CacheOptions,
    private readonly now: () => number = Date.now,
  ) {}

  private readonly served: Record<CacheResult, number> = { hit: 0, semantic: 0, stale: 0, coalesced: 0, miss: 0 };

  /** Counts how a request was served (for stats). */
  note(result: CacheResult): void {
    this.served[result]++;
  }

  get mode(): CacheMode {
    return this.opts.mode;
  }

  eligible(payload: Record<string, unknown>): boolean {
    if (payload.stream === true) return false;
    if (this.opts.mode === 'all') return true;
    return payload.temperature === 0 || typeof payload.seed === 'number';
  }

  key(scope: string, payload: Record<string, unknown>, privacyTag: string): string {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) if (!IGNORED.has(k)) rest[k] = v;
    return createHash('sha256').update(`${scope}\n${privacyTag}\n${canonical(rest)}`).digest('hex');
  }

  get(key: string): CachedResponse | undefined {
    const row = this.db.prepare('SELECT * FROM response_cache WHERE key = ?').get(key) as
      | { body: string; provider: string | null; model: string | null; tier: string | null; complexity: string | null; created_at: number; expires_at: number }
      | undefined;
    if (!row) return undefined;
    const t = this.now();
    if (row.expires_at <= t) {
      // Past its life: gone, unless it is still inside the stale window (kept for getStale only).
      if (row.expires_at + (this.opts.staleMs ?? 0) <= t) this.db.prepare('DELETE FROM response_cache WHERE key = ?').run(key);
      return undefined;
    }
    this.db.prepare('UPDATE response_cache SET hits = hits + 1 WHERE key = ?').run(key);
    return { body: row.body, provider: row.provider, model: row.model, tier: row.tier, complexity: row.complexity, ageMs: t - row.created_at };
  }

  /** An expired entry still inside the stale window, for use when every provider is failing. */
  getStale(key: string): CachedResponse | undefined {
    const staleMs = this.opts.staleMs ?? 0;
    if (staleMs <= 0) return undefined;
    const row = this.db.prepare('SELECT * FROM response_cache WHERE key = ?').get(key) as
      | { body: string; provider: string | null; model: string | null; tier: string | null; complexity: string | null; created_at: number; expires_at: number }
      | undefined;
    const t = this.now();
    if (!row || row.expires_at + staleMs <= t) return undefined;
    return { body: row.body, provider: row.provider, model: row.model, tier: row.tier, complexity: row.complexity, ageMs: t - row.created_at };
  }

  set(key: string, entry: Omit<CachedResponse, 'ageMs'>): void {
    if (Buffer.byteLength(entry.body) > MAX_CACHED_BYTES) return;
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO response_cache (key, created_at, expires_at, hits, body, provider, model, tier, complexity, size)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET created_at = excluded.created_at, expires_at = excluded.expires_at, body = excluded.body,
           provider = excluded.provider, model = excluded.model, tier = excluded.tier, complexity = excluded.complexity, size = excluded.size`,
      )
      .run(key, t, t + this.opts.ttlMs, entry.body, entry.provider, entry.model, entry.tier, entry.complexity, Buffer.byteLength(entry.body));
    this.db.prepare('DELETE FROM response_cache WHERE expires_at + ? <= ?').run(this.opts.staleMs ?? 0, t);
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM response_cache').get() as { n: number };
    if (n > this.opts.maxEntries) {
      this.db
        .prepare('DELETE FROM response_cache WHERE key IN (SELECT key FROM response_cache ORDER BY created_at LIMIT ?)')
        .run(n - this.opts.maxEntries);
    }
    if (this.opts.maxBytes !== undefined) {
      let { bytes } = this.db.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM response_cache').get() as { bytes: number };
      while (bytes > this.opts.maxBytes) {
        const oldest = this.db.prepare('SELECT key, size FROM response_cache ORDER BY created_at, rowid LIMIT 1').get() as { key: string; size: number } | undefined;
        if (!oldest || oldest.key === key) break;
        this.db.prepare('DELETE FROM response_cache WHERE key = ?').run(oldest.key);
        bytes -= oldest.size;
      }
    }
  }

  /** Empties the cache, or only the entries that were answered by `model`. Returns how many were removed. */
  clear(model?: string): number {
    return Number(
      (model === undefined
        ? this.db.prepare('DELETE FROM response_cache').run()
        : this.db.prepare('DELETE FROM response_cache WHERE model = ?').run(model)
      ).changes,
    );
  }

  stats(): CacheStats {
    const row = this.db
      .prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits, COALESCE(SUM(size), 0) AS bytes FROM response_cache WHERE expires_at > ?')
      .get(this.now()) as unknown as CacheStats;
    return { entries: row.entries, hits: row.hits, bytes: row.bytes, served: { ...this.served } };
  }
}
