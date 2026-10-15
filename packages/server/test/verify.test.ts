import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { KEYLESS } from '../src/keypool.js';
import { probeModel, probeProvider, verifyRegistry } from '../src/registry-verify.js';

const entry = (over: Partial<ProviderEntry> = {}): ProviderEntry =>
  ({
    provider: 'p',
    base_url: 'https://p.test/v1/',
    api_key_env: 'P_API_KEYS',
    auth: 'bearer',
    models: [
      { id: 'big', tier: 'large', capabilities: ['chat'], limits: {}, quirks: [] },
      { id: 'embed', tier: 'small', capabilities: ['embeddings'], limits: {}, quirks: [] },
      { id: 'tiny', tier: 'small', capabilities: ['chat'], limits: {}, quirks: [] },
    ],
    ...over,
  }) as ProviderEntry;

const reply = (status: number, body: unknown) => async () => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

describe('provider probe', () => {
  it('picks the smallest chat model', () => {
    expect(probeModel(entry())).toBe('tiny');
    expect(probeModel(entry({ models: [] }))).toBeUndefined();
  });

  it('classifies answers: ok, reasoning-only, bad key, rate limit, gone model, server error', async () => {
    const p = (status: number, body: unknown) => probeProvider(entry(), 'secret-key-1234', { fetch: reply(status, body) });
    expect(await p(200, { choices: [{ message: { content: 'pong' } }] })).toMatchObject({ status: 'ok', model: 'tiny', httpStatus: 200 });
    expect((await p(200, { choices: [{ message: { content: null, reasoning: 'thinking about pong' } }] })).status).toBe('ok');
    expect((await p(401, { error: 'bad' })).status).toBe('bad-key');
    expect((await p(403, 'forbidden')).status).toBe('bad-key');
    expect((await p(429, 'slow down')).status).toBe('rate-limited');
    expect((await p(404, 'no such model')).status).toBe('model-unavailable');
    expect((await p(503, 'down')).status).toBe('server-error');
    expect((await p(200, 'not json')).status).toBe('server-error');
  });

  it('needs a key unless the provider is keyless, and sends no Authorization header for keyless ones', async () => {
    expect(await probeProvider(entry(), undefined)).toMatchObject({ status: 'no-key' });
    let headers: Record<string, string> = {};
    const spy = async (_u: string, init: { headers: Record<string, string> }) => {
      headers = init.headers;
      return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"pong"}}]}' };
    };
    expect((await probeProvider(entry({ keyless: true }), undefined, { fetch: spy as never })).status).toBe('ok');
    expect(headers.authorization).toBeUndefined();
    expect((await probeProvider(entry({ keyless: true }), KEYLESS, { fetch: spy as never })).status).toBe('ok');
    expect(headers.authorization).toBeUndefined();
    await probeProvider(entry(), 'secret-key-1234', { fetch: spy as never });
    expect(headers.authorization).toBe('Bearer secret-key-1234');
  });

  it('removes the key from echoed errors and reports network failures', async () => {
    const r = await probeProvider(entry(), 'secret-key-1234', { fetch: reply(401, 'Incorrect API key: secret-key-1234') });
    expect(r.detail).toBe('Incorrect API key: [key]');
    const boom = async () => {
      throw new Error('connect ECONNREFUSED secret-key-1234');
    };
    const n = await probeProvider(entry(), 'secret-key-1234', { fetch: boom });
    expect(n.status).toBe('unreachable');
    expect(n.detail).not.toContain('secret-key-1234');
  });

  it('verifies every provider with the first key of its variable', async () => {
    const seen: string[] = [];
    const spy = async (url: string, init: { headers: Record<string, string> }) => {
      seen.push(`${new URL(url).host} ${init.headers.authorization ?? '-'}`);
      return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"pong"}}]}' };
    };
    const reg = [entry(), entry({ provider: 'q', base_url: 'https://q.test/v1', api_key_env: 'Q_API_KEYS' }), entry({ provider: 'k', base_url: 'https://k.test/v1', api_key_env: 'K_API_KEYS', keyless: true })];
    const out = await verifyRegistry(reg, { env: { P_API_KEYS: 'aaaa, bbbb' }, fetch: spy as never });
    expect(out.map((r) => `${r.provider}:${r.status}`)).toEqual(['p:ok', 'q:no-key', 'k:ok']);
    expect(seen).toEqual(['p.test Bearer aaaa', 'k.test -']);
    expect((await verifyRegistry(reg, { env: {}, only: 'q' })).map((r) => r.provider)).toEqual(['q']);
  });
});
