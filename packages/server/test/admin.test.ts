import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { TokenStore } from '../src/tokens.js';

const registry: ProviderEntry[] = [
  {
    provider: 'groq',
    base_url: 'https://upstream.test/v1',
    api_key_env: 'GROQ_API_KEYS',
    auth: 'bearer',
    models: [{ id: 'm1', capabilities: ['chat'], limits: { rpm: 5 }, quirks: [] }],
  },
];

function setup(adminPassword: string | null = 'hunter2') {
  const store = new TokenStore(openDatabase(':memory:'));
  const app = createApp({
    registry,
    store,
    pools: new Map([['groq', new KeyPool(['secret-key-1', 'secret-key-2'])]]),
    adminPassword: adminPassword ?? undefined,
  });
  return { app, store };
}

const json = { 'content-type': 'application/json' };

async function login(app: ReturnType<typeof setup>['app'], password = 'hunter2') {
  return app.request('/admin/api/login', { method: 'POST', headers: json, body: JSON.stringify({ password }) });
}

async function cookieFor(app: ReturnType<typeof setup>['app']) {
  const res = await login(app);
  expect(res.status).toBe(204);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

describe('admin api', () => {
  it('is not mounted without a password', async () => {
    const { app } = setup(null);
    expect((await login(app)).status).toBe(404);
  });

  it('rejects wrong passwords and unauthenticated access', async () => {
    const { app } = setup();
    expect((await login(app, 'nope')).status).toBe(401);
    expect((await app.request('/admin/api/tokens')).status).toBe(401);
  });

  it('sets a hardened session cookie on login', async () => {
    const { app } = setup();
    const res = await login(app);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/admin\/api/);
  });

  it('rate-limits login attempts', async () => {
    const { app } = setup();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await login(app, 'bad')).status;
    expect(last).toBe(429);
  });

  it('creates, lists and revokes tokens', async () => {
    const { app } = setup();
    const cookie = await cookieFor(app);
    const create = await app.request('/admin/api/tokens', {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ name: 'laptop', rpm: 10, daily: 100 }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { token: string; record: { id: number } };
    expect(created.token).toMatch(/^pg-/);

    const list = (await (await app.request('/admin/api/tokens', { headers: { cookie } })).json()) as {
      id: number;
      name: string;
    }[];
    expect(list.map((t) => t.name)).toEqual(['laptop']);
    // the plaintext token is never returned again
    expect(JSON.stringify(list)).not.toContain(created.token);

    const del = await app.request(`/admin/api/tokens/${created.record.id}`, { method: 'DELETE', headers: { cookie } });
    expect(del.status).toBe(204);
    const models = await app.request('/v1/models', { headers: { authorization: `Bearer ${created.token}` } });
    expect(models.status).toBe(401);
  });

  it('validates token input', async () => {
    const { app } = setup();
    const cookie = await cookieFor(app);
    const bad = await app.request('/admin/api/tokens', {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ name: 'x', rpm: -1 }),
    });
    expect(bad.status).toBe(400);
  });

  it('rejects cross-origin state-changing requests', async () => {
    const { app } = setup();
    const res = await app.request('/admin/api/login', {
      method: 'POST',
      headers: { ...json, origin: 'https://evil.example', host: 'gateway.local' },
      body: JSON.stringify({ password: 'hunter2' }),
    });
    expect(res.status).toBe(403);
  });

  it('exposes provider status without leaking keys', async () => {
    const { app } = setup();
    const cookie = await cookieFor(app);
    const res = await app.request('/admin/api/providers', { headers: { cookie } });
    const text = await res.text();
    expect(text).not.toContain('secret-key');
    const [p] = JSON.parse(text) as { provider: string; keys: number; enabled: boolean }[];
    expect(p).toMatchObject({ provider: 'groq', keys: 2, enabled: true });
  });

  it('invalidates the session on logout', async () => {
    const { app } = setup();
    const cookie = await cookieFor(app);
    await app.request('/admin/api/logout', { method: 'POST', headers: { cookie } });
    expect((await app.request('/admin/api/session', { headers: { cookie } })).status).toBe(401);
  });
});
