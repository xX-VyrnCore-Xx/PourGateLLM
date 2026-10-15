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

describe('profile editing from the dashboard', () => {
  async function adminSetup() {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'prof-')), 'profiles.yaml');
    const profiles = new Profiles();
    const app = createApp({
      registry,
      store: new TokenStore(openDatabase(':memory:')),
      envTokens: ['pg'],
      pools: new Map([['a', new KeyPool(['key-aaaaaaaa'])], ['b', new KeyPool(['key-bbbbbbbb'])]]),
      fetch: (async () => Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })) as typeof fetch,
      adminPassword: 'hunter2-long-enough',
      profiles,
      onProfilesChange: () => profiles.save(file),
    });
    const cookie = (await app.request('/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'hunter2-long-enough' }) })).headers.get('set-cookie')!.split(';')[0]!;
    const call = (path: string, method: string, body?: unknown) => app.request(`/admin/api${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { app, call, file, readFileSync, profiles };
  }

  it('creates, uses, replaces and deletes a profile, persisting it as YAML', async () => {
    const { app, call, file, readFileSync } = await adminSetup();
    const created = await call('/profiles/coding', 'PUT', { chain: ['mid', { model: 'big', provider: 'a' }] });
    expect(created.status).toBe(201);
    expect(readFileSync(file, 'utf8')).toContain('coding:');
    expect(parseProfiles(readFileSync(file, 'utf8')).chain('coding')).toEqual([{ model: 'mid' }, { provider: 'a', model: 'big' }]);
    const listed = (await (await call('/profiles', 'GET')).json()) as { name: string; resolved: number }[];
    expect(listed).toEqual([expect.objectContaining({ name: 'coding', resolved: 2 })]);
    // the new profile works immediately, without a restart
    const chat = await app.request('/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer pg', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto:coding', messages: [{ role: 'user', content: 'x' }] }) });
    expect(chat.headers.get('x-pourgate-model')).toBe('mid');
    expect((await call('/profiles/coding', 'PUT', { chain: ['big'] })).status).toBe(200);
    expect((await call('/profiles/coding', 'DELETE')).status).toBe(204);
    expect(readFileSync(file, 'utf8')).not.toContain('coding:');
    expect((await call('/profiles/coding', 'DELETE')).status).toBe(404);
  });

  it('rejects bad names, unknown models and malformed chains, and needs a session', async () => {
    const { app, call } = await adminSetup();
    expect((await call('/profiles/Bad Name', 'PUT', { chain: ['mid'] })).status).toBe(400);
    expect((await call('/profiles/small', 'PUT', { chain: ['mid'] })).status).toBe(400);
    const unknown = await call('/profiles/ok', 'PUT', { chain: ['nope'] });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toMatch(/no chat model "nope"/);
    expect((await call('/profiles/ok', 'PUT', { chain: [{ model: 'mid', provider: 'zzz' }] })).status).toBe(400);
    expect((await call('/profiles/ok', 'PUT', { chain: [] })).status).toBe(400);
    expect((await call('/profiles/ok', 'PUT', {})).status).toBe(400);
    expect((await app.request('/admin/api/profiles')).status).toBe(401);
  });
});
