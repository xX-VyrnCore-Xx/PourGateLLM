import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { ObservedLimits, detectDrift, exhaustedFor, parseDuration, parseRateLimitHeaders } from '../src/ratelimits.js';
import { TokenStore } from '../src/tokens.js';

describe('parseDuration', () => {
  it('parses provider duration formats', () => {
    expect(parseDuration('1.5s')).toBe(1500);
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('1h2m3s')).toBe(3_723_000);
    expect(parseDuration('2m59.56s')).toBe(179_560);
    expect(parseDuration('7')).toBe(7000);
    expect(parseDuration('0.5')).toBe(500);
  });

  it('rejects junk and caps absurd values at 24 hours', () => {
    for (const bad of ['', undefined, null, 'soon', '5x', '1s later', '-3s']) expect(parseDuration(bad as string | undefined), String(bad)).toBeUndefined();
    expect(parseDuration('999d')).toBe(86_400_000);
  });
});

describe('parseRateLimitHeaders / exhaustedFor', () => {
  const headers = (o: Record<string, string>) => new Headers(o);

  it('reads the x-ratelimit headers and ignores missing or malformed ones', () => {
    expect(
      parseRateLimitHeaders(
        headers({
          'x-ratelimit-limit-requests': '14400',
          'x-ratelimit-limit-tokens': '18000',
          'x-ratelimit-remaining-requests': '14399',
          'x-ratelimit-remaining-tokens': 'abc',
          'x-ratelimit-reset-requests': '6s',
          'x-ratelimit-reset-tokens': '2m59.56s',
        }),
      ),
    ).toEqual({ limitRequests: 14400, limitTokens: 18000, remainingRequests: 14399, resetRequestsMs: 6000, resetTokensMs: 179_560 });
    expect(parseRateLimitHeaders(headers({}))).toEqual({});
  });

  it('only reports exhaustion when a window is empty and a reset time is known', () => {
    expect(exhaustedFor({ remainingRequests: 0, resetRequestsMs: 5000 })).toBe(5000);
    expect(exhaustedFor({ remainingRequests: 0, resetRequestsMs: 5000, remainingTokens: 0, resetTokensMs: 9000 })).toBe(9000);
    expect(exhaustedFor({ remainingRequests: 3, resetRequestsMs: 5000 })).toBe(0);
    expect(exhaustedFor({ remainingRequests: 0 })).toBe(0);
    expect(exhaustedFor({})).toBe(0);
  });
});

describe('ObservedLimits and drift', () => {
  it('stores reported limits, writes only on change and survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pg-ol-'));
    const path = join(dir, 'x.db');
    let now = 1000;
    const first = new ObservedLimits(openDatabase(path), () => now);
    first.record('p', 'm', {});
    expect(first.get('p', 'm')).toBeUndefined();
    first.record('p', 'm', { limitRequests: 100, limitTokens: 5000 });
    now = 2000;
    first.record('p', 'm', { limitRequests: 100 }); // unchanged, keeps the token limit seen before
    expect(first.get('p', 'm')).toMatchObject({ limitRequests: 100, limitTokens: 5000, observedAt: 2000 });
    const reopened = new ObservedLimits(openDatabase(path));
    expect(reopened.get('p', 'm')).toMatchObject({ limitRequests: 100, limitTokens: 5000 });
  });

  it('flags drift only when a reported value matches none of the declared limits', () => {
    const observed = (r: number | null, t: number | null) => ({ provider: 'p', model: 'm', limitRequests: r, limitTokens: t, observedAt: 0 });
    expect(detectDrift(undefined, { rpm: 30 })).toEqual([]);
    expect(detectDrift(observed(30, null), { rpm: 30, rpd: 1000 })).toEqual([]); // matches rpm
    expect(detectDrift(observed(1000, 12000), { rpm: 30, rpd: 1000, tpm: 12000 })).toEqual([]);
    const d = detectDrift(observed(500, 9000), { rpm: 30, rpd: 1000, tpm: 12000 });
    expect(d).toHaveLength(2);
    expect(d[0]).toMatch(/request limit 500.*rpm=30, rpd=1000/);
    expect(d[1]).toMatch(/token limit 9000/);
    expect(detectDrift(observed(100, null), {})[0]).toMatch(/registry declares no limits/);
  });
});

describe('gateway use of provider rate-limit headers', () => {
  const registry: ProviderEntry[] = [
    {
      provider: 'p',
      base_url: 'https://p.test/v1',
      api_key_env: 'P_API_KEYS',
      auth: 'bearer',
      models: [{ id: 'm1', capabilities: ['chat'], limits: { rpm: 30, rpd: 1000 }, quirks: [] }],
    },
  ];

  function setup(upstream: (n: number) => Response) {
    const db = openDatabase(':memory:');
    const observed = new ObservedLimits(db);
    const clock = { now: 1_000_000 };
    const pool = new KeyPool(['k1', 'k2'], { now: () => clock.now });
    const used: string[] = [];
    let n = 0;
    const app = createApp({
      registry,
      store: new TokenStore(db),
      envTokens: ['pg'],
      pools: new Map([['p', pool]]),
      observedLimits: observed,
      adminPassword: 'pw',
      fetch: (async (_u: string, init: RequestInit) => {
        used.push((init.headers as Record<string, string>).authorization!);
        return upstream(n++);
      }) as unknown as typeof fetch,
    });
    const chat = async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer pg', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
      });
      await res.text();
      return res;
    };
    return { app, chat, used, pool, observed, clock };
  }

  it('rests a key whose window was just used up, without waiting for a 429', async () => {
    const { chat, used } = setup(() =>
      Response.json({ ok: true }, { headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '30s' } }),
    );
    await chat(); // key 1 succeeds but reports an empty window
    await chat(); // so the next request goes to key 2
    await chat(); // and key 2 reports empty too: nothing left, no upstream call
    expect(used).toEqual(['Bearer k1', 'Bearer k2']);
  });

  it('does not rest keys that still have budget', async () => {
    const { chat, used } = setup(() => Response.json({}, { headers: { 'x-ratelimit-remaining-requests': '5', 'x-ratelimit-reset-requests': '30s' } }));
    await chat();
    await chat();
    await chat();
    expect(used.length).toBe(3);
  });

  it('never shortens a longer cooldown and learns from 429 responses too', async () => {
    const { chat, pool, clock } = setup(
      () => new Response('{}', { status: 429, headers: { 'retry-after': '3600', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2s' } }),
    );
    await chat();
    expect(pool.coolingCount()).toBe(2);
    clock.now += 10_000; // past the 2 s reset, far from the 3600 s retry-after
    expect(pool.coolingCount()).toBe(2);
    clock.now += 3_600_000;
    expect(pool.coolingCount()).toBe(0);
  });

  it('exposes observed limits and drift to admins', async () => {
    const { app, chat } = setup(() => Response.json({}, { headers: { 'x-ratelimit-limit-requests': '14400', 'x-ratelimit-limit-tokens': '6000' } }));
    await chat();
    const login = await app.request('/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const [p] = (await (await app.request('/admin/api/providers', { headers: { cookie } })).json()) as { models: { observed: { limitRequests: number; drift: string[] } | null }[] }[];
    const model = p!.models[0]!;
    expect(model.observed).toMatchObject({ limitRequests: 14400 });
    expect(model.observed!.drift.join()).toMatch(/request limit 14400/); // registry says rpm 30 / rpd 1000
    expect(model.observed!.drift.join()).toMatch(/token limit 6000/);
  });
});
