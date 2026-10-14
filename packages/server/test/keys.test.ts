import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyStore, KeyStoreError } from '../src/keys.js';
import { PoolManager } from '../src/pools.js';
import { decryptSecret, encryptSecret, loadMasterKey, parseMasterKey } from '../src/secrets.js';
import { TokenStore } from '../src/tokens.js';

const registry: ProviderEntry[] = [
  {
    provider: 'groq',
    base_url: 'https://upstream.test/v1',
    api_key_env: 'GROQ_API_KEYS',
    auth: 'bearer',
    models: [{ id: 'm1', capabilities: ['chat'], limits: {}, quirks: [] }],
  },
];
const KEY = 'gsk_abcdefghijklmnop';

describe('secrets', () => {
  const key = randomBytes(32);

  it('round-trips and binds to the context', () => {
    const blob = encryptSecret(KEY, key, 'groq');
    expect(blob).not.toContain(KEY);
    expect(decryptSecret(blob, key, 'groq')).toBe(KEY);
    expect(() => decryptSecret(blob, key, 'other')).toThrow();
    expect(() => decryptSecret(blob, randomBytes(32), 'groq')).toThrow();
    const raw = Buffer.from(blob, 'base64');
    raw[raw.length - 1]! ^= 1;
    expect(() => decryptSecret(raw.toString('base64'), key, 'groq')).toThrow();
  });

  it('uses a fresh IV each time', () => {
    expect(encryptSecret(KEY, key, 'groq')).not.toBe(encryptSecret(KEY, key, 'groq'));
  });

  it('parses hex/base64 master keys and rejects bad lengths', () => {
    expect(parseMasterKey(key.toString('hex'))).toEqual(key);
    expect(parseMasterKey(key.toString('base64'))).toEqual(key);
    expect(() => parseMasterKey('short')).toThrow();
  });

  it('creates a 0600 key file once and reuses it', () => {
    const keyfile = join(mkdtempSync(join(tmpdir(), 'pg-mk-')), 'sub', 'master.key');
    const a = loadMasterKey({ keyfile });
    expect(statSync(keyfile).mode & 0o777).toBe(0o600);
    expect(loadMasterKey({ keyfile })).toEqual(a);
    expect(loadMasterKey({ keyfile, env: key.toString('hex') })).toEqual(key);
  });
});

describe('KeyStore', () => {
  const make = () => {
    const db = openDatabase(':memory:');
    return { db, ks: new KeyStore(db, randomBytes(32)) };
  };

  it('never stores plaintext and never lists secrets', () => {
    const { db, ks } = make();
    const rec = ks.add('groq', KEY, 'main');
    expect(rec).toMatchObject({ provider: 'groq', label: 'main', last4: KEY.slice(-4) });
    const raw = JSON.stringify(db.prepare('SELECT * FROM provider_keys').all());
    expect(raw).not.toContain(KEY);
    expect(JSON.stringify(ks.list())).not.toContain(KEY);
    expect(ks.secrets('groq')).toEqual([KEY]);
  });

  it('validates, de-duplicates, and removes', () => {
    const { ks } = make();
    expect(() => ks.add('groq', 'short')).toThrow(KeyStoreError);
    expect(() => ks.add('groq', 'has space in key')).toThrow(KeyStoreError);
    expect(() => ks.add('groq', 'a,b,c,d,e,f,g,h')).toThrow(KeyStoreError);
    const rec = ks.add('groq', KEY);
    expect(() => ks.add('groq', KEY)).toThrow(/already/);
    expect(ks.remove(rec.id)).toBe(true);
    expect(ks.remove(rec.id)).toBe(false);
    expect(ks.secrets('groq')).toEqual([]);
  });

  it('skips rows that cannot be decrypted (wrong master key)', () => {
    const { db, ks } = make();
    ks.add('groq', KEY);
    const other = new KeyStore(db, randomBytes(32));
    const failed: number[] = [];
    expect(other.secrets('groq', (id) => failed.push(id))).toEqual([]);
    expect(failed).toHaveLength(1);
  });
});

