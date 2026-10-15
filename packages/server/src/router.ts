import { Breaker } from './breaker.js';
import type { ModelEntry, ProviderEntry, Tier } from '@pourgate/shared';
import { COMPLEXITY_TIER, TIER_ORDER, analyzePrompt, requiredCapabilities, type Analysis } from './complexity.js';
import { rankScore, type ModelScore, type Strategy } from './evals.js';
import { KEYLESS, KeyPool } from './keypool.js';
import type { LatencyTracker } from './latency.js';
import type { Profiles, StickyStore } from './profiles.js';
import { FUSION_MODEL, runFusion } from './fusion.js';
import { exhaustedFor, parseRateLimitHeaders, type ObservedLimits } from './ratelimits.js';
import type { ProviderAdapter } from './plugins.js';
import { DEFAULT_PRIVACY, needsRedaction, providerAllowed, redactBody, redactTextFields, type PrivacyConfig } from './privacy.js';

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
  /** Measured model quality, used to order models inside a tier. */
  scoring?: Scoring;
  /** Internal best-effort calls (e.g. semantic-cache embeddings): 5xx/network failures do not rest the key. */
  softFail?: boolean;
  /** Where limits reported by providers are remembered. */
  observedLimits?: ObservedLimits;
  /** Plugin-provided adapters for non-OpenAI-compatible providers, by name. */
  adapters?: Map<string, ProviderAdapter>;
  /** Skips targets that keep failing for a while (they are still tried last if nothing else answers). */
  breaker?: Breaker;
  /** Learns how fast each target answers; faster ones go first among otherwise equal candidates. */
  latency?: LatencyTracker;
  /** Number of models asked by the `fusion` virtual model (default 3, max 5). */
  fusionPanel?: number;
  /** Named fallback chains (`auto:<name>`). */
  profiles?: Profiles;
  /** With `sessionKey`: keeps a conversation on the model that served it last, for virtual models and profiles. */
  sticky?: StickyStore;
  sessionKey?: string;
  /** Max wait for the upstream to start answering, in ms (default 60000). The body may stream for longer. */
  timeoutMs?: number;
  /** Called after each upstream attempt (for tracing); never receives prompts. */
  onAttempt?: (a: AttemptInfo) => void;
}

export interface AttemptInfo {
  provider: string;
  model: string;
  startMs: number;
  endMs: number;
  /** HTTP status, or null for a network error / timeout. */
  status: number | null;
}

