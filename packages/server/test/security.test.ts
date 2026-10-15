import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { TokenStore } from '../src/tokens.js';

const registry: ProviderEntry[] = [
  { provider: 'p', base_url: 'https://p.test/v1', api_key_env: 'P_API_KEYS', auth: 'bearer', models: [{ id: 'm1', capabilities: ['chat'], limits: {}, quirks: [] }] },
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-sec-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(secureCookie = false) {
  return createApp({
    registry,
    store: new TokenStore(openDatabase(':memory:')),
    envTokens: ['good-token'],
    pools: new Map([['p', new KeyPool(['k'])]]),
    adminPassword: 'a-long-enough-password',
    staticDir: dir,
    secureCookie,
    fetch: (async () => Response.json({ choices: [] })) as typeof fetch,
  });
}

describe('browser hardening', () => {
  it('sends a strict CSP and friends on the dashboard and the admin API', async () => {
    const app = setup();
    for (const path of ['/', '/admin/api/session']) {
      const res = await app.request(path);
      const csp = res.headers.get('content-security-policy')!;
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('strict-transport-security')).toBeNull();
    }
    expect((await app.request('/admin/api/session')).headers.get('cache-control')).toBe('no-store');
  });

  it('adds HSTS only when served over HTTPS', async () => {
    const res = await setup(true).request('/');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
  });

  it('leaves the API proxy responses alone', async () => {
    const res = await setup().request('/v1/models', { headers: { authorization: 'Bearer good-token' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});

describe('token guessing', () => {
  it('throttles repeated failed authentication, but not good requests', async () => {
    const app = setup();
    const bad = () => app.request('/v1/models', { headers: { authorization: 'Bearer nope' } });
    for (let i = 0; i < 30; i++) expect((await bad()).status).toBe(401);
    const blocked = await bad();
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('too_many_failed_auth');
    // a valid token is still accepted while the guesser is throttled
    expect((await app.request('/v1/models', { headers: { authorization: 'Bearer good-token' } })).status).toBe(200);
  });
});
