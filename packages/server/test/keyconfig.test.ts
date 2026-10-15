import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { Breaker } from '../src/breaker.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { KeyStore, KeyStoreError } from '../src/keys.js';
import { PoolManager } from '../src/pools.js';
import { TokenStore } from '../src/tokens.js';

const entry = (provider: string, models = ['m1']): ProviderEntry => ({
  provider,
  base_url: `https://${provider}.test/v1`,
  api_key_env: `${provider.toUpperCase()}_API_KEYS`,
  auth: 'bearer',
  models: models.map((id) => ({ id, capabilities: ['chat'], limits: {}, quirks: [] })),
});

describe('weighted keys', () => {
  it('shares traffic by weight, interleaved', () => {
    const pool = new KeyPool(['aaaaaaaa', 'bbbbbbbb'], { weights: new Map([['aaaaaaaa', 3]]) });
    const picks = Array.from({ length: 8 }, () => pool.acquire({ model: 'm' }));
    expect(picks.filter((k) => k === 'aaaaaaaa')).toHaveLength(6);
    expect(picks.filter((k) => k === 'bbbbbbbb')).toHaveLength(2);
    // Never a burst of more than 3 in a row.
    expect(picks.join().includes('aaaaaaaa,aaaaaaaa,aaaaaaaa,aaaaaaaa')).toBe(false);
  });

  it('keeps plain rotation with equal weights and skips excluded keys', () => {
    const pool = new KeyPool(['k1', 'k2', 'k3']);
    expect([1, 2, 3, 4].map(() => pool.acquire({ model: 'm' }))).toEqual(['k1', 'k2', 'k3', 'k1']);
    expect(pool.acquire({ model: 'm' }, new Set(['k2', 'k3']))).toBe('k1');
  });
});

describe('stored key settings', () => {
  const store = () => new KeyStore(openDatabase(':memory:'), randomBytes(32));

  it('disables keys, changes weight and label, and validates input', () => {
    const ks = store();
    const rec = ks.add('groq', 'gsk_abcdefghij', 'main', 3);
    expect(rec).toMatchObject({ enabled: true, weight: 3, label: 'main' });
    expect(ks.update(rec.id, { enabled: false, label: 'spare' })).toBe(true);
    expect(ks.list('groq')[0]).toMatchObject({ enabled: false, weight: 3, label: 'spare' });
    expect(ks.active('groq')).toEqual([]);
    expect(ks.update(rec.id, { enabled: true, weight: 5 })).toBe(true);
    expect(ks.active('groq')).toEqual([{ key: 'gsk_abcdefghij', weight: 5 }]);
    expect(() => ks.update(rec.id, { weight: 11 })).toThrow(KeyStoreError);
    expect(() => ks.add('groq', 'gsk_otherotherkey', '', 0)).toThrow(KeyStoreError);
    expect(ks.update(999, { enabled: false })).toBe(false);
  });

  it('feeds the pool only enabled keys, with their weights', () => {
    const ks = store();
    const a = ks.add('groq', 'gsk_aaaaaaaa1', '', 4);
    const b = ks.add('groq', 'gsk_bbbbbbbb2');
    const pm = new PoolManager(ks, { GROQ_API_KEYS: 'env-key-12345' }, () => {});
    pm.sync([entry('groq')]);
    expect(pm.pools.get('groq')!.keys).toEqual(['env-key-12345', 'gsk_aaaaaaaa1', 'gsk_bbbbbbbb2']);
    ks.update(b.id, { enabled: false });
    pm.refresh();
    expect(pm.pools.get('groq')!.keys).toEqual(['env-key-12345', 'gsk_aaaaaaaa1']);
    ks.update(a.id, { enabled: false });
    pm.refresh();
    expect(pm.pools.get('groq')!.keys).toEqual(['env-key-12345']);
  });
});

