import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { ProviderEntry } from '@pourgate/shared';
import { KeyPool } from './keypool.js';
import { SlidingWindow } from './ratelimit.js';
import { AUTO_MODEL, errorResponse, routeChat } from './router.js';
import type { TokenRecord, TokenStore } from './tokens.js';

export interface AppOptions {
  registry: ProviderEntry[];
  /** Static bootstrap tokens (POURGATE_TOKENS): unlimited, not tracked. */
  envTokens?: string[];
  store: TokenStore;
  pools: Map<string, KeyPool>;
  fetch?: typeof fetch;
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
  const rpm = new SlidingWindow();

  app.get('/health', (c) => c.json({ status: 'ok' }));

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
      { id: AUTO_MODEL, object: 'model', created: 0, owned_by: 'pourgate' },
      ...opts.registry.flatMap((p) =>
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

    const res = await routeChat(
      { registry: opts.registry, pools: opts.pools, fetch: doFetch },
      payload,
      payload.model,
      c.req.raw.signal,
    );

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

  app.notFound(() => errorResponse(404, 'Not found', 'invalid_request_error'));
  return app;
}
