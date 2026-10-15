import type { DatabaseSync } from 'node:sqlite';
import type { Limits } from '@pourgate/shared';

export interface RateLimitInfo {
  limitRequests?: number;
  limitTokens?: number;
  remainingRequests?: number;
  remainingTokens?: number;
  /** Milliseconds until the request / token window resets. */
  resetRequestsMs?: number;
  resetTokensMs?: number;
}

const MAX_RESET_MS = 24 * 60 * 60 * 1000;

/** Parses "1.5s", "250ms", "2m", "1h2m3s" or a plain number of seconds. Returns undefined when unparseable. */
export function parseDuration(raw: string | null | undefined): number | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.min(Math.round(Number(v) * 1000), MAX_RESET_MS);
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let total = 0;
  let consumed = 0;
  for (const m of v.matchAll(re)) {
    const n = Number(m[1]);
    total += n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'ms' | 's' | 'm' | 'h' | 'd'];
    consumed += m[0].length;
  }
  return consumed === v.length ? Math.min(Math.round(total), MAX_RESET_MS) : undefined;
}

const int = (v: string | null): number | undefined => {
  if (v === null || !/^\d+$/.test(v.trim())) return undefined;
  return Number(v.trim());
};

/** Reads the de-facto `x-ratelimit-*` response headers (OpenAI, Groq, Mistral and compatible providers). */
export function parseRateLimitHeaders(h: Headers): RateLimitInfo {
  const info: RateLimitInfo = {
    limitRequests: int(h.get('x-ratelimit-limit-requests')),
    limitTokens: int(h.get('x-ratelimit-limit-tokens')),
    remainingRequests: int(h.get('x-ratelimit-remaining-requests')),
    remainingTokens: int(h.get('x-ratelimit-remaining-tokens')),
    resetRequestsMs: parseDuration(h.get('x-ratelimit-reset-requests')),
    resetTokensMs: parseDuration(h.get('x-ratelimit-reset-tokens')),
  };
  for (const k of Object.keys(info) as (keyof RateLimitInfo)[]) if (info[k] === undefined) delete info[k];
  return info;
}

/** How long a key should rest because a provider reported an exhausted window, or 0 when it has budget left. */
export function exhaustedFor(info: RateLimitInfo): number {
  let ms = 0;
  if (info.remainingRequests === 0 && info.resetRequestsMs) ms = Math.max(ms, info.resetRequestsMs);
  if (info.remainingTokens === 0 && info.resetTokensMs) ms = Math.max(ms, info.resetTokensMs);
  return ms;
}

export interface ObservedLimit {
  provider: string;
  model: string;
  limitRequests: number | null;
  limitTokens: number | null;
  observedAt: number;
}

/** Remembers the limits providers report, so the dashboard can show where the registry looks wrong. */
export class ObservedLimits {
  private readonly cache = new Map<string, ObservedLimit>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    const rows = db.prepare('SELECT * FROM observed_limits').all() as unknown as {
      provider: string;
      model: string;
      limit_requests: number | null;
      limit_tokens: number | null;
      observed_at: number;
    }[];
    for (const r of rows) {
      this.cache.set(`${r.provider}|${r.model}`, {
        provider: r.provider,
        model: r.model,
        limitRequests: r.limit_requests,
        limitTokens: r.limit_tokens,
        observedAt: r.observed_at,
      });
    }
  }

  /** Records reported limits; only writes to the database when a value changed. */
  record(provider: string, model: string, info: RateLimitInfo): void {
    if (info.limitRequests === undefined && info.limitTokens === undefined) return;
    const key = `${provider}|${model}`;
    const prev = this.cache.get(key);
    const next: ObservedLimit = {
      provider,
      model,
      limitRequests: info.limitRequests ?? prev?.limitRequests ?? null,
      limitTokens: info.limitTokens ?? prev?.limitTokens ?? null,
      observedAt: this.now(),
    };
    const changed = !prev || prev.limitRequests !== next.limitRequests || prev.limitTokens !== next.limitTokens;
    this.cache.set(key, changed ? next : { ...prev, observedAt: next.observedAt });
    if (changed) {
      this.db
        .prepare(
          `INSERT INTO observed_limits (provider, model, limit_requests, limit_tokens, observed_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(provider, model) DO UPDATE SET limit_requests = excluded.limit_requests, limit_tokens = excluded.limit_tokens, observed_at = excluded.observed_at`,
        )
        .run(provider, model, next.limitRequests, next.limitTokens, next.observedAt);
    }
  }

  get(provider: string, model: string): ObservedLimit | undefined {
    return this.cache.get(`${provider}|${model}`);
  }
}

/**
 * Compares observed limits with the registry. The reported window (minute or day) is provider specific, so a value
 * only counts as drift when it matches none of the limits the registry declares for that model.
 */
export function detectDrift(observed: ObservedLimit | undefined, declared: Limits): string[] {
  if (!observed) return [];
  const known = [declared.rpm, declared.rpd, declared.tpm, declared.tpd].filter((v): v is number => v !== undefined);
  const out: string[] = [];
  const check = (label: string, value: number | null, fields: (keyof Limits)[]) => {
    if (value === null) return;
    if (known.length === 0) out.push(`provider reports ${label} limit ${value}, registry declares no limits`);
    else if (!fields.some((f) => declared[f] === value)) out.push(`provider reports ${label} limit ${value}, registry says ${fields.map((f) => `${f}=${declared[f] ?? '-'}`).join(', ')}`);
  };
  check('request', observed.limitRequests, ['rpm', 'rpd']);
  check('token', observed.limitTokens, ['tpm', 'tpd']);
  return out;
}