describe('admin key settings', () => {
  it('PATCH updates a key and reloads the pool; bad input is rejected', async () => {
    const db = openDatabase(':memory:');
    const ks = new KeyStore(db, randomBytes(32));
    const pm = new PoolManager(ks, {}, () => {});
    const reg = [entry('groq')];
    pm.sync(reg);
    const app = createApp({ registry: reg, store: new TokenStore(db), pools: pm.pools, keyStore: ks, poolManager: pm, adminPassword: 'pw' });
    const login = await app.request('/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
    const headers = { 'content-type': 'application/json', cookie: login.headers.get('set-cookie')!.split(';')[0]! };
    const created = await app.request('/admin/api/providers/groq/keys', { method: 'POST', headers, body: JSON.stringify({ key: 'gsk_abcdefghij', weight: 2 }) });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };
    expect(pm.pools.get('groq')!.keys).toHaveLength(1);

    const off = await app.request(`/admin/api/provider-keys/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) });
    expect(await off.json()).toMatchObject({ enabled: false, weight: 2 });
    expect(pm.pools.has('groq')).toBe(false);

    const bad = await app.request(`/admin/api/provider-keys/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ weight: 99 }) });
    expect(bad.status).toBe(400);
    expect((await app.request('/admin/api/provider-keys/999', { method: 'PATCH', headers, body: '{"enabled":true}' })).status).toBe(404);
  });
});

describe('circuit breaker', () => {
  it('opens after repeated failures, probes after the pause, and closes on success', () => {
    let t = 0;
    const b = new Breaker({ threshold: 3, baseMs: 1000, maxMs: 8000, now: () => t });
    b.failure('x');
    b.failure('x');
    expect(b.state('x')).toBe('closed');
    b.failure('x');
    expect(b.state('x')).toBe('open');
    expect(b.retryInMs('x')).toBe(1000);
    t = 1000;
    expect(b.state('x')).toBe('half-open');
    b.failure('x'); // failed probe: pause doubles
    expect(b.retryInMs('x')).toBe(2000);
    t = 3000;
    b.success('x');
    expect(b.state('x')).toBe('closed');
  });
});

describe('router resilience', () => {
  function build(fetcher: typeof fetch, extra: Partial<Parameters<typeof createApp>[0]> = {}) {
    const breaker = new Breaker({ threshold: 2, baseMs: 60_000 });
    const reg = [entry('bad'), entry('good')];
    const app = createApp({
      registry: reg,
      store: new TokenStore(openDatabase(':memory:')),
      envTokens: ['pg'],
      pools: new Map([['bad', new KeyPool(['bad-key-1', 'bad-key-2', 'bad-key-3'])], ['good', new KeyPool(['good-key-1'])]]),
      fetch: fetcher,
      breaker,
      ...extra,
    });
    return { app, breaker };
  }
  const chat = (app: ReturnType<typeof build>['app'], model = 'm1') =>
    app.request('/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer pg', 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) });

  it('stops sending traffic to a failing target once its circuit opens', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      const host = new URL(url).host;
      calls.push(host);
      return host.startsWith('bad') ? new Response('boom', { status: 502 }) : Response.json({ choices: [] });
    }) as typeof fetch;
    const { app, breaker } = build(fetcher);
    // Specific model ids resolve to both providers in registry order: bad first.
    expect((await chat(app)).status).toBe(200); // tries every bad key, then fails over
    expect(breaker.state('bad|m1')).toBe('open');
    calls.length = 0;
    expect((await chat(app)).status).toBe(200);
    expect(calls).toEqual(['good.test']);
  });

  it('gives up on an upstream that never answers and fails over', async () => {
    const fetcher = ((url: string, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        if (new URL(url).host.startsWith('bad')) {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        } else resolve(Response.json({ choices: [] }));
      })) as unknown as typeof fetch;
    const { app } = build(fetcher, { upstreamTimeoutMs: 1000 });
    const started = Date.now();
    const res = await chat(app);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.headers.get('x-pourgate-provider')).toBe('good');
  });
});
