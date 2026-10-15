import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KEYLESS } from '../src/keypool.js';
import { PoolManager } from '../src/pools.js';
import { TokenStore } from '../src/tokens.js';

const mk = (over: Partial<ProviderEntry> = {}): ProviderEntry =>
  ({ provider: 'anon', base_url: 'https://anon.test/v1', api_key_env: 'ANON_API_KEYS', auth: 'bearer', keyless: true, models: [{ id: 'm', capabilities: ['chat'], limits: {}, quirks: [] }], ...over }) as ProviderEntry;

describe('keyless providers', () => {
  it('are enabled without any key, unlike ordinary providers', () => {
    const pm = new PoolManager(undefined, {}, () => {});
    pm.sync([mk(), mk({ provider: 'normal', keyless: undefined })]);
    expect([...pm.pools.keys()]).toEqual(['anon']);
    expect(pm.pools.get('anon')!.keys).toEqual([KEYLESS]);
  });

  it('give way to real keys when the operator adds them', () => {
    const pm = new PoolManager(undefined, { ANON_API_KEYS: 'real-key-1234' }, () => {});
    pm.sync([mk()]);
    expect(pm.pools.get('anon')!.keys).toEqual(['real-key-1234']);
  });

  it('are called without an Authorization header, keyed ones with it', async () => {
    const seen: Record<string, string | null> = {};
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen[new URL(url).host] = new Headers(init?.headers).get('authorization');
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
    }) as typeof fetch;
    const pm = new PoolManager(undefined, { KEYED_API_KEYS: 'secret-key-9999' }, () => {});
    const registry = [mk(), mk({ provider: 'keyed', base_url: 'https://keyed.test/v1', api_key_env: 'KEYED_API_KEYS', keyless: undefined, models: [{ id: 'k', capabilities: ['chat'], limits: {}, quirks: [] }] } as Partial<ProviderEntry>)];
    pm.sync(registry);
    const app = createApp({ registry, store: new TokenStore(openDatabase(':memory:')), envTokens: ['pg'], pools: pm.pools, fetch: fetcher });
    const call = (model: string) => app.request('/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer pg', 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'x' }] }) });
    expect((await call('m')).status).toBe(200);
    expect((await call('k')).status).toBe(200);
    expect(seen['anon.test']).toBeNull();
    expect(seen['keyed.test']).toBe('Bearer secret-key-9999');
  });
});
