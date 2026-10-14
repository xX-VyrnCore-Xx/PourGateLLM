import { describe, expect, it, vi } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { redactEmbeddingBody } from '../src/privacy.js';
import { RequestLog } from '../src/requestlog.js';
import { TokenStore } from '../src/tokens.js';

const registry: ProviderEntry[] = [
  {
    provider: 'p1',
    base_url: 'https://p1.test/v1',
    api_key_env: 'P1_API_KEYS',
    auth: 'bearer',
    models: [
      { id: 'chat-1', capabilities: ['chat'], limits: {}, quirks: [] },
      { id: 'embed-1', capabilities: ['embeddings'], limits: {}, quirks: [] },
    ],
  },
  {
    provider: 'p2',
    base_url: 'https://p2.test/v1',
    api_key_env: 'P2_API_KEYS',
    auth: 'bearer',
    models: [{ id: 'embed-2', capabilities: ['embeddings'], limits: {}, quirks: [] }],
  },
];

const vector = { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], usage: { total_tokens: 4 } };

function setup(opts: { privacy?: 'all'; fetchImpl?: typeof fetch } = {}) {
  const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const db = openDatabase(':memory:');
  const requestLog = new RequestLog(db);
  const store = new TokenStore(db);
  const app = createApp({
    registry,
    store,
    envTokens: ['pg'],
    pools: new Map([['p1', new KeyPool(['k1', 'k1b'])], ['p2', new KeyPool(['k2'])]]),
    fetch:
      opts.fetchImpl ??
      ((async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(init.body as string), auth: (init.headers as Record<string, string>).authorization! });
        return Response.json(vector);
      }) as unknown as typeof fetch),
    privacy: opts.privacy ? { pii: 'all', policy: 'any' } : undefined,
    requestLog,
  });
  const post = async (body: unknown, token = 'pg') => {
    const res = await app.request('/v1/embeddings', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { res, text };
  };
  return { app, calls, post, store, requestLog };
}

describe('/v1/embeddings', () => {
  it('routes to an embeddings model with the right path and key', async () => {
    const { post, calls } = setup();
    const { res, text } = await post({ model: 'embed-1', input: 'hello' });
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual(vector);
    expect(calls[0]).toMatchObject({ url: 'https://p1.test/v1/embeddings', auth: 'Bearer k1' });
    expect(calls[0]!.body).toMatchObject({ model: 'embed-1', input: 'hello' });
    expect(res.headers.get('x-pourgate-provider')).toBe('p1');
  });

  it('spreads "auto" across embedding models and never picks chat models', async () => {
    const { post, calls } = setup();
    for (let i = 0; i < 4; i++) await post({ model: 'auto', input: 'x' });
    expect(new Set(calls.map((c) => c.body.model))).toEqual(new Set(['embed-1', 'embed-2']));
    expect(calls.every((c) => c.url.endsWith('/embeddings'))).toBe(true);
  });

  it('keeps chat and embeddings models apart', async () => {
    const { post, app } = setup();
    expect((await post({ model: 'chat-1', input: 'x' })).res.status).toBe(404);
    const chat = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer pg', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'embed-1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(chat.status).toBe(404);
    const virtualTier = await post({ model: 'auto:large', input: 'x' });
    expect(virtualTier.res.status).toBe(404);
  });

  it('validates the request and requires auth', async () => {
    const { post, app } = setup();
    expect((await post({ model: 'embed-1' })).res.status).toBe(400);
    expect((await post({ input: 'x' })).res.status).toBe(400);
    expect((await post({ model: 'embed-1', input: '' })).res.status).toBe(400);
    expect((await post({ model: 'embed-1', input: 'x' }, 'wrong')).res.status).toBe(401);
    const bad = await app.request('/v1/embeddings', { method: 'POST', headers: { authorization: 'Bearer pg' }, body: '{' });
    expect(bad.status).toBe(400);
  });

  it('fails over to the next key on 429', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(Response.json(vector));
    const { post } = setup({ fetchImpl: f as unknown as typeof fetch });
    expect((await post({ model: 'embed-1', input: 'x' })).res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('masks PII in string and array inputs when masking is on', async () => {
    const { post, calls, requestLog } = setup({ privacy: 'all' });
    const { res } = await post({ model: 'embed-1', input: ['mail a@b.co', 'plain'] });
    expect(res.headers.get('x-pourgate-redacted')).toBe('1');
    expect(calls[0]!.body.input).toEqual(['mail [EMAIL]', 'plain']);
    expect(requestLog.recent()[0]!.redacted).toBe(1);
    expect(redactEmbeddingBody({ input: [[1, 2, 3]] }).count).toBe(0); // token arrays pass through
  });

  it('applies client quotas and records usage', async () => {
    const { post, store, requestLog } = setup();
    const { token, record } = store.create({ name: 'c', dailyRequestLimit: 1 });
    expect((await post({ model: 'embed-1', input: 'x' }, token)).res.status).toBe(200);
    expect((await post({ model: 'embed-1', input: 'x' }, token)).res.status).toBe(429);
    await new Promise((r) => setTimeout(r, 10));
    expect(store.usageToday(record.id)).toEqual({ requests: 1, tokens: 4 });
    expect(requestLog.recent()[0]).toMatchObject({ requested: 'embed-1', tokens: 4 });
  });
});
