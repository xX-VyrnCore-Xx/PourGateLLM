import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { KeyPool } from '../src/keypool.js';
import { loadRegistry } from '../src/registry.js';

const registry: ProviderEntry[] = [
  {
    provider: 'groq',
    base_url: 'https://upstream.test/v1',
    api_key_env: 'GROQ_API_KEYS',
    auth: 'bearer',
    models: [{ id: 'm1', capabilities: ['chat'], limits: {}, quirks: [] }],
  },
];

const auth = { authorization: 'Bearer pg-test', 'content-type': 'application/json' };
const chatBody = JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] });

function setup(fetchImpl: typeof fetch, keys = ['k1', 'k2']) {
  return createApp({
    registry,
    tokens: ['pg-test'],
    pools: new Map([['groq', new KeyPool(keys)]]),
    fetch: fetchImpl,
  });
}

describe('registry', () => {
  it('validates the shipped registry files', () => {
    const entries = loadRegistry(resolve(__dirname, '../../../registry'));
    expect(entries.length).toBeGreaterThan(0);
  });

  it('has unique providers and key env vars, and unique model ids per provider', () => {
    const entries = loadRegistry(resolve(__dirname, '../../../registry'));
    expect(new Set(entries.map((e) => e.provider)).size).toBe(entries.length);
    expect(new Set(entries.map((e) => e.api_key_env)).size).toBe(entries.length);
    for (const e of entries) {
      expect(new Set(e.models.map((m) => m.id)).size).toBe(e.models.length);
    }
  });
});

describe('gateway', () => {
  it('rejects requests without a valid token', async () => {
    const app = setup(vi.fn());
    const res = await app.request('/v1/models', { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  it('lists models including auto', async () => {
    const app = setup(vi.fn());
    const res = await app.request('/v1/models', { headers: auth });
    const json = (await res.json()) as { data: { id: string }[] };
    expect(json.data.map((m) => m.id)).toEqual(['auto', 'm1']);
  });

  it('proxies a chat completion with the provider key', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'x', choices: [] }));
    const app = setup(fetchMock as unknown as typeof fetch);
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: auth, body: chatBody });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-pourgate-provider')).toBe('groq');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://upstream.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k1');
  });

  it('rotates to the next key on 429', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '30' } }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const app = setup(fetchMock as unknown as typeof fetch);
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: auth, body: chatBody });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((second[1].headers as Record<string, string>).authorization).toBe('Bearer k2');
  });

  it('returns 503 when every key is exhausted', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 429 }));
    const app = setup(fetchMock as unknown as typeof fetch);
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: auth, body: chatBody });
    expect(res.status).toBe(503);
  });

  it('returns 404 for unknown models and 400 for bad bodies', async () => {
    const app = setup(vi.fn());
    const unknown = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'nope', messages: [] }),
    });
    expect(unknown.status).toBe(404);
    const bad = await app.request('/v1/chat/completions', { method: 'POST', headers: auth, body: '{' });
    expect(bad.status).toBe(400);
  });
});
