import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ProviderEntry } from '@pourgate/shared';
import { createAdminRoutes, type RegistrySyncHandle } from './admin.js';
import type { KeyStore } from './keys.js';
import type { ResponseCache } from './cache.js';
import type { EvalRunner, EvalStore, Strategy } from './evals.js';
import type { Metrics } from './metrics.js';
import { DEFAULT_PRIVACY, tighten, type PrivacyConfig } from './privacy.js';
import { observeResponse } from './observe.js';
import type { RequestLog } from './requestlog.js';
import { KeyPool } from './keypool.js';
import type { PoolManager } from './pools.js';
import { SlidingWindow } from './ratelimit.js';
import { VIRTUAL_MODELS, errorResponse, routeChat, type Scoring } from './router.js';
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
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const invalid = () =>
      errorResponse(401, 'Invalid or missing API token', 'invalid_request_error', 'invalid_api_key');
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

  app.post('/v1/chat/completions', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(400, 'Request body must be valid JSON', 'invalid_request_error');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return errorResponse(400, 'Request body must be a JSON object', 'invalid_request_error');
    }
    const payload = body as Record<string, unknown>;
    if (typeof payload.model !== 'string' || !Array.isArray(payload.messages)) {
      return errorResponse(400, "'model' (string) and 'messages' (array) are required", 'invalid_request_error');
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

    const startedAt = performance.now();
    const startedWall = Date.now();
    const privacy = tighten(opts.privacy ?? DEFAULT_PRIVACY, c.req.header('x-pourgate-privacy'));

    const record = (r: { routed: Response; totalMs: number; ttfbMs: number; tokens: number | null; error: string | null; cache: 'hit' | 'miss' | null }) => {
      const provider = r.routed.headers.get('x-pourgate-provider');
      const model = r.routed.headers.get('x-pourgate-model');
      const complexity = r.routed.headers.get('x-pourgate-complexity');
      opts.metrics?.observe({ provider, model, status: r.routed.status, complexity, seconds: r.totalMs / 1000, tokens: r.tokens });
      if (r.cache) opts.metrics?.cache(r.cache);
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
    const cache = opts.cache;
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
        return hitRes;
      }
    }

    const routed = await routeChat(
      { registry: getRegistry(), pools: opts.pools, fetch: doFetch, privacy, scoring: opts.scoring },
      payload,
      payload.model,
      c.req.raw.signal,
    );
    const ttfbMs = performance.now() - startedAt;
    const res =
      opts.requestLog || opts.metrics || cacheKey
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
    return res;
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
