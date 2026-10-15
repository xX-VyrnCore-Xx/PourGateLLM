import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { ResponseCache } from '../src/cache.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { TokenStore } from '../src/tokens.js';

const entry = (body: string, model = 'm') => ({ body, provider: 'p', model, tier: null, complexity: null });

describe('ResponseCache: stale window, byte cap, selective clear', () => {
  it('keeps expired entries only inside the stale window', () => {
    let t = 1000;
    const c = new ResponseCache(openDatabase(':memory:'), { ttlMs: 100, staleMs: 500, maxEntries: 10, mode: 'all' }, () => t);
    c.set('k', entry('{"a":1}'));
    expect(c.get('k')).toBeDefined();
    t = 1200; // expired, still stale-servable
    expect(c.get('k')).toBeUndefined();
    expect(c.getStale('k')?.body).toBe('{"a":1}');
    t = 1700; // past the stale window
    expect(c.getStale('k')).toBeUndefined();
    expect(c.get('k')).toBeUndefined();
  });

  it('never serves stale when the window is off', () => {
    let t = 0;
    const c = new ResponseCache(openDatabase(':memory:'), { ttlMs: 100, maxEntries: 10, mode: 'all' }, () => t);
    c.set('k', entry('{}'));
    t = 150;
    expect(c.getStale('k')).toBeUndefined();
  });

  it('evicts the oldest entries beyond maxBytes', () => {
    let t = 0;
    const c = new ResponseCache(openDatabase(':memory:'), { ttlMs: 10_000, maxEntries: 100, maxBytes: 25, mode: 'all' }, () => t++);
    for (const k of ['a', 'b', 'c']) c.set(k, entry('0123456789'));
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBeDefined();
    expect(c.get('c')).toBeDefined();
    expect(c.stats().bytes).toBeLessThanOrEqual(25);
  });

  it('clears only one model on request', () => {
    const c = new ResponseCache(openDatabase(':memory:'), { ttlMs: 10_000, maxEntries: 100, mode: 'all' });
    c.set('x', entry('{}', 'm1'));
    c.set('y', entry('{}', 'm2'));
    expect(c.clear('m1')).toBe(1);
    expect(c.get('x')).toBeUndefined();
    expect(c.get('y')).toBeDefined();
    expect(c.clear()).toBe(1);
  });
});

describe('gateway cache: coalescing and stale-if-error', () => {
  const registry: ProviderEntry[] = [
    { provider: 'groq', base_url: 'https://up.test/v1', api_key_env: 'GROQ_API_KEYS', auth: 'bearer', models: [{ id: 'm1', capabilities: ['chat'], limits: {}, quirks: [] }] },
  ];

  function setup(fetcher: typeof fetch, cacheOpts: { ttlMs: number; staleMs?: number }, now?: () => number) {
    const db = openDatabase(':memory:');
    const cache = new ResponseCache(db, { maxEntries: 100, mode: 'all', ...cacheOpts }, now);
    const app = createApp({ registry, store: new TokenStore(db), envTokens: ['pg'], pools: new Map([['groq', new KeyPool(['k1'])]]), fetch: fetcher, cache });
    const call = async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer pg' },
        body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'same question' }] }),
      });
      return { res, text: await res.text() };
    };
    return { call, cache };
  }

  it('shares one upstream call between identical concurrent requests', async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      return Response.json({ id: 'r', usage: { total_tokens: 3 } });
    }) as typeof fetch;
    const { call, cache } = setup(fetcher, { ttlMs: 60_000 });
    const results = await Promise.all([call(), call(), call()]);
    expect(calls).toBe(1);
    expect(results.map((r) => r.res.headers.get('x-pourgate-cache')).sort()).toEqual([ 'coalesced', 'coalesced', null ]);
    expect(new Set(results.map((r) => r.text)).size).toBe(1);
    expect(cache.stats().served.coalesced).toBe(2);
  });

  it('lets followers retry on their own when the leader fails', async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return calls === 1 ? new Response('{}', { status: 400 }) : Response.json({ id: 'ok' });
    }) as typeof fetch;
    const { call } = setup(fetcher, { ttlMs: 60_000 });
    const [a, b] = await Promise.all([call(), call()]);
    expect([a.res.status, b.res.status].sort()).toEqual([200, 400]);
  });

  it('serves an expired answer when every provider is down, if stale serving is on', async () => {
    let t = 1_000_000;
    let down = false;
    const fetcher = (async () => (down ? new Response('boom', { status: 502 }) : Response.json({ id: 'fresh' }))) as typeof fetch;
    const { call, cache } = setup(fetcher, { ttlMs: 1000, staleMs: 60_000 }, () => t);
    const first = await call();
    expect(first.res.status).toBe(200);
    t += 5000; // expired
    down = true;
    const second = await call();
    expect(second.res.status).toBe(200);
    expect(second.res.headers.get('x-pourgate-cache')).toBe('stale');
    expect(second.res.headers.get('warning')).toContain('110');
    expect(second.text).toBe(first.text);
    expect(cache.stats().served.stale).toBe(1);
    t += 120_000; // beyond the stale window: the error comes through
    expect((await call()).res.status).toBe(503);
  });

  it('does not serve stale answers by default', async () => {
    let t = 1_000_000;
    let down = false;
    const fetcher = (async () => (down ? new Response('boom', { status: 502 }) : Response.json({ id: 'fresh' }))) as typeof fetch;
    const { call } = setup(fetcher, { ttlMs: 1000 }, () => t);
    await call();
    t += 5000;
    down = true;
    expect((await call()).res.status).toBe(503);
  });
});
