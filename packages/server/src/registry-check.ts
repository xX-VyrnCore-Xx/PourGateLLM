import type { ProviderEntry } from '@pourgate/shared';

export type CheckStatus = 'ok' | 'stale' | 'needs-key' | 'unreachable';

export interface ProviderCheck {
  provider: string;
  status: CheckStatus;
  /** Registry model ids the provider no longer lists (only for status 'stale'). */
  missing: string[];
  /** Models checked, and how many the provider lists in total. */
  checked: number;
  listed: number;
  detail?: string;
}

type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Ids from an OpenAI-style `/models` body. Gemini prefixes ids with "models/", which the registry omits. */
export function listedIds(body: unknown): Set<string> {
  const rows = (body as { data?: unknown; models?: unknown } | null)?.data ?? (body as { models?: unknown } | null)?.models;
  const ids = new Set<string>();
  if (!Array.isArray(rows)) return ids;
  for (const r of rows) {
    const raw = typeof r === 'string' ? r : (r as { id?: unknown; name?: unknown } | null)?.id ?? (r as { name?: unknown } | null)?.name;
    if (typeof raw === 'string') ids.add(raw.replace(/^models\//, ''));
  }
  return ids;
}

/**
 * Asks each provider for its model list and reports registry ids that disappeared. Providers that need a key
 * are skipped (status 'needs-key') unless one is available in the environment under `api_key_env`.
 */
export async function checkRegistry(
  registry: readonly ProviderEntry[],
  opts: { env?: NodeJS.ProcessEnv; fetch?: Fetcher; timeoutMs?: number; only?: string } = {},
): Promise<ProviderCheck[]> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetch ?? (fetch as unknown as Fetcher);
  const out: ProviderCheck[] = [];
  for (const p of registry) {
    if (opts.only && p.provider !== opts.only) continue;
    if (p.adapter) continue; // plugin adapters have no standard listing
    const models = p.models.filter((m) => m.capabilities.some((c) => c === 'chat' || c === 'embeddings'));
    const key = env[p.api_key_env]?.split(',')[0]?.trim();
    const result: ProviderCheck = { provider: p.provider, status: 'ok', missing: [], checked: models.length, listed: 0 };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000);
    try {
      const res = await doFetch(`${p.base_url.replace(/\/$/, '')}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: ctl.signal,
      });
      if (res.status === 401 || res.status === 403 || (res.status === 404 && !key)) {
        result.status = 'needs-key';
        result.detail = `HTTP ${res.status}: set ${p.api_key_env} to check this provider`;
      } else if (!res.ok) {
        result.status = 'unreachable';
        result.detail = `HTTP ${res.status}`;
      } else {
        const listed = listedIds(await res.json());
        result.listed = listed.size;
        if (listed.size === 0) {
          result.status = 'unreachable';
          result.detail = 'unrecognised /models response';
        } else {
          result.missing = models.filter((m) => !listed.has(m.id)).map((m) => m.id);
          if (result.missing.length > 0) result.status = 'stale';
        }
      }
    } catch (e) {
      result.status = 'unreachable';
      result.detail = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    out.push(result);
  }
  return out;
}
