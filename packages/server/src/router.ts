import type { ModelEntry, ProviderEntry, Tier } from '@pourgate/shared';
import { COMPLEXITY_TIER, TIER_ORDER, analyzePrompt, requiredCapabilities, type Analysis } from './complexity.js';
import { KeyPool } from './keypool.js';
import { DEFAULT_PRIVACY, needsRedaction, providerAllowed, redactBody, type PrivacyConfig } from './privacy.js';

export interface Candidate {
  provider: ProviderEntry;
  model: ModelEntry;
}

export interface RouterDeps {
  registry: ProviderEntry[];
  pools: Map<string, KeyPool>;
  fetch: typeof fetch;
  /** Per-request privacy settings (operator config, possibly tightened by the client). */
  privacy?: PrivacyConfig;
}

export const AUTO_MODEL = 'auto';
const FORCED_TIERS: Tier[] = ['small', 'medium', 'large'];

/** Virtual model ids: `auto` (classify the prompt) and `auto:small|medium|large` (force a tier first). */
export const VIRTUAL_MODELS = [AUTO_MODEL, ...FORCED_TIERS.map((t) => `${AUTO_MODEL}:${t}`)];

/** `undefined` when `requested` is not a virtual model; `null` tier means classify automatically. */
export function parseVirtual(requested: string): { forced: Tier | null } | undefined {
  if (requested === AUTO_MODEL) return { forced: null };
  const m = requested.match(/^auto:(small|medium|large)$/);
  return m ? { forced: m[1] as Tier } : undefined;
}

export function listCandidates(registry: ProviderEntry[], requested: string): Candidate[] {
  const all = registry.flatMap((provider) =>
    provider.models
      .filter((m) => m.capabilities.includes('chat'))
      .map((model) => ({ provider, model })),
  );
  return parseVirtual(requested) ? all : all.filter((c) => c.model.id === requested);
}

/**
 * Orders (and filters) candidates for a virtual model: drop models that cannot serve the request
 * (missing capability, context window too small), then prefer the wanted tier, falling back to the
 * others. Within a tier, the model that has served the fewest requests today goes first.
 */
export function rankCandidates(
  candidates: Candidate[],
  preferred: Tier,
  analysis: Analysis,
  usageToday: (c: Candidate) => number,
): Candidate[] {
  const caps = requiredCapabilities(analysis.needs);
  const order = TIER_ORDER[preferred];
  const tierRank = (c: Candidate) => order.indexOf(c.model.tier ?? 'medium');
  return candidates
    .filter((c) => caps.every((cap) => c.model.capabilities.includes(cap)))
    .filter((c) => c.model.context === undefined || analysis.promptTokens < c.model.context)
    .map((c, i) => ({ c, i, usage: usageToday(c) }))
    .sort((a, b) => tierRank(a.c) - tierRank(b.c) || a.usage - b.usage || a.i - b.i)
    .map((x) => x.c);
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
  const privacy = deps.privacy ?? DEFAULT_PRIVACY;
  let candidates = listCandidates(deps.registry, requested);
  if (candidates.length > 0) {
    const allowed = candidates.filter((c) => providerAllowed(privacy.policy, c.provider));
    if (allowed.length === 0) {
      return errorResponse(
        400,
        `The privacy policy "${privacy.policy}" excludes every provider that could serve this request`,
        'invalid_request_error',
        'privacy_policy',
      );
    }
    candidates = allowed;
  }
  const virtual = parseVirtual(requested);
  let analysis: Analysis | undefined;
  if (virtual) {
    analysis = analyzePrompt(body);
    const preferred = virtual.forced ?? COMPLEXITY_TIER[analysis.complexity];
    const total = candidates.length;
    candidates = rankCandidates(candidates, preferred, analysis, (c) => deps.pools.get(c.provider.provider)?.usageToday(c.model.id).requests ?? 0);
    if (candidates.length === 0 && total > 0) {
      return errorResponse(
        400,
        'No configured model supports this request (required capabilities or context length)',
        'invalid_request_error',
        'no_capable_model',
      );
    }
  }
  if (candidates.length === 0) {
    return errorResponse(404, `The model '${requested}' does not exist`, 'invalid_request_error', 'model_not_found');
  }

  let redacted: { body: Record<string, unknown>; count: number } | undefined;
  for (const { provider, model } of candidates) {
    const pool = deps.pools.get(provider.provider);
    if (!pool) continue;
    const tried = new Set<string>();
    for (;;) {
      const key = pool.acquire({ model: model.id, ...model.limits }, tried);
      if (!key) break;
      tried.add(key);
      const mask = needsRedaction(privacy.pii, provider);
      if (mask) redacted ??= redactBody(body);
      let res: Response;
      try {
        res = await deps.fetch(`${provider.base_url.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ ...(mask ? redacted!.body : body), model: model.id }),
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
      if (mask) headers.set('x-pourgate-redacted', String(redacted!.count));
      if (analysis) {
        headers.set('x-pourgate-tier', model.tier ?? 'medium');
        if (!virtual?.forced) headers.set('x-pourgate-complexity', analysis.complexity);
      }
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
  }
  return errorResponse(503, 'All providers are currently rate-limited or unavailable', 'server_error', 'no_capacity');
}
