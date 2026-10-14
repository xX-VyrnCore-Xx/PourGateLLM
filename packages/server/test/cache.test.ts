import { describe, expect, it, vi } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { MAX_CACHED_BYTES, ResponseCache, parseCacheMode, type CacheOptions } from '../src/cache.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { Metrics } from '../src/metrics.js';
import { RequestLog } from '../src/requestlog.js';
import { TokenStore } from '../src/tokens.js';

const OPTS: CacheOptions = { ttlMs: 60_000, maxEntries: 3, mode: 'deterministic' };
const entry = (body = '{"ok":1}') => ({ body, provider: 'p', model: 'm', tier: null, complexity: null });

describe('ResponseCache', () => {
  const make = (opts: Partial<CacheOptions> = {}, now = () => 1_000) => new ResponseCache(openDatabase(':memory:'), { ...OPTS, ...opts }, now);

  it('parses the mode', () => {
    expect(parseCacheMode(undefined)).toBe('deterministic');
    expect(parseCacheMode('ALL')).toBe('all');
    expect(() => parseCacheMode('x')).toThrow();
  });

  it('decides eligibility by mode', () => {
    const det = make();
    expect(det.eligible({ temperature: 0 })).toBe(true);
    expect(det.eligible({ seed: 7, temperature: 0.8 })).toBe(true);
    expect(det.eligible({ temperature: 0.7 })).toBe(false);
    expect(det.eligible({})).toBe(false);
    expect(det.eligible({ temperature: 0, stream: true })).toBe(false);
    const all = make({ mode: 'all' });
    expect(all.eligible({})).toBe(true);
    expect(all.eligible({ stream: true })).toBe(false);
  });

  it('builds stable keys that ignore field order and irrelevant fields, but split by scope, privacy and content', () => {
    const c = make();
    const base = { model: 'm', temperature: 0, messages: [{ role: 'user', content: 'hi' }] };
    const k = c.key('client:1', base, 'off|any');
    expect(c.key('client:1', { messages: [{ content: 'hi', role: 'user' }], temperature: 0, model: 'm' }, 'off|any')).toBe(k);
    expect(c.key('client:1', { ...base, user: 'u1', metadata: { a: 1 }, stream: false }, 'off|any')).toBe(k);
    expect(c.key('client:2', base, 'off|any')).not.toBe(k);
    expect(c.key('client:1', base, 'all|any')).not.toBe(k);
    expect(c.key('client:1', { ...base, messages: [{ role: 'user', content: 'hello' }] }, 'off|any')).not.toBe(k);
    expect(c.key('client:1', { ...base, max_tokens: 5 }, 'off|any')).not.toBe(k);
  });

  it('stores, serves and counts hits, and expires entries by TTL', () => {
    let t = 1_000;
    const c = make({}, () => t);
    c.set('k', entry());
    expect(c.get('k')).toMatchObject({ body: '{"ok":1}', provider: 'p', ageMs: 0 });
    t += 5_000;
    expect(c.get('k')!.ageMs).toBe(5_000);
    expect(c.stats()).toMatchObject({ entries: 1, hits: 2 });
    t += 60_000;
    expect(c.get('k')).toBeUndefined();
    expect(c.stats().entries).toBe(0);
  });

  it('evicts the oldest entries beyond the cap and ignores oversized bodies', () => {
    let t = 1_000;
    const c = make({}, () => t++);
    for (const k of ['a', 'b', 'c', 'd']) c.set(k, entry(`{"k":"${k}"}`));
    expect(c.get('a')).toBeUndefined();
    expect(c.get('d')).toBeDefined();
    expect(c.stats().entries).toBe(3);
    c.set('big', entry(JSON.stringify({ x: 'y'.repeat(MAX_CACHED_BYTES) })));
    expect(c.get('big')).toBeUndefined();
    expect(c.clear()).toBe(3);
  });
});

