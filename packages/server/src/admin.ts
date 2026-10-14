import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { ProviderEntry } from '@pourgate/shared';
import { KeyStoreError, type KeyStore } from './keys.js';
import type { ResponseCache } from './cache.js';
import type { EvalRunner, EvalStore, Strategy } from './evals.js';
import type { KeyPool } from './keypool.js';
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
  cache?: ResponseCache;
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

  app.post('/login', async (c) => {
    let ip = 'unknown';
    try {
      ip = getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      // no socket info (e.g. tests)
    }
    if (!loginLimiter.take(ip, 10)) return c.json({ error: 'too many attempts, retry in a minute' }, 429);

    const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
    const supplied = typeof body?.password === 'string' ? body.password : '';
    if (!timingSafeEqual(sha(supplied), passwordDigest)) return c.json({ error: 'invalid password' }, 401);

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
    if (id) sessions.delete(id);
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
    return c.json({ token, record }, 201);
  });

  app.delete('/tokens/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    return opts.store.revoke(id) ? c.body(null, 204) : c.json({ error: 'not found or already revoked' }, 404);
  });

  const syncLimiter = new SlidingWindow(60_000, now);
  app.get('/registry', (c) => c.json(opts.registrySync?.status() ?? null));
  app.post('/registry/sync', async (c) => {
    if (!opts.registrySync) return c.json({ error: 'registry sync is not configured' }, 404);
    if (!syncLimiter.take('sync', 6)) return c.json({ error: 'too many sync requests' }, 429);
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
    void e.runner.run({ tasksPerModel: e.tasksPerModel, models }).catch((err) => console.error('[evals]', err instanceof Error ? err.message : err));
    return c.json({ started: true }, 202);
  });

  app.get('/cache', (c) => c.json(opts.cache ? { enabled: true, mode: opts.cache.mode, ...opts.cache.stats() } : { enabled: false }));
  app.delete('/cache', (c) => {
    if (!opts.cache) return c.json({ error: 'cache is not enabled' }, 404);
    return c.json({ cleared: opts.cache.clear() });
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
    const b = (await c.req.json().catch(() => null)) as { key?: unknown; label?: unknown } | null;
    if (typeof b?.key !== 'string') return c.json({ error: "'key' is required" }, 400);
    try {
      const record = opts.keyStore!.add(entry.provider, b.key, typeof b.label === 'string' ? b.label : undefined);
      opts.poolManager!.refresh();
      return c.json(record, 201);
    } catch (err) {
      if (err instanceof KeyStoreError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.delete('/provider-keys/:id', (c) => {
    if (!keyAdminReady()) return c.json({ error: 'key management is not configured' }, 404);
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    if (!opts.keyStore!.remove(id)) return c.json({ error: 'not found' }, 404);
    opts.poolManager!.refresh();
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
          models: p.models.map((m) => ({
            id: m.id,
            tier: m.tier ?? null,
            capabilities: m.capabilities,
            context: m.context ?? null,
            limits: m.limits,
            verifiedAt: m.verified_at ?? null,
            usageToday: pool?.usageToday(m.id) ?? { requests: 0, tokens: 0 },
          })),
        };
      }),
    ),
  );

  return app;
}
