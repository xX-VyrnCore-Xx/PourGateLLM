import type { AuditLog } from './audit.js';
import { Breaker } from './breaker.js';
import { LatencyTracker } from './latency.js';
import type { CustomProviders } from './customproviders.js';
import { handleBody, type McpBackend } from './mcp.js';
import { Profiles, StickyStore } from './profiles.js';
import { BadRequest, completionsToChat, openaiError, responsesToChat, wrapCompletions, wrapResponses } from './openai-extra.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ProviderEntry } from '@pourgate/shared';
import { createAdminRoutes, type RegistrySyncHandle } from './admin.js';
import type { KeyStore } from './keys.js';
import { anthropicError, estimateInputTokens, toOpenAIRequest, validateRequest, wrapResponse } from './anthropic.js';
import type { CacheResult, CachedResponse, ResponseCache } from './cache.js';
import type { EvalRunner, EvalStore, Strategy } from './evals.js';
import type { Metrics } from './metrics.js';
import { PluginError, RejectedByPlugin, type PluginHost } from './plugins.js';
import type { ObservedLimits } from './ratelimits.js';
import { contextHash, lastUserText, type SemanticIndex } from './semantic.js';
import { newSpanId, newTraceId, parseTraceparent, type Tracer } from './otel.js';
import { DEFAULT_PRIVACY, tighten, type PrivacyConfig } from './privacy.js';
import { observeResponse } from './observe.js';
import type { RequestLog } from './requestlog.js';
import { KeyPool } from './keypool.js';
import type { PoolManager } from './pools.js';
import { getConnInfo } from '@hono/node-server/conninfo';
import { SlidingWindow } from './ratelimit.js';
import { VIRTUAL_MODELS, errorResponse, routeChat, type Endpoint, type Scoring } from './router.js';
import type { TokenRecord, TokenStore } from './tokens.js';

export interface AppOptions {
  /** Providers; pass a function to pick up live registry updates. */
  registry: ProviderEntry[] | (() => ProviderEntry[]);
  /** Registry sync manager, exposed through the admin API when set. */
  registrySync?: RegistrySyncHandle;
  /** Static bootstrap tokens (POURGATE_TOKENS): unlimited, not tracked. */
  envTokens?: string[];
  store: TokenStore;
  pools: Map<string, KeyPool>;
  keyStore?: KeyStore;
  poolManager?: PoolManager;
  fetch?: typeof fetch;
  /** Enables the admin API when set. */
  adminPassword?: string;
  secureCookie?: boolean;
  /** Operator privacy settings: PII masking mode and provider policy. */
  privacy?: PrivacyConfig;
  /** Measured-quality ordering inside a tier (see evals). */
  scoring?: Scoring;
  /** Eval runner/store, exposed through the admin API. */
  evals?: { runner: EvalRunner; store: EvalStore; strategy: Strategy; tasksPerModel: number; tasks: number };
  /** Largest accepted JSON request body in bytes (default 20 MB). */
  maxBodyBytes?: number;
  /** Largest accepted audio upload in bytes (default 25 MB). */
  maxUploadBytes?: number;
  /** Limits reported by providers (from rate-limit headers). */
  observedLimits?: ObservedLimits;
  /** Trusted plugins: request hooks, response observers and provider adapters. */
  plugins?: PluginHost;
  /** Semantic cache on top of the exact-match cache (needs `cache`). `model` is an embeddings model id or `auto`. */
  semantic?: { index: SemanticIndex; model: string };
  /** OTLP trace exporter; tracing is off when unset. */
  tracer?: Tracer;
  /** Exact-match response cache; disabled when unset. */
  cache?: ResponseCache;
  /** Request metadata log (SQLite); enables analytics in the admin API. */
  requestLog?: RequestLog;
  audit?: AuditLog;
  /** Circuit breaker shared by all routes (a default one is created when omitted). */
  breaker?: Breaker;
  /** Remembers how fast each target answers so quicker ones are preferred (a default one is created when omitted). */
  latency?: LatencyTracker;
  /** Dashboard-defined OpenAI-compatible endpoints (admin only). */
  customProviders?: CustomProviders;
  onCustomChange?: () => void;
  reservedNames?: () => Set<string>;
  /** Models asked by the `fusion` virtual model (default 3). */
  fusionPanel?: number;
  /** Named fallback chains, requested as `auto:<name>`. */
  profiles?: Profiles;
  /** Keeps a conversation (header `x-pourgate-session`) on the model that served it last. */
  sticky?: StickyStore;
  /** Max wait for an upstream to start answering, in ms (default 60000). */
  upstreamTimeoutMs?: number;
  /** Prometheus metrics registry; exposed at /metrics when `metricsToken` is also set. */
  metrics?: Metrics;
  metricsToken?: string;
  /** Directory with the built dashboard; served at / when it exists. */
  staticDir?: string;
}