describe('PoolManager', () => {
  it('merges env and stored keys, de-duplicates, and refreshes live', () => {
    const db = openDatabase(':memory:');
    const ks = new KeyStore(db, randomBytes(32));
    const pm = new PoolManager(ks, { GROQ_API_KEYS: 'env-key-1, env-key-2' }, () => {});
    pm.sync(registry);
    expect(pm.pools.get('groq')!.keys).toEqual(['env-key-1', 'env-key-2']);
    ks.add('groq', KEY);
    ks.add('groq', 'env-key-1-extra');
    pm.refresh();
    expect(pm.pools.get('groq')!.keys).toEqual(['env-key-1', 'env-key-2', KEY, 'env-key-1-extra']);
  });

  it('keeps cooldown state for surviving keys and disables providers with no keys', () => {
    const ks = new KeyStore(openDatabase(':memory:'), randomBytes(32));
    const pm = new PoolManager(ks, {}, () => {});
    pm.sync(registry);
    expect(pm.pools.has('groq')).toBe(false);
    const rec = ks.add('groq', KEY);
    ks.add('groq', 'second-key-1234');
    pm.refresh();
    const pool = pm.pools.get('groq')!;
    pool.cooldown(KEY, 60_000);
    ks.add('groq', 'third-key-12345');
    pm.refresh();
    expect(pool.coolingCount()).toBe(1);
    ks.remove(rec.id);
    pm.refresh();
    expect(pool.coolingCount()).toBe(0);
  });
});

describe('admin key management', () => {
  const json = { 'content-type': 'application/json' };

  function setup(fetchImpl?: typeof fetch) {
    const db = openDatabase(':memory:');
    const keyStore = new KeyStore(db, randomBytes(32));
    const poolManager = new PoolManager(keyStore, {}, () => {});
    poolManager.sync(registry);
    const app = createApp({
      registry,
      store: new TokenStore(db),
      pools: poolManager.pools,
      keyStore,
      poolManager,
      adminPassword: 'pw',
      envTokens: ['pg-test'],
      fetch: fetchImpl,
    });
    return { app, poolManager };
  }

  async function cookie(app: ReturnType<typeof setup>['app']) {
    const res = await app.request('/admin/api/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'pw' }) });
    return res.headers.get('set-cookie')!.split(';')[0]!;
  }

  it('requires a session', async () => {
    const { app } = setup();
    expect((await app.request('/admin/api/providers/groq/keys')).status).toBe(401);
    expect((await app.request('/admin/api/providers/groq/keys', { method: 'POST', headers: json, body: '{}' })).status).toBe(401);
  });

  it('adds a key that immediately serves traffic, never echoes it, and can be removed', async () => {
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    const { app } = setup(upstream as unknown as typeof fetch);
    const c = await cookie(app);

    const add = await app.request('/admin/api/providers/groq/keys', {
      method: 'POST',
      headers: { ...json, cookie: c },
      body: JSON.stringify({ key: KEY, label: 'main' }),
    });
    expect(add.status).toBe(201);
    const rec = (await add.json()) as { id: number };
    expect(JSON.stringify(rec)).not.toContain(KEY);

    const list = await (await app.request('/admin/api/providers/groq/keys', { headers: { cookie: c } })).text();
    expect(list).not.toContain(KEY);
    expect(JSON.parse(list)).toMatchObject({ env: 0, keys: [{ label: 'main', last4: KEY.slice(-4) }] });

    // the gateway now routes with the stored key
    const chat = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { ...json, authorization: 'Bearer pg-test' },
      body: JSON.stringify({ model: 'm1', messages: [] }),
    });
    expect(chat.status).toBe(200);
    const [, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);

    const del = await app.request(`/admin/api/provider-keys/${rec.id}`, { method: 'DELETE', headers: { cookie: c } });
    expect(del.status).toBe(204);
    const after = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { ...json, authorization: 'Bearer pg-test' },
      body: JSON.stringify({ model: 'm1', messages: [] }),
    });
    expect(after.status).toBe(503);
  });

  it('rejects unknown providers and invalid keys', async () => {
    const { app } = setup();
    const c = await cookie(app);
    const post = (name: string, key: unknown) =>
      app.request(`/admin/api/providers/${name}/keys`, { method: 'POST', headers: { ...json, cookie: c }, body: JSON.stringify({ key }) });
    expect((await post('nope', KEY)).status).toBe(404);
    expect((await post('groq', 'x')).status).toBe(400);
    expect((await post('groq', 123)).status).toBe(400);
  });

  it('tests a key against {base_url}/models and reports only the status', async () => {
    const upstream = vi.fn(async () => new Response('{"secret":"leak"}', { status: 401 }));
    const { app } = setup(upstream as unknown as typeof fetch);
    const c = await cookie(app);
    const rec = (await (
      await app.request('/admin/api/providers/groq/keys', { method: 'POST', headers: { ...json, cookie: c }, body: JSON.stringify({ key: KEY }) })
    ).json()) as { id: number };
    const res = await app.request(`/admin/api/provider-keys/${rec.id}/test`, { method: 'POST', headers: { cookie: c } });
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, status: 401 });
    expect(text).not.toContain('leak');
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://upstream.test/v1/models');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });
});
