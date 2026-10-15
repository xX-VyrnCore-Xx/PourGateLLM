import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { checkRegistry, listedIds } from '../src/registry-check.js';

const provider = (over: Partial<ProviderEntry> = {}): ProviderEntry =>
  ({
    provider: 'p',
    base_url: 'https://p.example/v1',
    api_key_env: 'P_KEYS',
    auth: 'bearer',
    models: [
      { id: 'a', capabilities: ['chat'], limits: {}, quirks: [] },
      { id: 'b', capabilities: ['chat'], limits: {}, quirks: [] },
      { id: 'whisper', capabilities: ['transcription'], limits: {}, quirks: [] },
    ],
    ...over,
  }) as ProviderEntry;

const reply = (status: number, body: unknown = {}) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('registry check', () => {
  it('reads OpenAI-style and Gemini-style listings', () => {
    expect([...listedIds({ data: [{ id: 'x' }, { id: 'y' }] })]).toEqual(['x', 'y']);
    expect([...listedIds({ models: [{ name: 'models/gemini-2.5-flash' }] })]).toEqual(['gemini-2.5-flash']);
    expect(listedIds('nonsense').size).toBe(0);
  });

  it('reports ids that vanished and ignores non-chat models', async () => {
    const [r] = await checkRegistry([provider()], { env: {}, fetch: reply(200, { data: [{ id: 'a' }, { id: 'z' }] }) });
    expect(r).toMatchObject({ status: 'stale', missing: ['b'], checked: 2, listed: 2 });
  });

  it('is ok when every id is listed', async () => {
    const [r] = await checkRegistry([provider()], { env: {}, fetch: reply(200, { data: [{ id: 'a' }, { id: 'b' }] }) });
    expect(r?.status).toBe('ok');
  });

  it('sends the first configured key and reports providers that need one', async () => {
    let auth = '';
    const spy = async (_u: string, init: { headers: Record<string, string> }) => {
      auth = init.headers.authorization ?? '';
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'a' }, { id: 'b' }] }) };
    };
    await checkRegistry([provider()], { env: { P_KEYS: 'k1, k2' }, fetch: spy as never });
    expect(auth).toBe('Bearer k1');
    const [r] = await checkRegistry([provider()], { env: {}, fetch: reply(401) });
    expect(r?.status).toBe('needs-key');
  });

  it('treats network errors, server errors and junk bodies as unreachable, not stale', async () => {
    const boom = async () => {
      throw new Error('offline');
    };
    expect((await checkRegistry([provider()], { env: {}, fetch: boom }))[0]).toMatchObject({ status: 'unreachable', detail: 'offline' });
    expect((await checkRegistry([provider()], { env: {}, fetch: reply(500) }))[0]?.status).toBe('unreachable');
    expect((await checkRegistry([provider()], { env: {}, fetch: reply(200, { hello: 1 }) }))[0]?.status).toBe('unreachable');
  });

  it('can be limited to one provider', async () => {
    const out = await checkRegistry([provider(), provider({ provider: 'q' })], { env: {}, fetch: reply(401), only: 'q' });
    expect(out.map((r) => r.provider)).toEqual(['q']);
  });
});