describe('gateway cache', () => {
  const registry: ProviderEntry[] = [
    {
      provider: 'groq',
      base_url: 'https://up.test/v1',
      api_key_env: 'GROQ_API_KEYS',
      auth: 'bearer',
      models: [{ id: 'm1', capabilities: ['chat'], limits: {}, quirks: [] }],
    },
  ];
  const json = { 'content-type': 'application/json' };

  function setup(mode: 'deterministic' | 'all' = 'deterministic', upstreamStatus = 200) {
    const db = openDatabase(':memory:');
    const store = new TokenStore(db);
    const upstream = vi.fn(async () =>
      upstreamStatus === 200 ? Response.json({ id: 'r', usage: { total_tokens: 9 } }) : new Response('{}', { status: upstreamStatus }),
    );
    const cache = new ResponseCache(db, { ttlMs: 60_000, maxEntries: 100, mode });
    const requestLog = new RequestLog(db);
    const app = createApp({
      registry,
      store,
      envTokens: ['pg-env'],
      pools: new Map([['groq', new KeyPool(['k1'])]]),
      fetch: upstream as unknown as typeof fetch,
      cache,
      requestLog,
      metrics: new Metrics(),
      metricsToken: 'mt',
      adminPassword: 'pw',
    });
    const call = async (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, token = 'pg-env') => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { ...json, authorization: `Bearer ${token}`, ...headers },
        body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }], ...extra }),
      });
      const text = await res.text();
      return { res, text };
    };
    return { app, store, upstream, call, requestLog, cache };
  }

  it('serves identical deterministic requests from the cache', async () => {
    const { call, upstream } = setup();
    const a = await call({ temperature: 0 });
    expect(a.res.headers.get('x-pourgate-cache')).toBeNull();
    const b = await call({ temperature: 0 });
    expect(b.res.headers.get('x-pourgate-cache')).toBe('hit');
    expect(b.res.headers.get('x-pourgate-provider')).toBe('groq');
    expect(b.res.headers.get('age')).toBe('0');
    expect(b.text).toBe(a.text);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('does not cache non-deterministic, streaming or failed requests', async () => {
    const warm = setup();
    await warm.call({ temperature: 0.7 });
    await warm.call({ temperature: 0.7 });
    await warm.call({ temperature: 0, stream: true });
    await warm.call({ temperature: 0, stream: true });
    expect(warm.upstream).toHaveBeenCalledTimes(4);
    const failing = setup('deterministic', 500);
    await failing.call({ temperature: 0 });
    expect(failing.cache.stats().entries).toBe(0);
  });

  it('caches everything non-streaming in "all" mode', async () => {
    const { call, upstream } = setup('all');
    await call();
    expect((await call()).res.headers.get('x-pourgate-cache')).toBe('hit');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('never shares entries between clients', async () => {
    const { call, store, upstream } = setup();
    const a = store.create({ name: 'a' }).token;
    const b = store.create({ name: 'b' }).token;
    await call({ temperature: 0 }, {}, a);
    expect((await call({ temperature: 0 }, {}, a)).res.headers.get('x-pourgate-cache')).toBe('hit');
    expect((await call({ temperature: 0 }, {}, b)).res.headers.get('x-pourgate-cache')).toBeNull();
    expect((await call({ temperature: 0 })).res.headers.get('x-pourgate-cache')).toBeNull(); // env token is its own scope
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it('separates entries by the effective privacy settings', async () => {
    const { call, upstream } = setup();
    await call({ temperature: 0 });
    const strict = await call({ temperature: 0 }, { 'x-pourgate-privacy': 'redact' });
    expect(strict.res.headers.get('x-pourgate-cache')).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('can be bypassed per request', async () => {
    const { call, upstream } = setup();
    await call({ temperature: 0 });
    const headerSets: Record<string, string>[] = [{ 'x-pourgate-cache': 'bypass' }, { 'cache-control': 'no-cache' }, { 'cache-control': 'no-store' }];
    for (const h of headerSets) {
      expect((await call({ temperature: 0 }, h)).res.headers.get('x-pourgate-cache')).toBeNull();
    }
    expect(upstream).toHaveBeenCalledTimes(4);
  });

  it('records hits and misses in the log, analytics and metrics', async () => {
    const { app, call, requestLog } = setup();
    await call({ temperature: 0 });
    await call({ temperature: 0 });
    expect(requestLog.recent().map((r) => r.cache)).toEqual(['hit', 'miss']);
    expect(requestLog.analytics(0, 3_600_000).summary.cacheHits).toBe(1);
    const metrics = await (await app.request('/metrics', { headers: { authorization: 'Bearer mt' } })).text();
    expect(metrics).toContain('pourgate_cache_requests_total{result="hit"} 1');
    expect(metrics).toContain('pourgate_cache_requests_total{result="miss"} 1');
  });

  it('exposes stats and clearing to admins only', async () => {
    const { app, call } = setup();
    await call({ temperature: 0 });
    expect((await app.request('/admin/api/cache')).status).toBe(401);
    expect((await app.request('/admin/api/cache', { method: 'DELETE' })).status).toBe(401);
    const login = await app.request('/admin/api/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const stats = (await (await app.request('/admin/api/cache', { headers: { cookie } })).json()) as { enabled: boolean; entries: number };
    expect(stats).toMatchObject({ enabled: true, entries: 1 });
    const cleared = (await (await app.request('/admin/api/cache', { method: 'DELETE', headers: { cookie } })).json()) as { cleared: number };
    expect(cleared.cleared).toBe(1);
  });
});
