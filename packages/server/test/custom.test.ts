import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { AuditLog } from '../src/audit.js';
import { CustomProviderError, CustomProviders, detectModels, normalizeBaseUrl } from '../src/customproviders.js';
import { openDatabase } from '../src/db.js';
import { KeyStore } from '../src/keys.js';
import { PoolManager } from '../src/pools.js';
import { RegistryManager } from '../src/registry-sync.js';
import { TokenStore } from '../src/tokens.js';

const builtin: ProviderEntry[] = [{ provider: 'groq', base_url: 'https://upstream.test/v1', api_key_env: 'GROQ_API_KEYS', auth: 'bearer', models: [{ id: 'm1', capabilities: ['chat'], limits: {}, quirks: [] }] }];
const json = { 'content-type': 'application/json' };

describe('custom provider storage', () => {
  const store = () => new CustomProviders(openDatabase(':memory:'));

  it('normalises URLs and refuses credentials, queries and odd schemes', () => {
    expect(normalizeBaseUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1');
    expect(normalizeBaseUrl(' https://x.test ')).toBe('https://x.test');
    for (const bad of ['ftp://x', 'nonsense', 'https://u:p@x.test/v1', 'https://x.test/v1?key=1']) expect(() => normalizeBaseUrl(bad)).toThrow(CustomProviderError);
  });

  it('validates input and produces schema-valid registry entries', () => {
    const cp = store();
    const rec = cp.add({ name: 'My-Ollama', baseUrl: 'http://localhost:11434/v1', models: ['llama3.2', ' llama3.2 ', 'qwen2.5:7b'], signupUrl: 'https://ollama.com' }, new Set(['groq']));
    expect(rec).toMatchObject({ name: 'my-ollama', models: ['llama3.2', 'qwen2.5:7b'], tools: true });
    const [entry] = cp.entries();
    expect(entry).toMatchObject({ provider: 'my-ollama', api_key_env: 'MY_OLLAMA_API_KEYS', signup_url: 'https://ollama.com/' });
    expect(entry!.models.map((m) => m.id)).toEqual(['llama3.2', 'qwen2.5:7b']);
    expect(() => cp.add({ name: 'groq', baseUrl: 'https://x.test', models: ['a'] }, new Set(['groq']))).toThrow(/already exists/);
    expect(() => cp.add({ name: 'my-ollama', baseUrl: 'https://x.test', models: ['a'] }, new Set())).toThrow(/already exists/);
    expect(() => cp.add({ name: 'Bad Name', baseUrl: 'https://x.test', models: ['a'] }, new Set())).toThrow(/name must be/);
    expect(() => cp.add({ name: 'ok', baseUrl: 'https://x.test', models: [] }, new Set())).toThrow(/at least one model/);
    expect(() => cp.add({ name: 'ok', baseUrl: 'https://x.test', models: ['bad id!'] }, new Set())).toThrow(/invalid model id/);
    expect(() => cp.add({ name: 'ok', baseUrl: 'https://x.test', models: ['a'], signupUrl: 'http://insecure.test' }, new Set())).toThrow(/https/);
    expect(cp.remove('my-ollama')).toBe(true);
    expect(cp.remove('my-ollama')).toBe(false);
  });

  it('detects models from /models in OpenAI and Ollama shapes, with the key when given', async () => {
    let auth: string | undefined;
    const make = (body: unknown, ok = true, status = 200) => async (_u: string, init: { headers: Record<string, string> }) => {
      auth = init.headers.authorization;
      return { ok, status, text: async () => JSON.stringify(body) };
    };
    expect(await detectModels('http://h/v1', 'k-123456789', make({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }))).toEqual(['a', 'b']);
    expect(auth).toBe('Bearer k-123456789');
    expect(await detectModels('http://h/v1', undefined, make({ models: [{ name: 'llama3:8b' }] }))).toEqual(['llama3:8b']);
    expect(auth).toBeUndefined();
    await expect(detectModels('http://h/v1', undefined, make({}, false, 401))).rejects.toThrow(/HTTP 401/);
    await expect(detectModels('http://h/v1', undefined, make({ data: [] }))).rejects.toThrow(/no models/);
    await expect(detectModels('http://h/v1', undefined, async () => { throw new Error('refused'); })).rejects.toThrow(/could not reach/);
  });
});

describe('admin: custom providers and bulk keys', () => {
  function setup() {
    const db = openDatabase(':memory:');
    const custom = new CustomProviders(db);
    const keyStore = new KeyStore(db, randomBytes(32));
    const poolManager = new PoolManager(keyStore, {}, () => {});
    const manager = new RegistryManager({ base: builtin, overrides: custom.entries(), onChange: (e) => poolManager.sync(e) });
    poolManager.sync(manager.entries);
    const fetcher = (async (url: string) => (String(url).endsWith('/models') ? Response.json({ data: [{ id: 'llama3.2' }] }) : Response.json({ choices: [{ message: { role: 'assistant', content: 'hi from local' }, finish_reason: 'stop' }] }))) as typeof fetch;
    const app = createApp({
      registry: () => manager.entries,
      store: new TokenStore(db),
      envTokens: ['pg'],
      pools: poolManager.pools,
      keyStore,
      poolManager,
      customProviders: custom,
      onCustomChange: () => manager.setOverrides(custom.entries()),
      reservedNames: () => new Set(builtin.map((p) => p.provider)),
      adminPassword: 'hunter2-long-enough',
      audit: new AuditLog(db),
      fetch: fetcher,
    });
    return { app, keyStore, poolManager };
  }
  const login = async (app: ReturnType<typeof setup>['app']) =>
    (await app.request('/admin/api/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'hunter2-long-enough' }) })).headers.get('set-cookie')!.split(';')[0]!;
  const call = (app: ReturnType<typeof setup>['app'], cookie: string, path: string, method: string, body?: unknown) =>
    app.request(`/admin/api${path}`, { method, headers: { ...json, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('adds an endpoint, detects its models, takes a key and serves traffic; removing it cleans up', async () => {
    const { app, keyStore } = setup();
    const cookie = await login(app);
    expect((await call(app, cookie, '/custom-providers', 'POST', { name: 'groq', baseUrl: 'http://localhost:11434/v1' })).status).toBe(400);
    const added = await call(app, cookie, '/custom-providers', 'POST', { name: 'local', baseUrl: 'http://localhost:11434/v1' });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ name: 'local', models: ['llama3.2'], detected: true, envName: 'LOCAL_API_KEYS' });

    const providers = (await (await call(app, cookie, '/providers', 'GET')).json()) as { provider: string; enabled: boolean }[];
    expect(providers.find((p) => p.provider === 'local')).toMatchObject({ enabled: false }); // no key yet
    expect((await call(app, cookie, '/providers/local/keys', 'POST', { key: 'not-needed' })).status).toBe(201);

    const chat = await app.request('/v1/chat/completions', { method: 'POST', headers: { ...json, authorization: 'Bearer pg' }, body: JSON.stringify({ model: 'llama3.2', messages: [{ role: 'user', content: 'x' }] }) });
    expect(chat.status).toBe(200);
    expect(chat.headers.get('x-pourgate-provider')).toBe('local');

    expect((await call(app, cookie, '/custom-providers/local', 'DELETE')).status).toBe(204);
    expect(keyStore.list('local')).toEqual([]);
    expect(((await (await call(app, cookie, '/custom-providers', 'GET')).json()) as unknown[]).length).toBe(0);
    const gone = await app.request('/v1/chat/completions', { method: 'POST', headers: { ...json, authorization: 'Bearer pg' }, body: JSON.stringify({ model: 'llama3.2', messages: [{ role: 'user', content: 'x' }] }) });
    expect(gone.status).toBe(404);
  });

  it('requires an admin session', async () => {
    const { app } = setup();
    expect((await app.request('/admin/api/custom-providers')).status).toBe(401);
    expect((await app.request('/admin/api/providers/groq/keys/bulk', { method: 'POST', headers: json, body: '{}' })).status).toBe(401);
  });

  it('imports many keys at once, reporting duplicates and bad keys without leaking them', async () => {
    const { app, keyStore } = setup();
    const cookie = await login(app);
    const keys = ['gsk_aaaaaaaa1111', 'gsk_bbbbbbbb2222', 'gsk_aaaaaaaa1111', 'short', 'gsk_cccccccc3333'].join('\n');
    const res = await call(app, cookie, '/providers/groq/keys/bulk', 'POST', { keys, weight: 2 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { added: number; skipped: { key: string; reason: string }[] };
    expect(body.added).toBe(3);
    expect(body.skipped).toEqual([{ key: '…hort', reason: expect.stringMatching(/8-500 characters/) }]);
    expect(JSON.stringify(body)).not.toContain('gsk_aaaaaaaa');
    expect(keyStore.list('groq').map((k) => k.weight)).toEqual([2, 2, 2]);
    const again = await call(app, cookie, '/providers/groq/keys/bulk', 'POST', { keys: 'gsk_aaaaaaaa1111' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { added: number }).added).toBe(0);
    expect((await call(app, cookie, '/providers/groq/keys/bulk', 'POST', { keys: '   ' })).status).toBe(400);
    expect((await call(app, cookie, '/providers/nope/keys/bulk', 'POST', { keys: 'x'.repeat(10) })).status).toBe(404);
  });
});