export interface Scoring {
  strategy: Strategy;
  score: (provider: string, model: string) => ModelScore | undefined;
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

export type Endpoint = 'chat' | 'embeddings' | 'transcription' | 'speech' | 'images';

const ENDPOINT_PATH: Record<Endpoint, string> = {
  chat: '/chat/completions',
  embeddings: '/embeddings',
  transcription: '/audio/transcriptions',
  speech: '/audio/speech',
  images: '/images/generations',
};

/** Request field holding user text that PII masking applies to, per non-chat endpoint. */
const TEXT_FIELD: Record<Exclude<Endpoint, 'chat'>, string> = { embeddings: 'input', transcription: 'prompt', speech: 'input', images: 'prompt' };

/** Registry capability a model needs to serve each endpoint. */
const ENDPOINT_CAPABILITY: Record<Endpoint, string> = {
  chat: 'chat',
  embeddings: 'embeddings',
  transcription: 'transcription',
  speech: 'speech',
  images: 'images',
};

export function listCandidates(registry: ProviderEntry[], requested: string, endpoint: Endpoint = 'chat'): Candidate[] {
  const capability = ENDPOINT_CAPABILITY[endpoint] as ModelEntry['capabilities'][number];
  const all = registry.flatMap((provider) =>
    provider.models
      .filter((m) => m.capabilities.includes(capability))
      .map((model) => ({ provider, model })),
  );
  // Embeddings have no complexity tiers: only plain `auto` is a virtual id there.
  const virtual = endpoint === 'chat' ? parseVirtual(requested) : requested === AUTO_MODEL ? { forced: null } : undefined;
  return virtual ? all : all.filter((c) => c.model.id === requested);
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
  scoring?: Scoring,
  latencyBucket: (c: Candidate) => number = () => 0,
): Candidate[] {
  const caps = requiredCapabilities(analysis.needs);
  const order = TIER_ORDER[preferred];
  const tierRank = (c: Candidate) => order.indexOf(c.model.tier ?? 'medium');
  return candidates
    .filter((c) => caps.every((cap) => c.model.capabilities.includes(cap)))
    .filter((c) => c.model.context === undefined || analysis.promptTokens < c.model.context)
    .map((c, i) => ({
      c,
      i,
      usage: usageToday(c),
      slow: latencyBucket(c),
      score: scoring ? rankScore(scoring.strategy, scoring.score(c.provider.provider, c.model.id)) : 0,
    }))
    .sort((a, b) => tierRank(a.c) - tierRank(b.c) || b.score - a.score || a.slow - b.slow || a.usage - b.usage || a.i - b.i)
    .map((x) => x.c);
}

/** Authorization header for a key; keyless providers get none (a bogus bearer token can be rejected). */
const authHeaders = (key: string): Record<string, string> => (key === KEYLESS ? {} : { authorization: `Bearer ${key}` });

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
  endpoint: Endpoint = 'chat',
  /** Multipart form for the transcription endpoint (the `model` field is replaced per attempt). */
  form?: FormData,
): Promise<Response> {
  const privacy = deps.privacy ?? DEFAULT_PRIVACY;
  if (endpoint === 'chat' && requested === FUSION_MODEL && !form) return runFusion(deps, body, routeChat, deps.fusionPanel ?? 3, signal);
  const profile = endpoint === 'chat' ? deps.profiles?.profileFor(requested) : undefined;
  let candidates = profile ? deps.profiles!.resolve(deps.registry, profile) : listCandidates(deps.registry, requested, endpoint);
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
  const virtual = endpoint === 'chat' ? parseVirtual(requested) : undefined;
  let analysis: Analysis | undefined;
  if (endpoint !== 'chat' && requested === AUTO_MODEL) {
    // Spread load: least used model first, registry order on ties.
    const usage = (c: Candidate) => deps.pools.get(c.provider.provider)?.usageToday(c.model.id).requests ?? 0;
    candidates = candidates.map((c, i) => ({ c, i, u: usage(c), s: deps.latency?.bucket(`${c.provider.provider}|${c.model.id}`) ?? 0 })).sort((a, b) => a.s - b.s || a.u - b.u || a.i - b.i).map((x) => x.c);
  }
  if (virtual) {
    analysis = analyzePrompt(body);
    const preferred = virtual.forced ?? COMPLEXITY_TIER[analysis.complexity];
    const total = candidates.length;
    candidates = rankCandidates(candidates, preferred, analysis, (c) => deps.pools.get(c.provider.provider)?.usageToday(c.model.id).requests ?? 0, deps.scoring, (c) => deps.latency?.bucket(`${c.provider.provider}|${c.model.id}`) ?? 0);
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

  if (profile) {
    // A profile keeps its own order; it only drops models that cannot serve this request.
    const needs = analyzePrompt(body);
    const caps = requiredCapabilities(needs.needs);
    candidates = candidates.filter((c) => caps.every((cap) => c.model.capabilities.includes(cap)) && (c.model.context === undefined || needs.promptTokens < c.model.context));
    if (candidates.length === 0) {
      return errorResponse(400, 'No model in this profile supports this request (required capabilities or context length)', 'invalid_request_error', 'no_capable_model');
    }
  }
  // A conversation stays on the model that answered it last, while that model is still a candidate.
  const stickyKey = deps.sticky && deps.sessionKey && (virtual || profile) ? `${deps.sessionKey}|${requested}` : undefined;
  if (stickyKey) {
    const last = deps.sticky!.get(stickyKey);
    const at = last ? candidates.findIndex((c) => `${c.provider.provider}|${c.model.id}` === last) : -1;
    if (at > 0) candidates = [candidates[at]!, ...candidates.slice(0, at), ...candidates.slice(at + 1)];
  }

  // Healthy targets first; ones whose circuit is open are only a last resort.
  const targetId = (c: Candidate) => `${c.provider.provider}|${c.model.id}`;
  if (deps.breaker) {
    const healthy = candidates.filter((c) => !deps.breaker!.isOpen(targetId(c)));
    candidates = [...healthy, ...candidates.filter((c) => deps.breaker!.isOpen(targetId(c)))];
  }
  const timeoutMs = deps.timeoutMs ?? 60_000;

  let redacted: { body: Record<string, unknown>; count: number } | undefined;
  for (const { provider, model } of candidates) {
    const target = `${provider.provider}|${model.id}`;
    const pool = deps.pools.get(provider.provider);
    if (!pool) continue;
    const adapter = provider.adapter ? deps.adapters?.get(provider.adapter) : undefined;
    // An adapter is required (and only supported) for chat; otherwise the provider cannot serve this call.
    if (provider.adapter && (!adapter || endpoint !== 'chat')) continue;
    const tried = new Set<string>();
    for (;;) {
      const key = pool.acquire({ model: model.id, ...model.limits }, tried);
      if (!key) break;
      tried.add(key);
      const mask = needsRedaction(privacy.pii, provider);
      if (mask) redacted ??= endpoint === 'chat' ? redactBody(body) : redactTextFields(body, TEXT_FIELD[endpoint]);
      let res: Response;
      // Abort an upstream that never starts answering; the timer stops once headers arrive so streams can run on.
      const attemptAbort = new AbortController();
      const onCallerAbort = () => attemptAbort.abort(signal?.reason);
      if (signal?.aborted) onCallerAbort();
      else signal?.addEventListener('abort', onCallerAbort, { once: true });
      const timer = setTimeout(() => attemptAbort.abort(new Error('upstream timeout')), timeoutMs);
      const attemptSignal = attemptAbort.signal;
      const attemptStart = Date.now();
      const attemptT0 = performance.now();
      try {
        if (adapter) {
          const built = adapter.buildRequest({
            body: { ...(mask ? redacted!.body : body), model: model.id },
            model: model.id,
            baseUrl: provider.base_url,
            apiKey: key,
            stream: body.stream === true,
          });
          res = await deps.fetch(built.url, { ...built.init, signal: attemptSignal });
        } else {
          const url = `${provider.base_url.replace(/\/$/, '')}${ENDPOINT_PATH[endpoint]}`;
          if (form) {
            // Rebuild the multipart body per attempt so the fetch implementation sets the boundary itself.
            const attempt = new FormData();
            for (const [k, v] of form.entries()) if (k !== 'model') attempt.append(k, v);
            attempt.set('model', model.id);
            res = await deps.fetch(url, { method: 'POST', headers: authHeaders(key), body: attempt, signal: attemptSignal });
          } else {
            res = await deps.fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...authHeaders(key) },
              body: JSON.stringify({ ...(mask ? redacted!.body : body), model: model.id }),
              signal: attemptSignal,
            });
          }
        }
      } catch (err) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onCallerAbort);
        deps.onAttempt?.({ provider: provider.provider, model: model.id, startMs: attemptStart, endMs: attemptStart + (performance.now() - attemptT0), status: null });
        if (signal?.aborted) throw err;
        deps.breaker?.failure(target);
        deps.latency?.record(target, timeoutMs);
        if (!deps.softFail) pool.cooldown(key, 10_000);
        continue;
      }
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
      deps.onAttempt?.({ provider: provider.provider, model: model.id, startMs: attemptStart, endMs: attemptStart + (performance.now() - attemptT0), status: res.status });
      // Learn from the provider's own rate-limit headers: remember reported limits and rest a key that just
      // used up its window instead of spending a request to find out.
      const reported = parseRateLimitHeaders(res.headers);
      deps.observedLimits?.record(provider.provider, model.id, reported);
      const exhausted = exhaustedFor(reported);
      if (exhausted > 0) pool.cooldown(key, exhausted);
      if (res.status === 429) {
        pool.cooldown(key, parseRetryAfter(res, 60_000));
        await res.body?.cancel();
        continue;
      }
      if (res.status >= 500) {
        deps.breaker?.failure(target);
        deps.latency?.record(target, timeoutMs);
        if (!deps.softFail) pool.cooldown(key, 10_000);
        await res.body?.cancel();
        continue;
      }
      if (adapter && res.ok) {
        try {
          res = await adapter.parseResponse(res, { model: model.id, stream: body.stream === true });
        } catch {
          // A broken adapter must not take the gateway down: treat it like an upstream failure.
          deps.breaker?.failure(target);
          pool.cooldown(key, 10_000);
          continue;
        }
      }
      if (res.status !== 429) deps.breaker?.success(target);
      if (res.ok) deps.latency?.record(target, performance.now() - attemptT0);
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
      if (stickyKey && res.ok) deps.sticky!.set(stickyKey, target);
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
