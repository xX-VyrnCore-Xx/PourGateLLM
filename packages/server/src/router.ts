import type { ModelEntry, ProviderEntry } from '@pourgate/shared';
import { KeyPool } from './keypool.js';

export interface Candidate {
  provider: ProviderEntry;
  model: ModelEntry;
}

export interface RouterDeps {
  registry: ProviderEntry[];
  pools: Map<string, KeyPool>;
  fetch: typeof fetch;
}

export const AUTO_MODEL = 'auto';

export function listCandidates(registry: ProviderEntry[], requested: string): Candidate[] {
  const all = registry.flatMap((provider) =>
    provider.models
      .filter((m) => m.capabilities.includes('chat'))
      .map((model) => ({ provider, model })),
  );
  return requested === AUTO_MODEL ? all : all.filter((c) => c.model.id === requested);
}

const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function parseRetryAfter(res: Response, fallbackMs: number): number {
  const secs = Number(res.headers.get('retry-after'));
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, MAX_COOLDOWN_MS) : fallbackMs;
}

export function errorResponse(status: number, message: string, type: string, code?: string): Response {
  return Response.json({ error: { message, type, code: code ?? null } }, { status });
}

/**
 * Tries each candidate (and each of its keys) until one answers with something
 * other than 429 / 5xx / network error. Successful responses, including
 * streaming bodies, are returned untouched.
 */
export async function routeChat(
  deps: RouterDeps,
  body: Record<string, unknown>,
  requested: string,
  signal?: AbortSignal,
): Promise<Response> {
  const candidates = listCandidates(deps.registry, requested);
  if (candidates.length === 0) {
    return errorResponse(404, `The model '${requested}' does not exist`, 'invalid_request_error', 'model_not_found');
  }

  for (const { provider, model } of candidates) {
    const pool = deps.pools.get(provider.provider);
    if (!pool) continue;
    const tried = new Set<string>();
    for (;;) {
      const key = pool.acquire({ model: model.id, ...model.limits }, tried);
      if (!key) break;
      tried.add(key);
      let res: Response;
      try {
        res = await deps.fetch(`${provider.base_url.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ ...body, model: model.id }),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        pool.cooldown(key, 10_000);
        continue;
      }
      if (res.status === 429) {
        pool.cooldown(key, parseRetryAfter(res, 60_000));
        await res.body?.cancel();
        continue;
      }
      if (res.status >= 500) {
        pool.cooldown(key, 10_000);
        await res.body?.cancel();
        continue;
      }
      // Best-effort accounting of provider-reported tokens (non-streaming JSON responses only).
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        void res
          .clone()
          .json()
          .then((json: { usage?: { total_tokens?: number } }) => {
            const total = json?.usage?.total_tokens;
            if (typeof total === 'number') pool.recordTokens(key, model.id, total);
          })
          .catch(() => {});
      }
      const headers = new Headers(res.headers);
      headers.set('x-pourgate-provider', provider.provider);
      headers.set('x-pourgate-model', model.id);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
  }
  return errorResponse(503, 'All providers are currently rate-limited or unavailable', 'server_error', 'no_capacity');
}
