import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { BackupError, collectBackup, decryptBackup, encryptBackup, restoreBackup } from '../src/backup.js';
import { CustomProviders } from '../src/customproviders.js';
import { openDatabase } from '../src/db.js';
import { HealthMonitor, type HealthEvent } from '../src/health.js';
import { KeyStore } from '../src/keys.js';
import { KeyPool, KEYLESS } from '../src/keypool.js';
import { PoolManager } from '../src/pools.js';
import { Profiles } from '../src/profiles.js';
import { TokenStore } from '../src/tokens.js';
import { UpdateChecker, compareVersions } from '../src/update.js';

const entry = (provider: string, over: Partial<ProviderEntry> = {}): ProviderEntry => ({
  provider,
  base_url: `https://${provider}.test/v1`,
  api_key_env: `${provider.toUpperCase()}_API_KEYS`,
  auth: 'bearer',
  models: [{ id: `${provider}-m`, capabilities: ['chat'], limits: {}, quirks: [] }],
  ...over,
});

describe('compareVersions', () => {
  it('orders releases and pre-releases', () => {
    expect(compareVersions('0.6.1', '0.6.0')).toBeGreaterThan(0);
    expect(compareVersions('0.6.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('dev', '1.0.0')).toBeNull();
  });
});

describe('UpdateChecker', () => {
  const release = (tag: string) => vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ tag_name: tag, html_url: `https://github.com/x/y/releases/tag/${tag}` }) }));

  it('reports a newer release and caches the answer', async () => {
    const f = release('v0.7.0');
    const u = new UpdateChecker({ current: '0.6.1', fetch: f, now: () => 1000 });
    expect(await u.status()).toMatchObject({ enabled: true, newer: true, latest: '0.7.0', url: 'https://github.com/x/y/releases/tag/v0.7.0' });
    await u.status();
    expect(f).toHaveBeenCalledTimes(1);
    await u.status(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('is not newer when current, and never checks a dev build or when disabled', async () => {
    expect((await new UpdateChecker({ current: '0.7.0', fetch: release('v0.7.0') }).status()).newer).toBe(false);
    const f = release('v9.9.9');
    expect(await new UpdateChecker({ current: 'dev', fetch: f }).status()).toMatchObject({ enabled: false, newer: false });
    expect((await new UpdateChecker({ current: '0.6.0', enabled: false, fetch: f }).status()).enabled).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('keeps the last good answer when GitHub fails, and does not retry on every call', async () => {
    let t = 0;
    const f = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ tag_name: 'v0.8.0', html_url: 'https://github.com/x/y' }) }).mockResolvedValue({ ok: false, status: 403, text: async () => '' });
    const u = new UpdateChecker({ current: '0.6.0', fetch: f, ttlMs: 10, now: () => t });
    expect((await u.status()).latest).toBe('0.8.0');
    t = 50;
    const after = await u.status();
    expect(after).toMatchObject({ latest: '0.8.0', newer: true, error: 'GitHub answered HTTP 403' });
    await u.status();
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('HealthMonitor', () => {
  const ok = { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'pong' } }] }) };
  const bad = { ok: false, status: 401, text: async () => 'nope' };

  it('probes providers with a key, reports no-key otherwise, and alerts only on ok <-> not ok', async () => {
    let answer: typeof ok | typeof bad = ok;
    const events: HealthEvent[] = [];
    const pools = new Map<string, KeyPool>([
      ['a', new KeyPool(['key-a-1234'])],
      ['free', new KeyPool([KEYLESS])],
    ]);
    const seen: Record<string, string | undefined> = {};
    const m = new HealthMonitor({
      registry: () => [entry('a'), entry('free', { keyless: true }), entry('nokey')],
      pools: () => pools,
      onChange: (e) => events.push(e),
      fetch: (async (url: string, init: { headers: Record<string, string> }) => {
        seen[new URL(url).hostname] = init.headers.authorization;
        return answer;
      }) as never,
      now: () => 5,
    });
    const first = await m.check();
    expect(first.map((r) => [r.provider, r.status])).toEqual([['a', 'ok'], ['free', 'ok'], ['nokey', 'no-key']]);
    expect(seen['a.test']).toBe('Bearer key-a-1234');
    expect(seen['free.test']).toBeUndefined(); // keyless: no Authorization header
    expect(events).toEqual([]);

    answer = bad;
    await m.check();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.provider).sort()).toEqual(['a', 'free']);
    expect(events.find((e) => e.provider === 'a')).toMatchObject({ from: 'ok', to: 'bad-key' });
    await m.check(); // still failing: no repeat alert
    expect(events).toHaveLength(2);

    answer = ok;
    await m.check();
    expect(events.slice(2).map((e) => [e.provider, e.from, e.to]).sort()).toEqual([['a', 'bad-key', 'ok'], ['free', 'bad-key', 'ok']]);
  });

  it('does not call a provider down because its first key is dead while another key works', async () => {
    const f = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => (init.headers.authorization === 'Bearer dead-key-12' ? bad : ok));
    const m = new HealthMonitor({ registry: () => [entry('a')], pools: () => new Map([['a', new KeyPool(['dead-key-12', 'good-key-12'])]]), fetch: f as never });
    expect((await m.check())[0]).toMatchObject({ provider: 'a', status: 'ok' });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('shares one run between concurrent calls', async () => {
    const f = vi.fn(async () => ok);
    const m = new HealthMonitor({ registry: () => [entry('a')], pools: () => new Map([['a', new KeyPool(['key-a-1234'])]]), fetch: f as never });
    await Promise.all([m.check(), m.check()]);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('backup', () => {
  const setup = () => {
    const db = openDatabase(':memory:');
    const keyStore = new KeyStore(db, randomBytes(32));
    const tokens = new TokenStore(db);
    const custom = new CustomProviders(db);
    const profiles = new Profiles();
    return { db, keyStore, tokens, custom, profiles };
  };

  it('round-trips keys, token hashes, custom endpoints and profiles into another install, and the token still works', () => {
    const a = setup();
    a.keyStore.add('groq', 'gsk_abcdefghijklmnop', 'main', 3);
    const off = a.keyStore.add('groq', 'gsk_second_key_1234');
    a.keyStore.update(off.id, { enabled: false });
    const { token } = a.tokens.create({ name: 'laptop', rpmLimit: 10 });
    a.custom.add({ name: 'local', baseUrl: 'http://127.0.0.1:11434/v1', models: ['llama3'] }, new Set());
    a.profiles.set('coding', [{ model: 'm1' }, { provider: 'groq', model: 'm2' }]);

    const env = encryptBackup(collectBackup(a), 'correct horse');
    expect(JSON.stringify(env)).not.toContain('gsk_');
    expect(JSON.stringify(env)).not.toContain(token);

    const b = setup();
    const result = restoreBackup(decryptBackup(JSON.parse(JSON.stringify(env)), 'correct horse'), b);
    expect(result).toEqual({ keys: { added: 2, skipped: 0 }, tokens: { added: 1, skipped: 0 }, customProviders: { added: 1, skipped: 0 }, profiles: { added: 1, skipped: 0 } });
    expect(b.keyStore.secrets('groq')).toEqual(['gsk_abcdefghijklmnop', 'gsk_second_key_1234']);
    expect(b.keyStore.list('groq').map((k) => [k.label, k.weight, k.enabled])).toEqual([['main', 3, true], ['', 1, false]]);
    expect(b.tokens.verify(token)).toMatchObject({ name: 'laptop', rpmLimit: 10 });
    expect(b.custom.list()[0]).toMatchObject({ name: 'local', models: ['llama3'] });
    expect(b.profiles.chain('coding')).toEqual([{ model: 'm1' }, { provider: 'groq', model: 'm2' }]);
  });

  it('merges: a second restore adds nothing and nothing is deleted', () => {
    const a = setup();
    a.keyStore.add('groq', 'gsk_abcdefghijklmnop');
    a.tokens.create({ name: 't' });
    const payload = decryptBackup(encryptBackup(collectBackup(a), 'passphrase1'), 'passphrase1');
    const again = restoreBackup(payload, a);
    expect(again.keys.added + again.tokens.added).toBe(0);
    expect(a.keyStore.list()).toHaveLength(1);
  });

  it('rejects a wrong passphrase, a short one, tampering, non-backups and hostile work factors', () => {
    const a = setup();
    const env = encryptBackup(collectBackup(a), 'right-pass-1');
    expect(() => decryptBackup(env, 'wrong-pass-1')).toThrow(BackupError);
    expect(() => encryptBackup(collectBackup(a), 'short')).toThrow(/at least/);
    expect(() => decryptBackup({ ...env, data: Buffer.from('x').toString('base64') }, 'right-pass-1')).toThrow(/damaged/);
    expect(() => decryptBackup({ hello: 1 }, 'right-pass-1')).toThrow(/not a PourGateLLM backup/);
    expect(() => decryptBackup({ ...env, kdf: { ...env.kdf, N: 2 ** 30 } }, 'right-pass-1')).toThrow(/unsupported/);
  });
});

describe('admin endpoints', () => {
  const json = { 'content-type': 'application/json' };
  function setup(extra: Record<string, unknown> = {}) {
    const db = openDatabase(':memory:');
    const keyStore = new KeyStore(db, randomBytes(32));
    const store = new TokenStore(db);
    const poolManager = new PoolManager(keyStore, {}, () => {});
    const registry = [entry('groq')];
    poolManager.sync(registry);
    const profiles = new Profiles();
    const onProfilesChange = vi.fn();
    const app = createApp({ registry, store, pools: poolManager.pools, keyStore, poolManager, customProviders: new CustomProviders(db), profiles, onProfilesChange, onCustomChange: () => {}, adminPassword: 'pw-pw-pw-pw', envTokens: ['pg-test'], ...extra });
    return { app, keyStore, store, poolManager, profiles, onProfilesChange };
  }
  const login = async (app: ReturnType<typeof setup>['app']) => {
    const res = await app.request('/admin/api/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'pw-pw-pw-pw' }) });
    return res.headers.get('set-cookie')!.split(';')[0]!;
  };

  it('requires a session for update, health, backup and restore', async () => {
    const { app } = setup();
    for (const [method, path] of [['GET', '/update'], ['GET', '/health'], ['POST', '/health/run'], ['POST', '/backup'], ['POST', '/restore']] as const) {
      expect((await app.request(`/admin/api/${path}`, { method, headers: json, body: method === 'POST' ? '{}' : undefined })).status, path).toBe(401);
    }
  });

  it('reports the update status and a dev build as disabled', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ tag_name: 'v2.0.0', html_url: 'https://github.com/x/y' }) }));
    const { app } = setup({ update: new UpdateChecker({ current: '1.0.0', fetch: f as never }) });
    const c = await login(app);
    expect(await (await app.request('/admin/api/update', { headers: { cookie: c } })).json()).toMatchObject({ enabled: true, newer: true, latest: '2.0.0' });
    const dev = setup();
    expect(await (await dev.app.request('/admin/api/update', { headers: { cookie: await login(dev.app) } })).json()).toMatchObject({ enabled: false, newer: false });
  });

  it('runs a provider status check on demand', async () => {
    const health = new HealthMonitor({ registry: () => [entry('groq')], pools: () => new Map([['groq', new KeyPool(['key-1234567'])]]), fetch: (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'pong' } }] }) })) as never });
    const { app } = setup({ health });
    const c = await login(app);
    expect(await (await app.request('/admin/api/health', { headers: { cookie: c } })).json()).toMatchObject({ enabled: true, results: [] });
    const run = (await (await app.request('/admin/api/health/run', { method: 'POST', headers: { ...json, cookie: c }, body: '{}' })).json()) as { results: { provider: string; status: string }[] };
    expect(run.results).toMatchObject([{ provider: 'groq', status: 'ok' }]);
    expect((await app.request('/admin/api/health/run', { method: 'POST', headers: { ...json, cookie: c }, body: JSON.stringify({ provider: 'nope' }) })).status).toBe(404);
  });

  it('downloads an encrypted backup and restores it into a fresh install, applying it live', async () => {
    const a = setup();
    const ca = await login(a.app);
    a.keyStore.add('groq', 'gsk_abcdefghijklmnop');
    a.profiles.set('p', [{ model: 'groq-m' }]);
    const bad = await a.app.request('/admin/api/backup', { method: 'POST', headers: { ...json, cookie: ca }, body: JSON.stringify({ passphrase: 'x' }) });
    expect(bad.status).toBe(400);
    const res = await a.app.request('/admin/api/backup', { method: 'POST', headers: { ...json, cookie: ca }, body: JSON.stringify({ passphrase: 'long enough passphrase' }) });
    expect(res.headers.get('content-disposition')).toContain('pourgate-backup.json');
    const text = await res.text();
    expect(text).not.toContain('gsk_');

    const b = setup();
    const cb = await login(b.app);
    expect(b.poolManager.pools.has('groq')).toBe(false);
    const wrong = await b.app.request('/admin/api/restore', { method: 'POST', headers: { ...json, cookie: cb }, body: JSON.stringify({ passphrase: 'not the passphrase', backup: JSON.parse(text) }) });
    expect(wrong.status).toBe(400);
    const ok = await b.app.request('/admin/api/restore', { method: 'POST', headers: { ...json, cookie: cb }, body: JSON.stringify({ passphrase: 'long enough passphrase', backup: JSON.parse(text) }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ keys: { added: 1 }, profiles: { added: 1 } });
    expect(b.poolManager.pools.has('groq')).toBe(true); // the restored key serves traffic immediately
    expect(b.profiles.chain('p')).toBeDefined();
    expect(b.onProfilesChange).toHaveBeenCalled();
  });
});
