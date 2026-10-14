import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { ProviderEntry } from '@pourgate/shared';
import { KeyPool } from './keypool.js';
import { AUTO_MODEL, errorResponse, routeChat } from './router.js';

export interface AppOptions {
  registry: ProviderEntry[];
  tokens: string[];
  pools: Map<string, KeyPool>;
  fetch?: typeof fetch;
}

function tokenMatches(candidate: string, tokens: string[]): boolean {
  const a = Buffer.from(candidate);
  let ok = false;
  for (const t of tokens) {
    const b = Buffer.from(t);
    // Always run the comparison to keep timing independent of which token matched.
    if (a.length === b.length && timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();
  const doFetch = opts.fetch ?? fetch;

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !tokenMatches(token, opts.tokens)) {
      return errorResponse(401, 'Invalid or missing API token', 'invalid_request_error', 'invalid_api_key');
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
    return routeChat(
      { registry: opts.registry, pools: opts.pools, fetch: doFetch },
      payload,
      payload.model,
      c.req.raw.signal,
    );
  });

  app.notFound(() => errorResponse(404, 'Not found', 'invalid_request_error'));
  return app;
}
