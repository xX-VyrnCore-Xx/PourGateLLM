import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { ProviderEntry } from '@pourgate/shared';
import type { AuditLog } from './audit.js';
import type { Breaker } from './breaker.js';
import { KeyStoreError, type KeyStore } from './keys.js';
import type { ResponseCache } from './cache.js';
import type { EvalRunner, EvalStore, Strategy } from './evals.js';
import type { KeyPool } from './keypool.js';
import type { PluginHost } from './plugins.js';
import { detectDrift, type ObservedLimits } from './ratelimits.js';
import type { PoolManager } from './pools.js';
import type { RequestLog } from './requestlog.js';
import { SlidingWindow } from './ratelimit.js';
import type { SyncStatus } from './registry-sync.js';
import type { TokenStore } from './tokens.js';

export interface RegistrySyncHandle {
  status(): SyncStatus;
  sync(): Promise<SyncStatus>;
}

export interface AdminOptions {
  password: string;
  store: TokenStore;
  registry: () => ProviderEntry[];
  registrySync?: RegistrySyncHandle;
  /** Dashboard-managed provider keys (encrypted). Routes are disabled when unset. */
  keyStore?: KeyStore;
  poolManager?: PoolManager;
  requestLog?: RequestLog;
  audit?: AuditLog;
  breaker?: Breaker;
  /** Runs a chat request through the full gateway pipeline (routing, cache, failover) as the admin. */
  playground?: (body: Record<string, unknown>) => Response | Promise<Response>;
  cache?: ResponseCache;
  plugins?: PluginHost;
  observedLimits?: ObservedLimits;
  evals?: { runner: EvalRunner; store: EvalStore; strategy: Strategy; tasksPerModel: number; tasks: number };
  fetch?: typeof fetch;
  pools: Map<string, KeyPool>;
  /** Set the Secure cookie flag (use when served over HTTPS). */
  secureCookie?: boolean;
  now?: () => number;
}

const COOKIE = 'pg_session';
const COOKIE_PATH = '/admin/api';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sha = (s: string) => createHash('sha256').update(s).digest();

