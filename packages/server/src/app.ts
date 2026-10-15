import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ProviderEntry } from '@pourgate/shared';
import { createAdminRoutes, type RegistrySyncHandle } from './admin.js';
import type { KeyStore } from './keys.js';
import { anthropicError, estimateInputTokens, toOpenAIRequest, validateRequest, wrapResponse } from './anthropic.js';
import type { ResponseCache } from './cache.js';
import type { EvalRunner, EvalStore, Strategy } from './evals.js';
import type { Metrics } from './metrics.js';
import { PluginError, RejectedByPlugin, type PluginHost } from './plugins.js';
import { newSpanId, newTraceId, parseTraceparent, type Tracer } from './otel.js';
import { DEFAULT_PRIVACY, tighten, type PrivacyConfig } from './privacy.js';
import { observeResponse } from './observe.js';
import type { RequestLog } from './requestlog.js';
import { KeyPool } from './keypool.js';
import type { PoolManager } from './pools.js';
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
  /** Largest accepted audio upload in bytes (default 25 MB). */
  maxUploadBytes?: number;
  /** Trusted plugins: request hooks, response observers and provider adapters. */
  plugins?: PluginHost;
  /** OTLP trace exporter; tracing is off when unset. */
  tracer?: Tracer;
  /** Exact-match response cache; disabled when unset. */
  cache?: ResponseCache;
  /** Request metadata log (SQLite); enables analytics in the admin API. */
  requestLog?: RequestLog;
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
  const envTokens = opts.envTokens ?? [];
  const getRegistry = typeof opts.registry === 'function' ? opts.registry : () => opts.registry as ProviderEntry[];
  const rpm = new SlidingWindow();
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

  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    // OpenAI clients send `Authorization: Bearer`; Anthropic SDKs send `x-api-key`.
    const token = header.startsWith('Bearer ') ? header.slice(7) : (c.req.header('x-api-key') ?? '');
    const invalid = () =>
      c.req.path.startsWith('/v1/messages')
        ? anthropicError(401, 'Invalid or missing API key')
        : errorResponse(401, 'Invalid or missing API token', 'invalid_request_error', 'invalid_api_key');
    if (!token) return invalid();
    if (envTokens.length > 0 && matchesAny(token, envTokens)) {
      c.set('principal', { kind: 'env' });
    } else {
      const record = opts.store.verify(token);
      if (!record) return invalid();
      c.set('principal', { kind: 'client', record });
    }
    await next();
  });

  app.get('/v1/models', (c) => {
    const data = [
      ...VIRTUAL_MODELS.map((id) => ({ id, object: 'model', created: 0, owned_by: 'pourgate' })),
      ...getRegistry().flatMap((p) =>
        p.models.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: p.provider })),
      ),
    ];
    return c.json({ object: 'list', data });
  });

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

    const record = (r: { routed: Response; totalMs: number; ttfbMs: number; tokens: number | null; error: string | null; cache: 'hit' | 'miss' | null }) => {
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
    if (cache && !bypass && cache.eligible(payload)) {
      cacheKey = cache.key(clientId !== undefined ? `client:${clientId}` : 'env', payload, `${privacy.pii}|${privacy.policy}`);
      const hit = cache.get(cacheKey);
      if (hit) {
        const headers = new Headers({ 'content-type': 'application/json', 'x-pourgate-cache': 'hit', age: String(Math.floor(hit.ageMs / 1000)) });
        if (hit.provider) headers.set('x-pourgate-provider', hit.provider);
        if (hit.model) headers.set('x-pourgate-model', hit.model);
        if (hit.tier) headers.set('x-pourgate-tier', hit.tier);
        if (hit.complexity) headers.set('x-pourgate-complexity', hit.complexity);
        const hitRes = new Response(hit.body, { status: 200, headers });
        const ms = performance.now() - startedAt;
        record({ routed: hitRes, totalMs: ms, ttfbMs: ms, tokens: null, error: null, cache: 'hit' });
        return tag(hitRes);
      }
    }

    const routed = await routeChat(
      {
        registry: getRegistry(),
        pools: opts.pools,
        fetch: doFetch,
        privacy,
        scoring: opts.scoring,
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
    const ttfbMs = performance.now() - startedAt;
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
              } catch (err) {
                console.error('[cache] store failed:', err instanceof Error ? err.message : err);
              }
            }
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
        requestLog: opts.requestLog,
        cache: opts.cache,
        evals: opts.evals,
        plugins: opts.plugins,
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
