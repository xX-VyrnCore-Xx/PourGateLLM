import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { AuditLog } from '../src/audit.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { TokenStore } from '../src/tokens.js';

const registry: ProviderEntry[] = [
  { provider: 'groq', base_url: 'https://upstream.test/v1', api_key_env: 'GROQ_API_KEYS', auth: 'bearer', models: [{ id: 'm1', capabilities: ['chat'], limits: { rpm: 5 }, quirks: [] }] },
];
const json = { 'content-type': 'application/json' };

function setup() {
  const db = openDatabase(':memory:');
  const audit = new AuditLog(db);
  const app = createApp({
    registry,
    store: new TokenStore(db),
    pools: new Map([['groq', new KeyPool(['secret-key-1'])]]),
    adminPassword: 'hunter2',
    audit,
  });
  return { app, audit };
}

async function login(app: ReturnType<typeof setup>['app'], password = 'hunter2') {
  return app.request('/admin/api/login', { method: 'POST', headers: json, body: JSON.stringify({ password }) });
}

describe('audit log', () => {
  it('records logins, token changes and logout without secrets', async () => {
    const { app, audit } = setup();
    expect((await login(app, 'wrong-password-123')).status).toBe(401);
    const cookie = (await login(app)).headers.get('set-cookie')!.split(';')[0]!;
    const created = await app.request('/admin/api/tokens', { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ name: 'laptop' }) });
    const { token, record } = (await created.json()) as { token: string; record: { id: number } };
    expect((await app.request(`/admin/api/tokens/${record.id}`, { method: 'DELETE', headers: { cookie } })).status).toBe(204);
    await app.request('/admin/api/logout', { method: 'POST', headers: { cookie } });

    const actions = audit.recent().map((e) => e.action).reverse();
    expect(actions).toEqual(['login_failed', 'login', 'token_create', 'token_revoke', 'logout']);
    const dump = JSON.stringify(audit.recent());
    expect(dump).not.toContain('hunter2');
    expect(dump).not.toContain('wrong-password-123');
    expect(dump).not.toContain(token);
  });

  it('is readable only by an authenticated admin and can be filtered', async () => {
    const { app } = setup();
    expect((await app.request('/admin/api/audit')).status).toBe(401);
    const cookie = (await login(app)).headers.get('set-cookie')!.split(';')[0]!;
    const all = (await (await app.request('/admin/api/audit', { headers: { cookie } })).json()) as { action: string }[];
    expect(all.map((e) => e.action)).toContain('login');
    const none = (await (await app.request('/admin/api/audit?action=token_create', { headers: { cookie } })).json()) as unknown[];
    expect(none).toEqual([]);
  });

  it('prunes old entries and clamps the limit', () => {
    let t = 1000;
    const audit = new AuditLog(openDatabase(':memory:'), () => t);
    audit.record('login');
    t = 5000;
    audit.record('logout');
    expect(audit.prune(2000)).toBe(1);
    expect(audit.recent(0)).toHaveLength(1);
  });
});

describe('playground', () => {
  const upstream = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi there' } }], usage: { total_tokens: 7 } }), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  function playApp() {
    const db = openDatabase(':memory:');
    const seen: unknown[] = [];
    const fetcher = (async (url: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return upstream(url as string, init);
    }) as typeof fetch;
    const app = createApp({ registry, store: new TokenStore(db), pools: new Map([['groq', new KeyPool(['secret-key-1'])]]), adminPassword: 'hunter2', audit: new AuditLog(db), fetch: fetcher });
    return { app, seen };
  }

  it('routes a prompt through the gateway and reports the route', async () => {
    const { app, seen } = playApp();
    const cookie = (await login(app)).headers.get('set-cookie')!.split(';')[0]!;
    const res = await app.request('/admin/api/playground', { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hello' }], max_tokens: 99999 }) });
    const body = (await res.json()) as { ok: boolean; content: string; route: { provider: string; model: string }; tokens: number };
    expect(body).toMatchObject({ ok: true, content: 'hi there', tokens: 7, route: { provider: 'groq', model: 'm1' } });
    expect((seen[0] as { max_tokens: number }).max_tokens).toBe(1024);
  });

  it('requires a session and valid input; the internal secret does not work from outside', async () => {
    const { app } = playApp();
    expect((await app.request('/admin/api/playground', { method: 'POST', headers: json, body: '{}' })).status).toBe(401);
    const cookie = (await login(app)).headers.get('set-cookie')!.split(';')[0]!;
    expect((await app.request('/admin/api/playground', { method: 'POST', headers: { ...json, cookie }, body: '{"model":"auto"}' })).status).toBe(400);
    expect((await app.request('/v1/chat/completions', { method: 'POST', headers: { ...json, authorization: 'Bearer guess' }, body: '{}' })).status).toBe(401);
  });
});
