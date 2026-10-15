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
