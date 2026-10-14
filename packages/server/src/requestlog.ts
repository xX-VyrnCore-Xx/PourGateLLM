import type { DatabaseSync } from 'node:sqlite';

/** One proxied request. Prompts and completions are never stored: metadata only. */
export interface LogEntry {
  ts: number;
  tokenId: number | null;
  requested: string;
  provider: string | null;
  model: string | null;
  tier: string | null;
  complexity: string | null;
  status: number;
  /** Time until the upstream response headers arrived (≈ time to first byte). */
  ttfbMs: number;
  /** Time until the response body finished (or the client went away). */
  totalMs: number;
  tokens: number | null;
  /** Number of PII items masked before forwarding; null when masking was not applied. */
  redacted: number | null;
  stream: boolean;
  error: string | null;
}

interface Row {
  id: number;
  ts: number;
  token_id: number | null;
  requested: string;
  provider: string | null;
  model: string | null;
  tier: string | null;
  complexity: string | null;
  status: number;
  ttfb_ms: number;
  total_ms: number;
  tokens: number | null;
  redacted: number | null;
  stream: number;
  error: string | null;
}

export interface ModelStats {
  provider: string;
  model: string;
  requests: number;
  errors: number;
  tokens: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface Analytics {
  since: number;
  bucketMs: number;
  summary: { requests: number; errors: number; errorRate: number; tokens: number; p50Ms: number | null; p95Ms: number | null };
  byModel: ModelStats[];
  series: { t: number; requests: number; errors: number }[];
}

const MAX_ROWS = 200_000;

export const percentile = (sorted: number[], p: number): number | null =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

const toEntry = (r: Row): LogEntry => ({
  ts: r.ts,
  tokenId: r.token_id,
  requested: r.requested,
  provider: r.provider,
  model: r.model,
  tier: r.tier,
  complexity: r.complexity,
  status: r.status,
  ttfbMs: r.ttfb_ms,
  totalMs: r.total_ms,
  tokens: r.tokens,
  redacted: r.redacted,
  stream: r.stream === 1,
  error: r.error,
});

export class RequestLog {
  constructor(private readonly db: DatabaseSync) {}

  insert(e: LogEntry): void {
    this.db
      .prepare(
        `INSERT INTO request_log (ts, token_id, requested, provider, model, tier, complexity, status, ttfb_ms, total_ms, tokens, redacted, stream, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.ts, e.tokenId, e.requested.slice(0, 200), e.provider, e.model, e.tier, e.complexity, e.status, Math.round(e.ttfbMs), Math.round(e.totalMs), e.tokens, e.redacted, e.stream ? 1 : 0, e.error);
  }

  recent(limit = 100): LogEntry[] {
    const rows = this.db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 1000)) as unknown as Row[];
    return rows.map(toEntry);
  }

  /** Entries since `since`, oldest first, for JSONL export. */
  since(since: number, limit = MAX_ROWS): LogEntry[] {
    const rows = this.db.prepare('SELECT * FROM request_log WHERE ts >= ? ORDER BY id LIMIT ?').all(since, limit) as unknown as Row[];
    return rows.map(toEntry);
  }

  prune(olderThanMs: number): void {
    this.db.prepare('DELETE FROM request_log WHERE ts < ?').run(olderThanMs);
  }

  analytics(since: number, bucketMs: number): Analytics {
    const rows = this.db
      .prepare('SELECT ts, provider, model, status, error, total_ms, tokens FROM request_log WHERE ts >= ? ORDER BY ts LIMIT ?')
      .all(since, MAX_ROWS) as unknown as Pick<Row, 'ts' | 'provider' | 'model' | 'status' | 'error' | 'total_ms' | 'tokens'>[];

    const isError = (r: { status: number; error: string | null }) => r.status >= 400 || r.error !== null;
    const all: number[] = [];
    const perModel = new Map<string, { provider: string; model: string; requests: number; errors: number; tokens: number; lat: number[] }>();
    const buckets = new Map<number, { requests: number; errors: number }>();
    let errors = 0;
    let tokens = 0;

    for (const r of rows) {
      const err = isError(r);
      if (err) errors++;
      tokens += r.tokens ?? 0;
      if (!err) all.push(r.total_ms);
      const key = `${r.provider ?? '-'}|${r.model ?? '-'}`;
      let m = perModel.get(key);
      if (!m) perModel.set(key, (m = { provider: r.provider ?? '-', model: r.model ?? '-', requests: 0, errors: 0, tokens: 0, lat: [] }));
      m.requests++;
      m.tokens += r.tokens ?? 0;
      if (err) m.errors++;
      else m.lat.push(r.total_ms);
      const b = Math.floor(r.ts / bucketMs) * bucketMs;
      const slot = buckets.get(b) ?? { requests: 0, errors: 0 };
      slot.requests++;
      if (err) slot.errors++;
      buckets.set(b, slot);
    }

    // Dense series, so empty buckets are drawn as zero.
    const series: Analytics['series'] = [];
    const end = Math.floor(Date.now() / bucketMs) * bucketMs;
    for (let t = Math.floor(since / bucketMs) * bucketMs; t <= end; t += bucketMs) {
      series.push({ t, ...(buckets.get(t) ?? { requests: 0, errors: 0 }) });
    }

    all.sort((a, b) => a - b);
    return {
      since,
      bucketMs,
      summary: {
        requests: rows.length,
        errors,
        errorRate: rows.length ? errors / rows.length : 0,
        tokens,
        p50Ms: percentile(all, 50),
        p95Ms: percentile(all, 95),
      },
      byModel: [...perModel.values()]
        .map((m) => {
          const lat = m.lat.sort((a, b) => a - b);
          return { provider: m.provider, model: m.model, requests: m.requests, errors: m.errors, tokens: m.tokens, p50Ms: percentile(lat, 50), p95Ms: percentile(lat, 95) };
        })
        .sort((a, b) => b.requests - a.requests),
      series,
    };
  }
}