export function createAdminRoutes(opts: AdminOptions): Hono {
  const app = new Hono();
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, number>();
  const loginLimiter = new SlidingWindow(60_000, now);
  const passwordDigest = sha(opts.password);

  const sessionValid = (id: string | undefined): boolean => {
    if (!id) return false;
    const exp = sessions.get(id);
    if (exp === undefined) return false;
    if (exp <= now()) {
      sessions.delete(id);
      return false;
    }
    return true;
  };

  // CSRF defense in depth (cookie is SameSite=Strict): reject cross-origin state-changing requests.
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin) {
        let host: string | undefined;
        try {
          host = new URL(origin).host;
        } catch {
          // fall through: invalid origin is rejected below
        }
        if (host !== c.req.header('host')) return c.json({ error: 'cross-origin request rejected' }, 403);
      }
    }
    await next();
  });

  const clientIp = (c: Context): string => {
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown'; // no socket info (e.g. tests)
    }
  };

  app.post('/login', async (c) => {
    const ip = clientIp(c);
    if (!loginLimiter.take(ip, 10)) {
      opts.audit?.record('login_rate_limited', { ip });
      return c.json({ error: 'too many attempts, retry in a minute' }, 429);
    }

    const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
    const supplied = typeof body?.password === 'string' ? body.password : '';
    if (!timingSafeEqual(sha(supplied), passwordDigest)) {
      opts.audit?.record('login_failed', { ip });
      return c.json({ error: 'invalid password' }, 401);
    }
    opts.audit?.record('login', { ip });

    const id = randomBytes(32).toString('base64url');
    sessions.set(id, now() + SESSION_TTL_MS);
    setCookie(c, COOKIE, id, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: opts.secureCookie ?? false,
      path: COOKIE_PATH,
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.body(null, 204);
  });

  app.post('/logout', (c) => {
    const id = getCookie(c, COOKIE);
    if (id) {
      sessions.delete(id);
      opts.audit?.record('logout', { ip: clientIp(c) });
    }
    deleteCookie(c, COOKIE, { path: COOKIE_PATH });
    return c.body(null, 204);
  });

  // Everything below requires a valid session.
  app.use('*', async (c, next) => {
    if (!sessionValid(getCookie(c, COOKIE))) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.get('/session', (c) => c.json({ authenticated: true }));

  app.get('/tokens', (c) =>
    c.json(
      opts.store.list().map((t) => ({
        ...t,
        usageToday: opts.store.usageToday(t.id),
      })),
    ),
  );

  app.post('/tokens', async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof b?.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 100) return c.json({ error: "'name' is required (max 100 chars)" }, 400);
    const positive = (v: unknown): number | undefined | null =>
      v === undefined || v === null || v === '' ? undefined : Number.isInteger(v) && (v as number) > 0 ? (v as number) : null;
    const rpm = positive(b?.rpm);
    const daily = positive(b?.daily);
    const days = positive(b?.expiresDays);
    if (rpm === null || daily === null || days === null) {
      return c.json({ error: 'rpm, daily and expiresDays must be positive integers' }, 400);
    }
    const { token, record } = opts.store.create({
      name,
      rpmLimit: rpm,
      dailyRequestLimit: daily,
      expiresAt: days ? now() + days * 86_400_000 : undefined,
    });
    opts.audit?.record('token_create', { ip: clientIp(c), target: `#${record.id}`, detail: name });
    return c.json({ token, record }, 201);
  });

  app.delete('/tokens/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    if (!opts.store.revoke(id)) return c.json({ error: 'not found or already revoked' }, 404);
    opts.audit?.record('token_revoke', { ip: clientIp(c), target: `#${id}` });
    return c.body(null, 204);
  });

  const syncLimiter = new SlidingWindow(60_000, now);
  app.get('/registry', (c) => c.json(opts.registrySync?.status() ?? null));
  app.post('/registry/sync', async (c) => {
    if (!opts.registrySync) return c.json({ error: 'registry sync is not configured' }, 404);
    if (!syncLimiter.take('sync', 6)) return c.json({ error: 'too many sync requests' }, 429);
    opts.audit?.record('registry_sync', { ip: clientIp(c) });
    return c.json(await opts.registrySync.sync());
  });

  const RANGES: Record<string, { ms: number; bucketMs: number }> = {
    '24h': { ms: 86_400_000, bucketMs: 3_600_000 },
    '7d': { ms: 7 * 86_400_000, bucketMs: 6 * 3_600_000 },
    '30d': { ms: 30 * 86_400_000, bucketMs: 86_400_000 },
  };

  app.get('/analytics', (c) => {
    if (!opts.requestLog) return c.json({ error: 'request log is not configured' }, 404);
    const range = RANGES[c.req.query('range') ?? '24h'];
    if (!range) return c.json({ error: "range must be one of 24h, 7d, 30d" }, 400);
    return c.json(opts.requestLog.analytics(now() - range.ms, range.bucketMs));
  });

  const evalLimiter = new SlidingWindow(60_000, now);
  app.get('/plugins', (c) => c.json({ plugins: opts.plugins?.plugins.map((p) => ({ name: p.name, hooks: [p.onRequest && 'onRequest', p.onResponse && 'onResponse'].filter(Boolean), adapters: Object.keys(p.adapters ?? {}) })) ?? [] }));

  app.get('/evals', (c) => {
    const e = opts.evals;
    if (!e) return c.json({ enabled: false });
    return c.json({
      enabled: true,
      strategy: e.strategy,
      tasks: e.tasks,
      tasksPerModel: e.tasksPerModel,
      running: e.runner.running,
      lastRun: e.runner.lastRun,
      scores: e.store.scores(),
    });
  });
  app.post('/evals/run', async (c) => {
    const e = opts.evals;
    if (!e) return c.json({ error: 'evals are not enabled' }, 404);
    if (e.runner.running) return c.json({ error: 'an eval run is already in progress' }, 409);
    if (!evalLimiter.take('run', 3)) return c.json({ error: 'too many requests' }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { models?: unknown };
    const models = Array.isArray(body?.models) && body.models.every((m) => typeof m === 'string') ? (body.models as string[]) : undefined;
    opts.audit?.record('eval_run', { ip: clientIp(c), detail: models ? `${models.length} model(s)` : 'all models' });
    void e.runner.run({ tasksPerModel: e.tasksPerModel, models }).catch((err) => console.error('[evals]', err instanceof Error ? err.message : err));
    return c.json({ started: true }, 202);
  });

  app.get('/cache', (c) => c.json(opts.cache ? { enabled: true, mode: opts.cache.mode, ...opts.cache.stats() } : { enabled: false }));
  app.delete('/cache', (c) => {
    if (!opts.cache) return c.json({ error: 'cache is not enabled' }, 404);
    const model = c.req.query('model') || undefined;
    const cleared = opts.cache.clear(model);
    opts.audit?.record('cache_clear', { ip: clientIp(c), target: model, detail: `${cleared} entries` });
    return c.json({ cleared });
  });

  const playLimiter = new SlidingWindow(60_000, now);
  app.post('/playground', async (c) => {
    if (!opts.playground) return c.json({ error: 'playground is not available' }, 404);
    if (!playLimiter.take('play', 30)) return c.json({ error: 'too many requests' }, 429);
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof b?.model !== 'string' || !b.model) return c.json({ error: "'model' is required" }, 400);
    if (!Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length > 50) {
      return c.json({ error: "'messages' must be a non-empty array (max 50)" }, 400);
    }
    const wantStream = b.stream === true;
    const started = now();
    const res = await opts.playground({
      model: b.model,
      messages: b.messages,
      max_tokens: Math.min(1024, Math.max(1, Number(b.max_tokens) || 512)),
      stream: wantStream,
    });
    opts.audit?.record('playground', { ip: clientIp(c), target: b.model });
    // Streamed answer: pass the SSE body straight through; the route comes back in the headers.
    if (wantStream && res.ok && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const headers = new Headers({ 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      for (const name of ['provider', 'model', 'tier', 'complexity', 'cache']) {
        const v = res.headers.get(`x-pourgate-${name}`);
        if (v) headers.set(`x-pourgate-${name}`, v);
      }
      return new Response(res.body, { status: 200, headers });
    }
    const data = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { total_tokens?: number };
      error?: { message?: string };
    } | null;
    const h = (name: string) => res.headers.get(name);
    const content = data?.choices?.[0]?.message?.content;
    return c.json({
      ok: res.ok,
      status: res.status,
      content: typeof content === 'string' ? content : null,
      error: res.ok ? null : (data?.error?.message ?? res.statusText),
      tokens: data?.usage?.total_tokens ?? null,
      elapsedMs: now() - started,
      route: {
        provider: h('x-pourgate-provider'),
        model: h('x-pourgate-model'),
        tier: h('x-pourgate-tier'),
        complexity: h('x-pourgate-complexity'),
        cache: h('x-pourgate-cache'),
      },
    });
  });

  app.get('/audit', (c) => {
    if (!opts.audit) return c.json({ error: 'audit log is not configured' }, 404);
    return c.json(opts.audit.recent(Number(c.req.query('limit') ?? 100) || 100, c.req.query('action') || undefined));
  });

  app.get('/requests', (c) => {
    if (!opts.requestLog) return c.json({ error: 'request log is not configured' }, 404);
    return c.json(opts.requestLog.recent(Number(c.req.query('limit') ?? 100) || 100));
  });

  // JSON Lines export of request metadata (no prompts or completions are ever stored).
  app.get('/requests.jsonl', (c) => {
    if (!opts.requestLog) return c.json({ error: 'request log is not configured' }, 404);
    const range = RANGES[c.req.query('range') ?? '24h'] ?? RANGES['24h']!;
    const body = opts.requestLog.since(now() - range.ms).map((e) => JSON.stringify(e)).join('\n');
    return c.body(body ? `${body}\n` : '', 200, {
      'content-type': 'application/x-ndjson',
      'content-disposition': 'attachment; filename="pourgate-requests.jsonl"',
    });
  });

  const providerByName = (name: string) => opts.registry().find((p) => p.provider === name);
  const keyAdminReady = () => opts.keyStore !== undefined && opts.poolManager !== undefined;

  app.get('/providers/:name/keys', (c) => {
    const entry = providerByName(c.req.param('name'));
    if (!entry) return c.json({ error: 'unknown provider' }, 404);
    if (!keyAdminReady()) return c.json({ error: 'key management is not configured' }, 404);
    return c.json({ env: opts.poolManager!.envKeys(entry).length, keys: opts.keyStore!.list(entry.provider) });
  });

  app.post('/providers/:name/keys', async (c) => {
    const entry = providerByName(c.req.param('name'));
    if (!entry) return c.json({ error: 'unknown provider' }, 404);
    if (!keyAdminReady()) return c.json({ error: 'key management is not configured' }, 404);
    const b = (await c.req.json().catch(() => null)) as { key?: unknown; label?: unknown; weight?: unknown } | null;
    if (typeof b?.key !== 'string') return c.json({ error: "'key' is required" }, 400);
    try {
      const record = opts.keyStore!.add(entry.provider, b.key, typeof b.label === 'string' ? b.label : undefined, b.weight === undefined ? 1 : Number(b.weight));
      opts.poolManager!.refresh();
      opts.audit?.record('provider_key_add', { ip: clientIp(c), target: entry.provider, detail: `…${record.last4}` });
      return c.json(record, 201);
    } catch (err) {
      if (err instanceof KeyStoreError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  // Rename a key, switch it off/on, or change its share of traffic. Disabled keys stay stored but are not used.
  app.patch('/provider-keys/:id', async (c) => {
    if (!keyAdminReady()) return c.json({ error: 'key management is not configured' }, 404);
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    const b = (await c.req.json().catch(() => null)) as { label?: unknown; enabled?: unknown; weight?: unknown } | null;
    if (!b || typeof b !== 'object') return c.json({ error: 'invalid body' }, 400);
    if (b.label !== undefined && typeof b.label !== 'string') return c.json({ error: "'label' must be a string" }, 400);
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return c.json({ error: "'enabled' must be a boolean" }, 400);
    try {
      const ok = opts.keyStore!.update(id, {
        label: b.label as string | undefined,
        enabled: b.enabled as boolean | undefined,
        weight: b.weight === undefined ? undefined : Number(b.weight),
      });
      if (!ok) return c.json({ error: 'not found' }, 404);
    } catch (err) {
      if (err instanceof KeyStoreError) return c.json({ error: err.message }, 400);
      throw err;
    }
    opts.poolManager!.refresh();
    opts.audit?.record('provider_key_update', { ip: clientIp(c), target: `#${id}`, detail: JSON.stringify({ enabled: b.enabled, weight: b.weight, renamed: b.label !== undefined }) });
    return c.json(opts.keyStore!.list().find((k) => k.id === id));
  });

  app.delete('/provider-keys/:id', (c) => {
    if (!keyAdminReady()) return c.json({ error: 'key management is not configured' }, 404);
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    if (!opts.keyStore!.remove(id)) return c.json({ error: 'not found' }, 404);
    opts.poolManager!.refresh();
    opts.audit?.record('provider_key_remove', { ip: clientIp(c), target: `#${id}` });
    return c.body(null, 204);
  });

  // Cheap liveness check: GET {base_url}/models with the key. Only the HTTP status is reported back.
  const testLimiter = new SlidingWindow(60_000, now);
  app.post('/provider-keys/:id/test', async (c) => {
    if (!keyAdminReady()) return c.json({ error: 'key management is not configured' }, 404);
    if (!testLimiter.take('test', 20)) return c.json({ error: 'too many tests' }, 429);
    const secret = opts.keyStore!.secretById(Number(c.req.param('id')));
    const entry = secret && providerByName(secret.provider);
    if (!secret || !entry) return c.json({ error: 'not found' }, 404);
    try {
      const res = await (opts.fetch ?? fetch)(`${entry.base_url.replace(/\/$/, '')}/models`, {
        headers: { authorization: `Bearer ${secret.key}` },
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel();
      return c.json({ ok: res.ok, status: res.status });
    } catch {
      return c.json({ ok: false, status: null });
    }
  });

  app.get('/providers', (c) =>
    c.json(
      opts.registry().map((p) => {
        const pool = opts.pools.get(p.provider);
        return {
          provider: p.provider,
          enabled: pool !== undefined,
          keys: pool?.keys.length ?? 0,
          keysFromEnv: opts.poolManager?.envKeys(p).length ?? null,
          keysCooling: pool?.coolingCount() ?? 0,
          trainsOnPrompts: p.trains_on_prompts ?? null,
          signupUrl: p.signup_url ?? null,
          models: p.models.map((m) => ({
            id: m.id,
            circuit: opts.breaker?.state(`${p.provider}|${m.id}`) ?? 'closed',
            tier: m.tier ?? null,
            capabilities: m.capabilities,
            context: m.context ?? null,
            limits: m.limits,
            verifiedAt: m.verified_at ?? null,
            usageToday: pool?.usageToday(m.id) ?? { requests: 0, tokens: 0 },
            observed: (() => {
              const o = opts.observedLimits?.get(p.provider, m.id);
              return o ? { limitRequests: o.limitRequests, limitTokens: o.limitTokens, observedAt: o.observedAt, drift: detectDrift(o, m.limits) } : null;
            })(),
          })),
        };
      }),
    ),
  );

  return app;
}
