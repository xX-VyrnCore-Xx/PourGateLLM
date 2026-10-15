import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { Profiles, StickyStore, parseProfiles } from '../src/profiles.js';
import { TokenStore } from '../src/tokens.js';

const provider = (name: string, ...models: { id: string; caps?: string[]; context?: number }[]): ProviderEntry =>
  ({
    provider: name,
    base_url: `https://${name}.test/v1`,
    api_key_env: `${name.toUpperCase()}_API_KEYS`,
    auth: 'bearer',
    models: models.map((m) => ({ id: m.id, capabilities: m.caps ?? ['chat'], context: m.context, limits: {}, quirks: [] })),
  }) as ProviderEntry;

const registry = [provider('a', { id: 'big' }, { id: 'tiny', context: 100 }), provider('b', { id: 'big' }, { id: 'mid', caps: ['chat', 'tools'] })];

describe('profile parsing', () => {
  it('accepts strings and {provider, model} items and rejects bad names or shapes', () => {
    const p = parseProfiles('coding:\n  - big\n  - { provider: b, model: mid }\n');
    expect(p.names()).toEqual(['coding']);
    expect(p.profileFor('auto:coding')).toBe('coding');
    expect(p.profileFor('profile:coding')).toBe('coding');
    expect(p.profileFor('auto:other')).toBeUndefined();
    expect(p.profileFor('auto:small')).toBeUndefined();
    expect(() => parseProfiles('Bad Name:\n  - x\n')).toThrow(/invalid profile name/);
    expect(() => parseProfiles('small:\n  - x\n')).toThrow(/invalid profile name/);
    expect(() => parseProfiles('x: []\n')).toThrow();
    expect(parseProfiles('').names()).toEqual([]);
  });

  it('resolves in profile order, on every provider that serves a bare id, without duplicates', () => {
    const p = parseProfiles('c:\n  - mid\n  - big\n  - { provider: a, model: big }\n');
    expect(p.resolve(registry, 'c').map((c) => `${c.provider.provider}|${c.model.id}`)).toEqual(['b|mid', 'a|big', 'b|big']);
  });
});

describe('sticky store', () => {
  it('expires entries and caps its size', () => {
    let now = 0;
    const s = new StickyStore(1000, 2, () => now);
    s.set('k1', 't1');
    expect(s.get('k1')).toBe('t1');
    now = 1500;
    expect(s.get('k1')).toBeUndefined();
    s.set('a', '1');
    s.set('b', '2');
    s.set('c', '3');
    expect(s.get('a')).toBeUndefined();
    expect(s.get('c')).toBe('3');
  });
});

describe('profiles through the gateway', () => {
  function build(profiles: Profiles, failing = new Set<string>(), sticky?: StickyStore) {
    const hosts: string[] = [];
    const fetcher = (async (url: string) => {
      const host = new URL(url).host;
      hosts.push(host);
      return failing.has(host) ? new Response('down', { status: 502 }) : Response.json({ choices: [{ message: { role: 'assistant', content: host }, finish_reason: 'stop' }] });
    }) as typeof fetch;
    const app = createApp({
      registry,
      store: new TokenStore(openDatabase(':memory:')),
      envTokens: ['pg'],
      pools: new Map([['a', new KeyPool(['key-aaaaaaaa'])], ['b', new KeyPool(['key-bbbbbbbb'])]]),
      fetch: fetcher,
      profiles,
      sticky,
    });
    const chat = (model: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
      app.request('/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer pg', 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }) });
    return { app, chat, hosts };
  }
  const prof = parseProfiles('coding:\n  - mid\n  - big\ntools:\n  - tiny\n  - mid\n');

  it('lists profiles as models and answers from the first model of the chain', async () => {
    const { app, chat, hosts } = build(prof);
    const list = (await (await app.request('/v1/models', { headers: { authorization: 'Bearer pg' } })).json()) as { data: { id: string }[] };
    expect(list.data.map((m) => m.id)).toContain('auto:coding');
    const res = await chat('auto:coding');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-pourgate-model')).toBe('mid');
    expect(hosts).toEqual(['b.test']);
  });

  it('fails over to the next model of the chain', async () => {
    const { chat, hosts } = build(prof, new Set(['b.test']));
    const res = await chat('auto:coding');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-pourgate-provider')).toBe('a');
    expect(hosts[0]).toBe('b.test');
    expect(hosts.at(-1)).toBe('a.test');
  });

  it('skips models that cannot serve the request (context too small)', async () => {
    const { chat } = build(prof);
    const res = await chat('auto:tools', { messages: [{ role: 'user', content: 'x'.repeat(2000) }] });
    expect(res.headers.get('x-pourgate-model')).toBe('mid'); // tiny has a 100-token window
  });

  it('keeps a conversation on the model that served it, per client and session', async () => {
    const sticky = new StickyStore();
    const { chat } = build(parseProfiles('pair:\n  - big\n'), new Set(), sticky);
    const served = async (headers: Record<string, string>) => (await chat('auto:pair', {}, headers)).headers.get('x-pourgate-provider');
    expect(await served({ 'x-pourgate-session': 's1' })).toBe('a'); // first turn follows the chain and is remembered
    sticky.set('env:s1|auto:pair', 'b|big'); // e.g. an earlier turn was answered by b while a was resting
    expect(await served({ 'x-pourgate-session': 's1' })).toBe('b'); // same conversation goes back to b
    expect(await served({ 'x-pourgate-session': 's2' })).toBe('a'); // another conversation follows the chain
    expect(await served({})).toBe('a'); // no session header: no stickiness
  });

  it('returns 404 for an undefined profile', async () => {
    const { chat } = build(prof);
    expect((await chat('auto:nope')).status).toBe(404);
  });
});