const ROUTES: Record<Endpoint, string> = {
  chat: '/v1/chat/completions',
  embeddings: '/v1/embeddings',
  transcription: '/v1/audio/transcriptions',
  speech: '/v1/audio/speech',
  images: '/v1/images/generations',
};

type Principal = { kind: 'env' } | { kind: 'client'; record: TokenRecord };

function matchesAny(candidate: string, tokens: string[]): boolean {
  const a = Buffer.from(candidate);
  let ok = false;
  for (const t of tokens) {
    const b = Buffer.from(t);
    // Always run the comparison to keep timing independent of which token matched.
    if (a.length === b.length && timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}

export function createApp(opts: AppOptions): Hono<{ Variables: { principal: Principal } }> {
  const app = new Hono<{ Variables: { principal: Principal } }>();
  const doFetch = opts.fetch ?? fetch;
  const breaker = opts.breaker ?? new Breaker();
  const latency = opts.latency ?? new LatencyTracker();
  const sticky = opts.sticky ?? new StickyStore();
  const inflight = new Map<string, Promise<CachedResponse | undefined>>();
  const envTokens = opts.envTokens ?? [];
  // Per-process secret that lets the admin playground call the gateway pipeline in-process.
  const internalSecret = randomBytes(32).toString('base64url');
  const getRegistry = typeof opts.registry === 'function' ? opts.registry : () => opts.registry as ProviderEntry[];
  const rpm = new SlidingWindow();
  const authFailures = new SlidingWindow();

  /** Embeds a prompt through the normal embeddings pipeline (keys, limits, failover, privacy). Null on any failure. */
  const embedQuery = async (model: string, text: string, privacy: PrivacyConfig, signal?: AbortSignal): Promise<Float32Array | null> => {
    try {
      const timeout = AbortSignal.timeout(5000);
      const res = await routeChat(
        { registry: getRegistry(), pools: opts.pools, fetch: doFetch, privacy, observedLimits: opts.observedLimits, softFail: true, breaker, latency, timeoutMs: opts.upstreamTimeoutMs },
        { model, input: text },
        model,
        signal ? AbortSignal.any([timeout, signal]) : timeout,
        'embeddings',
      );
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      const v = ((await res.json()) as { data?: { embedding?: unknown }[] }).data?.[0]?.embedding;
      return Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? Float32Array.from(v as number[]) : null;
    } catch {
      return null;
    }
  };
  const maxUploadBytes = opts.maxUploadBytes ?? 25 * 1024 * 1024;

  app.get('/health', (c) => c.json({ status: 'ok' }));

  if (opts.metrics && opts.metricsToken) {
    const metricsToken = opts.metricsToken;
    app.get('/metrics', (c) => {
      const header = c.req.header('authorization') ?? '';
      if (!header.startsWith('Bearer ') || !matchesAny(header.slice(7), [metricsToken])) {
        return c.text('unauthorized', 401);
      }
      const pools = [...opts.pools.entries()];
      return c.text(
        opts.metrics!.render([
          {
            name: 'pourgate_keys',
            help: 'Provider API keys currently loaded.',
            samples: pools.map(([provider, pool]) => ({ labels: { provider }, value: pool.keys.length })),
          },
          {
            name: 'pourgate_keys_cooling',
            help: 'Provider API keys currently cooling down.',
            samples: pools.map(([provider, pool]) => ({ labels: { provider }, value: pool.coolingCount() })),
          },
        ]),
        200,
        { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
      );
    });
  }

  // Browser hardening for the dashboard and admin API (not for the API proxy or metrics, which are not pages).
  // The dashboard needs no inline scripts, third-party origins or framing, so the policy is strict.
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  app.use('*', async (c, next) => {
    await next();
    if (c.req.path.startsWith('/v1/') || c.req.path === '/metrics') return;
    try {
      const h = c.res.headers;
      h.set('content-security-policy', CSP);
      h.set('x-content-type-options', 'nosniff');
      h.set('x-frame-options', 'DENY');
      h.set('referrer-policy', 'no-referrer');
      h.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
      h.set('cross-origin-opener-policy', 'same-origin');
      if (opts.secureCookie) h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
      if (c.req.path.startsWith('/admin/api')) h.set('cache-control', 'no-store');
    } catch {
      // immutable response (e.g. a proxied one): leave it as it is
    }
  });

  // Request size limits, applied before authentication so oversized bodies are never read.
  const tooLarge = (c: Context) =>
    c.req.path.startsWith('/v1/messages')
      ? anthropicError(413, 'Request body is too large')
      : errorResponse(413, 'Request body is too large', 'invalid_request_error', 'request_too_large');
  const jsonLimit = bodyLimit({ maxSize: opts.maxBodyBytes ?? 20 * 1024 * 1024, onError: tooLarge });
  const uploadLimit = bodyLimit({ maxSize: maxUploadBytes + 1024 * 1024, onError: tooLarge });
  app.use('/v1/*', (c, next) => (c.req.path === '/v1/audio/transcriptions' ? uploadLimit(c, next) : jsonLimit(c, next)));
  app.use(
    '/admin/api/*',
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'request body is too large' }, 413) }),
  );

  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    // OpenAI clients send `Authorization: Bearer`; Anthropic SDKs send `x-api-key`.
    const token = header.startsWith('Bearer ') ? header.slice(7) : (c.req.header('x-api-key') ?? '');
    const invalid = () =>
      c.req.path.startsWith('/v1/messages')
        ? anthropicError(401, 'Invalid or missing API key')
        : errorResponse(401, 'Invalid or missing API token', 'invalid_request_error', 'invalid_api_key');
    // Failed attempts per client address are capped, so tokens cannot be guessed at speed.
    const failed = () => {
      let ip = 'unknown';
      try {
        ip = getConnInfo(c).remote.address ?? 'unknown';
      } catch {
        // no socket info (tests)
      }
      return authFailures.take(ip, 30)
        ? invalid()
        : errorResponse(429, 'Too many failed authentication attempts, retry in a minute', 'rate_limit_error', 'too_many_failed_auth');
    };
    if (!token) return failed();
    if (matchesAny(token, [internalSecret]) || (envTokens.length > 0 && matchesAny(token, envTokens))) {
      c.set('principal', { kind: 'env' });
    } else {
      const record = opts.store.verify(token);
      if (!record) return failed();
      c.set('principal', { kind: 'client', record });
    }
    await next();
  });

  app.get('/v1/models', (c) => {
    const data = [
      ...[...VIRTUAL_MODELS, 'fusion', ...(opts.profiles?.names().map((n) => `auto:${n}`) ?? [])].map((id) => ({ id, object: 'model', created: 0, owned_by: 'pourgate' })),
      ...getRegistry().flatMap((p) =>
        p.models.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: p.provider })),
      ),
    ];
    return c.json({ object: 'list', data });
  });

  /** Conversation key from the `x-pourgate-session` header, scoped to the caller so sessions never leak across clients. */
  const sessionKeyOf = (c: Context<{ Variables: { principal: Principal } }>): string | undefined => {
    const id = c.req.header('x-pourgate-session')?.trim();
    if (!id || id.length > 128) return undefined;
    const p = c.get('principal');
    return `${p.kind === 'client' ? `c${p.record.id}` : 'env'}:${id}`;
  };

  const handle = async (
    c: Context<{ Variables: { principal: Principal } }>,
    endpoint: Endpoint,
    preparsed?: Record<string, unknown>,
  ): Promise<Response> => {
    let payload: Record<string, unknown>;
    let form: FormData | undefined;
    if (preparsed) {
      payload = preparsed;
    } else if (endpoint === 'transcription') {
      if (Number(c.req.header('content-length') ?? 0) > maxUploadBytes) {
        return errorResponse(413, `Uploads are limited to ${Math.floor(maxUploadBytes / 1024 / 1024)} MB`, 'invalid_request_error', 'file_too_large');
      }
      try {
        form = await c.req.formData();
      } catch {
        return errorResponse(400, 'Request body must be multipart/form-data', 'invalid_request_error');
      }
      const file = form.get('file');
      const model = form.get('model');
      if (!(file instanceof File) || typeof model !== 'string' || model === '') {
        return errorResponse(400, "'file' and 'model' are required", 'invalid_request_error');
      }
      if (file.size > maxUploadBytes) {
        return errorResponse(413, `Uploads are limited to ${Math.floor(maxUploadBytes / 1024 / 1024)} MB`, 'invalid_request_error', 'file_too_large');
      }
      // Plugins and logs see the text fields only, never the audio.
      payload = { model };
      for (const [k, v] of form.entries()) if (typeof v === 'string' && k !== 'model') payload[k] = v;
    } else {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return errorResponse(400, 'Request body must be valid JSON', 'invalid_request_error');
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return errorResponse(400, 'Request body must be a JSON object', 'invalid_request_error');
      }
      payload = body as Record<string, unknown>;
    }
    if (endpoint === 'chat' && (typeof payload.model !== 'string' || !Array.isArray(payload.messages))) {
      return errorResponse(400, "'model' (string) and 'messages' (array) are required", 'invalid_request_error');
    }
    if (endpoint === 'embeddings' && (typeof payload.model !== 'string' || payload.input === undefined || payload.input === null || payload.input === '')) {
      return errorResponse(400, "'model' (string) and 'input' are required", 'invalid_request_error');
    }
    if (endpoint === 'speech' && (typeof payload.model !== 'string' || typeof payload.input !== 'string' || payload.input === '')) {
      return errorResponse(400, "'model' and a non-empty text 'input' are required", 'invalid_request_error');
    }
    if (endpoint === 'images' && (typeof payload.model !== 'string' || typeof payload.prompt !== 'string' || payload.prompt === '')) {
      return errorResponse(400, "'model' and a non-empty 'prompt' are required", 'invalid_request_error');
    }

    const principal = c.get('principal');
    let clientId: number | undefined;
    if (principal.kind === 'client') {
      const { record } = principal;
      clientId = record.id;
      if (record.rpmLimit !== null && !rpm.take(record.id, record.rpmLimit)) {
        return errorResponse(429, 'Per-token rate limit exceeded', 'rate_limit_error', 'rate_limit_exceeded');
      }
      if (record.dailyRequestLimit !== null && opts.store.requestsToday(record.id) >= record.dailyRequestLimit) {
        return errorResponse(429, 'Daily request quota exceeded', 'rate_limit_error', 'quota_exceeded');
      }
      opts.store.recordRequest(record.id);
    }

    // Plugin request hooks (fail closed: a failing hook rejects the request).
    if (opts.plugins?.hasHooks) {
      const headers: Record<string, string> = {};
      for (const [k, v] of c.req.raw.headers) {
        if (!['authorization', 'x-api-key', 'cookie', 'proxy-authorization'].includes(k)) headers[k] = v;
      }
      try {
        payload = await opts.plugins.runOnRequest({ endpoint, body: payload, clientId: clientId ?? null, headers });
      } catch (err) {
        if (err instanceof RejectedByPlugin) return errorResponse(err.status, err.message, 'invalid_request_error', 'rejected_by_plugin');
        const name = err instanceof PluginError ? err.plugin : 'unknown';
        return errorResponse(500, `Plugin "${name}" failed`, 'server_error', 'plugin_error');
      }
      if (typeof payload.model !== 'string') return errorResponse(500, 'A plugin removed the model from the request', 'server_error', 'plugin_error');
    }

    const startedAt = performance.now();
    const startedWall = Date.now();
    const privacy = tighten(opts.privacy ?? DEFAULT_PRIVACY, c.req.header('x-pourgate-privacy'));

    // Tracing: continue the caller's trace when it sent a valid W3C traceparent.
    const tracer = opts.tracer;
    const parent = parseTraceparent(c.req.header('traceparent'));
    const traceId = parent?.traceId ?? newTraceId();
    const spanId = newSpanId();
    const tag = (r: Response): Response => {
      if (tracer) r.headers.set('x-pourgate-trace-id', traceId);
      return r;
    };
    const route = ROUTES[endpoint];

    const record = (r: { routed: Response; totalMs: number; ttfbMs: number; tokens: number | null; error: string | null; cache: CacheResult | null }) => {
      const provider = r.routed.headers.get('x-pourgate-provider');
      const model = r.routed.headers.get('x-pourgate-model');
      const complexity = r.routed.headers.get('x-pourgate-complexity');
      opts.metrics?.observe({ provider, model, status: r.routed.status, complexity, seconds: r.totalMs / 1000, tokens: r.tokens });
      if (r.cache) opts.metrics?.cache(r.cache);
      opts.plugins?.runOnResponse({
        endpoint,
        requested: payload.model as string,
        provider,
        model,
        status: r.routed.status,
        totalMs: r.totalMs,
        tokens: r.tokens,
        cache: r.cache,
        clientId: clientId ?? null,
        error: r.error,
      });
      tracer?.record({
        traceId,
        spanId,
        parentSpanId: parent?.spanId,
        name: `POST ${route}`,
        kind: 2,
        startMs: startedWall,
        endMs: startedWall + r.totalMs,
        attributes: {
          'http.request.method': 'POST',
          'http.route': route,
          'http.response.status_code': r.routed.status,
          'gen_ai.request.model': payload.model as string,
          'gen_ai.response.model': model,
          'gen_ai.system': provider,
          'pourgate.tier': r.routed.headers.get('x-pourgate-tier'),
          'pourgate.complexity': complexity,
          'pourgate.tokens': r.tokens,
          'pourgate.cache': r.cache,
          'pourgate.client_token_id': clientId ?? null,
          'pourgate.redacted_items': r.routed.headers.has('x-pourgate-redacted') ? Number(r.routed.headers.get('x-pourgate-redacted')) : null,
        },
        error: r.error ?? undefined,
      });
      try {
        opts.requestLog?.insert({
          ts: startedWall,
          tokenId: clientId ?? null,
          requested: payload.model as string,
          provider,
          model,
          tier: r.routed.headers.get('x-pourgate-tier'),
          complexity,
          status: r.routed.status,
          ttfbMs: r.ttfbMs,
          totalMs: r.totalMs,
          tokens: r.tokens,
          redacted: r.routed.headers.has('x-pourgate-redacted') ? Number(r.routed.headers.get('x-pourgate-redacted')) : null,
          cache: r.cache,
          stream: payload.stream === true,
          error: r.error,
        });
      } catch (err) {
        console.error('[requestlog] insert failed:', err instanceof Error ? err.message : err);
      }
    };

    // Exact-match response cache (opt-in): scoped per client and privacy settings, bypassable per request.
    const cache = endpoint === 'chat' ? opts.cache : undefined;
    const cacheControl = c.req.header('cache-control')?.toLowerCase() ?? '';
    const bypass =
      /\b(no-cache|no-store)\b/.test(cacheControl) ||
      ['bypass', 'no-store', 'no-cache'].includes((c.req.header('x-pourgate-cache') ?? '').toLowerCase());
    let cacheKey: string | undefined;
    const scope = clientId !== undefined ? `client:${clientId}` : 'env';
    const semantic = cache ? opts.semantic : undefined;
    let queryVec: Float32Array | null = null;
    let context: string | undefined;
    let serveCached: ((hit: CachedResponse, kind: Exclude<CacheResult, 'miss'>, extra?: Record<string, string>) => Response) | undefined;
    // Identical cacheable requests that arrive while one is already being answered share its answer.
    let finishFlight: (entry?: CachedResponse) => void = () => {};
    if (cache && !bypass && cache.eligible(payload)) {
      cacheKey = cache.key(scope, payload, `${privacy.pii}|${privacy.policy}`);
      const serve = (hit: CachedResponse, kind: Exclude<CacheResult, 'miss'>, extra: Record<string, string> = {}): Response => {
        cache.note(kind);
        const headers = new Headers({ 'content-type': 'application/json', 'x-pourgate-cache': kind, age: String(Math.floor(hit.ageMs / 1000)), ...extra });
        if (hit.provider) headers.set('x-pourgate-provider', hit.provider);
        if (hit.model) headers.set('x-pourgate-model', hit.model);
        if (hit.tier) headers.set('x-pourgate-tier', hit.tier);
        if (hit.complexity) headers.set('x-pourgate-complexity', hit.complexity);
        const hitRes = new Response(hit.body, { status: 200, headers });
        const ms = performance.now() - startedAt;
        record({ routed: hitRes, totalMs: ms, ttfbMs: ms, tokens: null, error: null, cache: kind });
        return tag(hitRes);
      };
      serveCached = serve;
      const hit = cache.get(cacheKey);
      if (hit) return serve(hit, 'hit');
      if (semantic) {
        // Opt-in semantic cache: reuse the answer to a very similar prompt with an identical context.
        const text = lastUserText(payload);
        if (text.length >= 8) {
          queryVec = await embedQuery(semantic.model, text.slice(0, 2000), privacy, c.req.raw.signal);
          if (queryVec) {
            context = contextHash(payload);
            const match = semantic.index.find(scope, context, queryVec);
            if (match) {
              const similar = cache.get(match.key);
              if (similar) return serve(similar, 'semantic', { 'x-pourgate-cache-similarity': match.similarity.toFixed(4) });
              semantic.index.remove(match.key);
            }
          }
        }
      }
      const pending = inflight.get(cacheKey);
      if (pending) {
        const shared = await pending;
        if (shared) return serve({ ...shared, ageMs: 0 }, 'coalesced');
      } else {
        const key = cacheKey;
        let settle: (entry?: CachedResponse) => void = () => {};
        inflight.set(key, new Promise<CachedResponse | undefined>((resolve) => (settle = resolve)));
        const giveUp = setTimeout(() => finishFlight(), 120_000);
        finishFlight = (entry) => {
          clearTimeout(giveUp);
          if (inflight.delete(key)) settle(entry);
        };
      }
      cache.note('miss');
    }

    let routed: Response;
    try {
      routed = await routeChat(
      {
        registry: getRegistry(),
        pools: opts.pools,
        fetch: doFetch,
        privacy,
        scoring: opts.scoring,
        observedLimits: opts.observedLimits,
        breaker,
        latency,
        profiles: opts.profiles,
        fusionPanel: opts.fusionPanel,
        sticky,
        sessionKey: sessionKeyOf(c),
        timeoutMs: opts.upstreamTimeoutMs,
        adapters: opts.plugins?.adapters,
        onAttempt: tracer
          ? (a) =>
              tracer.record({
                traceId,
                spanId: newSpanId(),
                parentSpanId: spanId,
                name: `upstream ${a.provider}`,
                kind: 3,
                startMs: a.startMs,
                endMs: a.endMs,
                attributes: { 'gen_ai.system': a.provider, 'gen_ai.request.model': a.model, 'http.response.status_code': a.status },
                error: a.status === null ? 'network_error' : a.status >= 400 ? `http_${a.status}` : undefined,
              })
          : undefined,
      },
      payload,
      payload.model as string,
      c.req.raw.signal,
      endpoint,
      form,
    );
    } catch (err) {
      finishFlight();
      throw err;
    }
    const ttfbMs = performance.now() - startedAt;
    if (cacheKey && cache && serveCached && routed.status === 503) {
      // Every provider failed: an expired copy is better than an error (only if stale serving is enabled).
      const stale = cache.getStale(cacheKey);
      finishFlight();
      if (stale) {
        await routed.body?.cancel();
        return serveCached(stale, 'stale', { warning: '110 - "Response is stale"' });
      }
    } else if (routed.status !== 200) {
      finishFlight();
    }
    const res =
      opts.requestLog || opts.metrics || tracer || opts.plugins?.hasHooks || cacheKey
        ? observeResponse(routed, startedAt, (f) => {
            if (cacheKey && cache && routed.status === 200 && f.body) {
              try {
                cache.set(cacheKey, {
                  body: f.body.toString('utf8'),
                  provider: routed.headers.get('x-pourgate-provider'),
                  model: routed.headers.get('x-pourgate-model'),
                  tier: routed.headers.get('x-pourgate-tier'),
                  complexity: routed.headers.get('x-pourgate-complexity'),
                });
                if (semantic && queryVec && context) semantic.index.add(cacheKey, scope, context, queryVec);
                finishFlight({
                  body: f.body.toString('utf8'),
                  provider: routed.headers.get('x-pourgate-provider'),
                  model: routed.headers.get('x-pourgate-model'),
                  tier: routed.headers.get('x-pourgate-tier'),
                  complexity: routed.headers.get('x-pourgate-complexity'),
                  ageMs: 0,
                });
              } catch (err) {
                console.error('[cache] store failed:', err instanceof Error ? err.message : err);
              }
            }
            finishFlight();
            record({ routed, totalMs: f.totalMs, ttfbMs, tokens: f.tokens, error: f.error, cache: cacheKey ? 'miss' : null });
          })
        : routed;

    // Best-effort token accounting for non-streaming JSON responses.
    if (clientId !== undefined && res.ok && res.headers.get('content-type')?.includes('application/json')) {
      const id = clientId;
      void res
        .clone()
        .json()
        .then((json: { usage?: { total_tokens?: number } }) => {
          const total = json?.usage?.total_tokens;
          if (typeof total === 'number' && total > 0) opts.store.recordTokens(id, total);
        })
        .catch(() => {});
    }
    return tag(res);
  };

  app.post('/v1/chat/completions', (c) => handle(c, 'chat'));
  app.post('/v1/embeddings', (c) => handle(c, 'embeddings'));
  app.post('/v1/audio/transcriptions', (c) => handle(c, 'transcription'));
  app.post('/v1/audio/speech', (c) => handle(c, 'speech'));
  app.post('/v1/images/generations', (c) => handle(c, 'images'));

  // Model Context Protocol endpoint (Streamable HTTP, stateless). It lives under /v1 to share authentication,
  // size limits and rate limits; /mcp is an alias for clients that expect that path.
  app.post('/v1/mcp', async (c) => {
    const auth = c.req.header('authorization') ?? (c.req.header('x-api-key') ? `Bearer ${c.req.header('x-api-key')}` : '');
    const backend: McpBackend = {
      version: process.env.POURGATE_VERSION ?? 'dev',
      models: () => [...VIRTUAL_MODELS, 'fusion', ...(opts.profiles?.names().map((n) => `auto:${n}`) ?? []), ...new Set(getRegistry().flatMap((p) => p.models.filter((m) => m.capabilities.includes('chat')).map((m) => m.id)))],
      providers: () => getRegistry().map((p) => ({ provider: p.provider, enabled: opts.pools.has(p.provider), models: p.models.length, keyless: p.keyless === true })),
      chat: async (body) => {
        const res = await app.fetch(new Request(new URL('/v1/chat/completions', c.req.url), { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify(body) }));
        const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown; reasoning?: unknown } }[]; error?: { message?: string } } | null;
        if (!res.ok) return { ok: false, error: json?.error?.message ?? `request failed (${res.status})` };
        const m = json?.choices?.[0]?.message;
        const out = typeof m?.content === 'string' && m.content ? m.content : typeof m?.reasoning === 'string' ? m.reasoning : '';
        return { ok: true, text: out, provider: res.headers.get('x-pourgate-provider'), model: res.headers.get('x-pourgate-model') };
      },
    };
    const body = await c.req.json().catch(() => undefined);
    if (body === undefined) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    const r = await handleBody(body, backend);
    return r.json === undefined ? c.body(null, r.status as 202) : c.json(r.json as object, r.status as 200);
  });
  app.get('/v1/mcp', (c) => c.body(null, 405, { allow: 'POST' }));
  app.all('/mcp', (c) => app.fetch(new Request(new URL('/v1/mcp', c.req.url), c.req.raw)));

  // Legacy completions (editor autocomplete) and the Responses API (Codex CLI) on top of chat completions.
  const translated = (convert: (b: Record<string, unknown>) => Record<string, unknown>, wrap: (r: Response, model: string) => Promise<Response>) =>
    async (c: Context<{ Variables: { principal: Principal } }>) => {
      const body = (await c.req.json().catch(() => null)) as unknown;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return openaiError(400, 'Request body must be a JSON object');
      let chat: Record<string, unknown>;
      try {
        chat = convert(body as Record<string, unknown>);
      } catch (e) {
        if (e instanceof BadRequest) return openaiError(400, e.message);
        throw e;
      }
      return wrap(await handle(c, 'chat', chat), String((body as Record<string, unknown>).model));
    };
  app.post('/v1/completions', translated(completionsToChat, wrapCompletions));
  app.post('/v1/responses', translated(responsesToChat, wrapResponses));

  // Anthropic Messages API on top of the same pipeline (requests are translated to chat completions and back).
  const parseAnthropic = async (c: Context<{ Variables: { principal: Principal } }>): Promise<Record<string, unknown> | Response> => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return anthropicError(400, 'Request body must be a JSON object');
    const problem = validateRequest(body as Record<string, unknown>);
    return problem ? anthropicError(400, problem) : (body as Record<string, unknown>);
  };

  app.post('/v1/messages', async (c) => {
    const parsed = await parseAnthropic(c);
    if (parsed instanceof Response) return parsed;
    const res = await handle(c, 'chat', toOpenAIRequest(parsed));
    return wrapResponse(res, parsed.model as string, estimateInputTokens(parsed));
  });

  app.post('/v1/messages/count_tokens', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || !Array.isArray(body.messages)) return anthropicError(400, "'messages' must be an array");
    return c.json({ input_tokens: estimateInputTokens(body) });
  });

  if (opts.adminPassword) {
    app.route(
      '/admin/api',
      createAdminRoutes({
        password: opts.adminPassword,
        store: opts.store,
        registry: getRegistry,
        registrySync: opts.registrySync,
        pools: opts.pools,
        keyStore: opts.keyStore,
        poolManager: opts.poolManager,
        customProviders: opts.customProviders,
        onCustomChange: opts.onCustomChange,
        reservedNames: opts.reservedNames,
        requestLog: opts.requestLog,
        audit: opts.audit,
        breaker,
        latency,
        playground: (body) =>
          app.fetch(
            new Request('http://internal.invalid/v1/chat/completions', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${internalSecret}` },
              body: JSON.stringify(body),
            }),
          ),
        cache: opts.cache,
        evals: opts.evals,
        plugins: opts.plugins,
        observedLimits: opts.observedLimits,
        fetch: opts.fetch,
        secureCookie: opts.secureCookie,
      }),
    );
  }

  if (opts.staticDir && existsSync(resolve(opts.staticDir, 'index.html'))) {
    const root = relative(process.cwd(), resolve(opts.staticDir)) || '.';
    app.get('*', serveStatic({ root }));
    // SPA fallback for client-side routes (never for API paths).
    app.get('*', async (c, next) => {
      if (c.req.path.startsWith('/v1/') || c.req.path.startsWith('/admin/api/')) return next();
      return serveStatic({ root, path: 'index.html' })(c, next);
    });
  }

  app.notFound(() => errorResponse(404, 'Not found', 'invalid_request_error'));
  return app;
}
