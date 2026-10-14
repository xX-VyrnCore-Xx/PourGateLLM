import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { TokenStore } from '../src/tokens.js';
import { SqliteUsage, makeFingerprint, pruneUsage } from '../src/usage.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);

describe('KeyPool limits', () => {
  const clock = (start = T0) => {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('enforces rpm per key and model, with a sliding window', () => {
    const c = clock();
    const pool = new KeyPool(['k1'], { now: c.now });
    expect(pool.acquire({ model: 'a', rpm: 2 })).toBe('k1');
    expect(pool.acquire({ model: 'a', rpm: 2 })).toBe('k1');
    expect(pool.acquire({ model: 'a', rpm: 2 })).toBeUndefined();
    expect(pool.acquire({ model: 'b', rpm: 2 })).toBe('k1'); // other model is independent
    c.advance(61_000);
    expect(pool.acquire({ model: 'a', rpm: 2 })).toBe('k1');
  });

  it('falls through to the next key when one is exhausted for rpd', () => {
    const pool = new KeyPool(['k1', 'k2']);
    const got = [1, 2, 3, 4].map(() => pool.acquire({ model: 'a', rpd: 2 }));
    expect(got.filter((k) => k === 'k1')).toHaveLength(2);
    expect(got.filter((k) => k === 'k2')).toHaveLength(2);
    expect(pool.acquire({ model: 'a', rpd: 2 })).toBeUndefined();
  });

  it('resets daily counters at UTC midnight', () => {
    const c = clock(Date.UTC(2026, 0, 10, 23, 59, 0));
    const pool = new KeyPool(['k1'], { now: c.now });
    expect(pool.acquire({ model: 'a', rpd: 1 })).toBe('k1');
    expect(pool.acquire({ model: 'a', rpd: 1 })).toBeUndefined();
    c.advance(2 * 60_000);
    expect(pool.acquire({ model: 'a', rpd: 1 })).toBe('k1');
  });

  it('enforces tpm and tpd from recorded tokens', () => {
    const c = clock();
    const pool = new KeyPool(['k1'], { now: c.now });
    pool.acquire({ model: 'a' });
    pool.recordTokens('k1', 'a', 900);
    expect(pool.acquire({ model: 'a', tpm: 1000 })).toBe('k1');
    pool.recordTokens('k1', 'a', 200);
    expect(pool.acquire({ model: 'a', tpm: 1000 })).toBeUndefined();
    c.advance(61_000);
    expect(pool.acquire({ model: 'a', tpm: 1000 })).toBe('k1');
    expect(pool.acquire({ model: 'a', tpd: 1000 })).toBeUndefined(); // 1100 tokens used today
    expect(pool.usageToday('a')).toEqual({ requests: 3, tokens: 1100 });
  });

  it('skips cooling keys', () => {
    const c = clock();
    const pool = new KeyPool(['k1', 'k2'], { now: c.now });
    pool.cooldown('k1', 5_000);
    expect(pool.acquire({ model: 'a' })).toBe('k2');
    expect(pool.acquire({ model: 'a' })).toBe('k2');
    c.advance(5_001);
    expect([pool.acquire({ model: 'a' }), pool.acquire({ model: 'a' })].sort()).toEqual(['k1', 'k2']);
  });
});

describe('persistence across restarts', () => {
  const fp = makeFingerprint(randomBytes(32));
  const open = () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pg-ku-')), 'x.db');
    return { path, db: openDatabase(path) };
  };
  const pool = (db: ReturnType<typeof openDatabase>, now: () => number, keys = ['secret-key-1', 'secret-key-2']) =>
    new KeyPool(keys, { now, backend: new SqliteUsage(db, 'groq', now), fingerprint: fp });

  it('keeps rpd counters and cooldowns after reopening the database', () => {
    const { path, db } = open();
    const now = () => T0;
    const first = pool(db, now, ['secret-key-1']);
    expect(first.acquire({ model: 'a', rpd: 1 })).toBe('secret-key-1');
    first.cooldown('secret-key-1', 60_000);
    first.recordTokens('secret-key-1', 'a', 50);

    const restarted = pool(openDatabase(path), now, ['secret-key-1']);
    expect(restarted.coolingCount()).toBe(1);
    expect(restarted.acquire({ model: 'a', rpd: 1 })).toBeUndefined();
    expect(restarted.usageToday('a')).toEqual({ requests: 1, tokens: 50 });

    // cooldown expires with time; daily counter does not until tomorrow
    const later = pool(openDatabase(path), () => T0 + 61_000, ['secret-key-1']);
    expect(later.coolingCount()).toBe(0);
    expect(later.acquire({ model: 'a', rpd: 1 })).toBeUndefined();
    const tomorrow = pool(openDatabase(path), () => T0 + DAY, ['secret-key-1']);
    expect(tomorrow.acquire({ model: 'a', rpd: 1 })).toBe('secret-key-1');
  });

  it('never writes raw keys to the database', () => {
    const { db } = open();
    const p = pool(db, () => T0);
    p.acquire({ model: 'a' });
    p.cooldown('secret-key-1', 1000);
    p.recordTokens('secret-key-1', 'a', 5);
    const dump = JSON.stringify([db.prepare('SELECT * FROM key_usage').all(), db.prepare('SELECT * FROM key_cooldowns').all()]);
    expect(dump).not.toContain('secret-key');
  });

  it('prunes old counters and expired cooldowns only', () => {
    const { db } = open();
    const u = new SqliteUsage(db, 'groq', () => T0);
    u.addRequest('fp1', 'a', '2026-01-01');
    u.addRequest('fp1', 'a', '2026-01-10');
    u.setCooldown('fp1', T0 - 1);
    u.setCooldown('fp2', T0 + 1000);
    pruneUsage(db, T0, 7);
    expect((db.prepare('SELECT day FROM key_usage').all() as { day: string }[]).map((r) => r.day)).toEqual(['2026-01-10']);
    expect((db.prepare('SELECT key_fp FROM key_cooldowns').all() as { key_fp: string }[]).map((r) => r.key_fp)).toEqual(['fp2']);
  });
});

describe('gateway uses provider-reported usage', () => {
  const registry: ProviderEntry[] = [
    {
      provider: 'groq',
      base_url: 'https://upstream.test/v1',
      api_key_env: 'GROQ_API_KEYS',
      auth: 'bearer',
      models: [{ id: 'm1', capabilities: ['chat'], limits: { tpd: 100, rpd: 5 }, quirks: [] }],
    },
  ];

  it('stops routing to a key once its daily token budget is spent', async () => {
    const pool = new KeyPool(['k1']);
    const app = createApp({
      registry,
      store: new TokenStore(openDatabase(':memory:')),
      envTokens: ['pg'],
      pools: new Map([['groq', pool]]),
      fetch: (async () => Response.json({ usage: { total_tokens: 150 } })) as unknown as typeof fetch,
    });
    const call = () =>
      app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer pg', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm1', messages: [] }),
      });
    expect((await call()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect((await call()).status).toBe(503);
  });
});
