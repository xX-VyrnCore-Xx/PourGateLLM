import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { providerSchema, type ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { PluginHost, type Plugin, type ResponseInfo } from '../src/plugins.js';
import { TokenStore } from '../src/tokens.js';

type Json = Record<string, any>;

const dirWith = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-plugins-'));
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code);
  return dir;
};
const quiet = () => {};

describe('PluginHost.load', () => {
  it('loads valid plugins in file order and runs init', async () => {
    const dir = dirWith({
      'b.mjs': `export default { name: 'second' }`,
      'a.mjs': `export default { name: 'first', init({ log }) { log('hello'); }, adapters: { x: { buildRequest() {}, parseResponse() {} } } }`,
      'readme.txt': 'ignored',
    });
    const logs: string[] = [];
    const host = await PluginHost.load(dir, (m) => logs.push(m));
    expect(host.names).toEqual(['first', 'second']);
    expect([...host.adapters.keys()]).toEqual(['x']);
    expect(logs).toEqual(['[plugin:first] hello']);
  });

  it('returns an empty host for a missing directory', async () => {
    expect((await PluginHost.load('/definitely/not/here')).plugins).toEqual([]);
  });

  it('rejects malformed plugins with the file name in the message', async () => {
    const cases: [string, RegExp][] = [
      [`export default 5`, /bad\.mjs.*plugin object/],
      [`export default { name: 'Bad Name' }`, /name/],
      [`export default { name: 'x', onRequest: 'no' }`, /onRequest.*function/],
      [`export default { name: 'x', adapters: { a: {} } }`, /buildRequest/],
      [`export default { name: 'x', adapters: { 'Bad_Name': { buildRequest() {}, parseResponse() {} } } }`, /adapter name/],
    ];
    for (const [code, re] of cases) {
      await expect(PluginHost.load(dirWith({ 'bad.mjs': code }), quiet)).rejects.toThrow(re);
    }
  });

  it('rejects duplicate plugin and adapter names', async () => {
    await expect(PluginHost.load(dirWith({ 'a.mjs': `export default { name: 'dup' }`, 'b.mjs': `export default { name: 'dup' }` }), quiet)).rejects.toThrow(/duplicate/);
    const ad = `{ buildRequest() {}, parseResponse() {} }`;
    await expect(
      PluginHost.load(dirWith({ 'a.mjs': `export default { name: 'a', adapters: { z: ${ad} } }`, 'b.mjs': `export default { name: 'b', adapters: { z: ${ad} } }` }), quiet),
    ).rejects.toThrow(/more than one plugin/);
  });

  it('accepts the shipped example plugins', async () => {
    const host = await PluginHost.load(resolve(__dirname, '../../../examples/plugins'), quiet);
    expect(host.names).toEqual(['block-words', 'json-api']);
    expect(host.adapters.has('json-api')).toBe(true);
  });
});

describe('registry schema', () => {
  it('accepts an adapter name and rejects bad ones', () => {
    const base = { provider: 'p', base_url: 'https://x.test', api_key_env: 'P_API_KEYS', models: [{ id: 'm' }] };
    expect(providerSchema.safeParse({ ...base, adapter: 'json-api' }).success).toBe(true);
    expect(providerSchema.safeParse({ ...base, adapter: 'Bad Name' }).success).toBe(false);
  });
});

describe('gateway plugins', () => {
  const entry = (name: string, extra: Partial<ProviderEntry> = {}): ProviderEntry => ({
    provider: name,
    base_url: `https://${name}.test/v1`,
    api_key_env: `${name.toUpperCase()}_API_KEYS`,
    auth: 'bearer',
    models: [{ id: `${name}-m`, capabilities: ['chat'], limits: {}, quirks: [] }],
    ...extra,
  });

  function setup(plugins: Plugin[], registry: ProviderEntry[] = [entry('p')], upstream?: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit; body: Json }[] = [];
    const app = createApp({
      registry,
      store: new TokenStore(openDatabase(':memory:')),
      envTokens: ['pg'],
      pools: new Map(registry.map((p) => [p.provider, new KeyPool(['k1', 'k2'])])),
      plugins: new PluginHost(plugins, quiet),
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init, body: JSON.parse(init.body as string) });
        return upstream ? upstream(url, init) : Response.json({ usage: { total_tokens: 3 } });
      }) as unknown as typeof fetch,
    });
    const chat = async (model = 'p-m', extra: Json = {}, headers: Record<string, string> = {}) => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer pg', 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }], ...extra }),
      });
      const text = await res.text();
      return { res, text };
    };
    return { app, calls, chat };
  }

  it('lets onRequest hooks transform the body, in order, with credentials stripped from headers', async () => {
    const seen: Json[] = [];
    const a: Plugin = { name: 'a', onRequest: (r) => ({ body: { ...r.body, temperature: 0.1 } }) };
    const b: Plugin = {
      name: 'b',
      onRequest: (r) => {
        seen.push({ headers: r.headers, clientId: r.clientId, endpoint: r.endpoint, temperature: r.body.temperature });
        return { body: { ...r.body, max_tokens: 7 } };
      },
    };
    const { chat, calls } = setup([a, b]);
    await chat('p-m', {}, { 'x-custom': 'yes', cookie: 'secret=1', 'x-api-key': 'k' });
    expect(calls[0]!.body).toMatchObject({ temperature: 0.1, max_tokens: 7 });
    expect(seen[0]).toMatchObject({ clientId: null, endpoint: 'chat', temperature: 0.1 });
    expect(seen[0]!.headers['x-custom']).toBe('yes');
    expect(Object.keys(seen[0]!.headers)).not.toEqual(expect.arrayContaining(['authorization', 'cookie', 'x-api-key']));
  });

  it('lets a hook reject a request without touching a provider', async () => {
    const { chat, calls } = setup([{ name: 'gate', onRequest: () => ({ reject: { status: 403, message: 'nope' } }) }]);
    const { res, text } = await chat();
    expect(res.status).toBe(403);
    expect(JSON.parse(text).error).toMatchObject({ message: 'nope', code: 'rejected_by_plugin' });
    expect(calls).toHaveLength(0);
  });

  it('fails closed when a hook throws or times out, or removes the model', async () => {
    const boom = setup([{ name: 'boom', onRequest: () => { throw new Error('bug'); } }]);
    const r1 = await boom.chat();
    expect(r1.res.status).toBe(500);
    expect(JSON.parse(r1.text).error).toMatchObject({ code: 'plugin_error', message: 'Plugin "boom" failed' });
    expect(boom.calls).toHaveLength(0);
    const nomodel = setup([{ name: 'm', onRequest: (r) => ({ body: { messages: r.body.messages } }) }]);
    expect((await nomodel.chat()).res.status).toBe(500);
    vi.useFakeTimers();
    try {
      const slow = setup([{ name: 'slow', onRequest: () => new Promise(() => {}) }]);
      const pending = slow.chat();
      await vi.advanceTimersByTimeAsync(5_100);
      expect((await pending).res.status).toBe(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls onResponse with metadata only and survives observer failures', async () => {
    const infos: ResponseInfo[] = [];
    const { chat } = setup([
      { name: 'obs', onResponse: (i) => void infos.push(i) },
      { name: 'bad', onResponse: () => { throw new Error('observer bug'); } },
    ]);
    const { res } = await chat('p-m');
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(infos[0]).toMatchObject({ endpoint: 'chat', requested: 'p-m', provider: 'p', model: 'p-m', status: 200, clientId: null, error: null });
    expect(JSON.stringify(infos)).not.toContain('hello');
  });

  describe('provider adapters', () => {
    const adapterPlugin = (overrides: Partial<{ parse: (res: Response) => Response | Promise<Response> }> = {}): Plugin => ({
      name: 'ad',
      adapters: {
        custom: {
          buildRequest: ({ body, model, baseUrl, apiKey, stream }) => ({
            url: `${baseUrl}/generate`,
            init: { method: 'POST', headers: { 'x-key': apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ model, text: (body.messages as Json[])[0]!.content, stream }) },
          }),
          parseResponse: overrides.parse ?? (async (res, { model }) => {
            const d = (await res.json()) as Json;
            return Response.json({ model, choices: [{ message: { role: 'assistant', content: d.out }, finish_reason: 'stop' }], usage: { total_tokens: 5 } });
          }),
        },
      },
    });

    it('builds the upstream request and converts the response to OpenAI format', async () => {
      const { chat, calls } = setup([adapterPlugin()], [entry('p', { adapter: 'custom' })], () => Response.json({ out: 'adapted!' }));
      const { res, text } = await chat();
      expect(res.status).toBe(200);
      expect(JSON.parse(text).choices[0].message.content).toBe('adapted!');
      expect(calls[0]!.url).toBe('https://p.test/v1/generate');
      expect((calls[0]!.init.headers as Record<string, string>)['x-key']).toBe('k1');
      expect(calls[0]!.body).toEqual({ model: 'p-m', text: 'hello', stream: false });
    });

    it('still fails over on 429 and passes provider errors through without parsing', async () => {
      let n = 0;
      const { chat, calls } = setup([adapterPlugin()], [entry('p', { adapter: 'custom' })], () =>
        n++ === 0 ? new Response('{}', { status: 429 }) : Response.json({ out: 'second key' }),
      );
      expect(JSON.parse((await chat()).text).choices[0].message.content).toBe('second key');
      expect(calls.map((c) => (c.init.headers as Record<string, string>)['x-key'])).toEqual(['k1', 'k2']);
      const bad = setup([adapterPlugin()], [entry('p', { adapter: 'custom' })], () => new Response('{"detail":"bad request"}', { status: 400 }));
      const r = await bad.chat();
      expect(r.res.status).toBe(400);
      expect(r.text).toContain('bad request');
    });

    it('treats an adapter that throws as an upstream failure and tries the next candidate', async () => {
      const broken = adapterPlugin({ parse: () => { throw new Error('cannot parse'); } });
      const plain = entry('plain');
      const { chat } = setup([broken], [entry('p', { adapter: 'custom' }), plain], (url) => (url.includes('p.test') ? Response.json({ out: 'x' }) : Response.json({ ok: true })));
      const { res } = await chat('auto');
      expect(res.status).toBe(200);
      expect(res.headers.get('x-pourgate-provider')).toBe('plain');
    });

    it('skips providers whose adapter is not installed, and never sends embeddings through adapters', async () => {
      const { chat } = setup([], [entry('p', { adapter: 'missing' }), entry('plain')]);
      const r = await chat('auto');
      expect(r.res.headers.get('x-pourgate-provider')).toBe('plain');
      expect((await chat('p-m')).res.status).toBe(503);
    });

    it('passes adapter-produced SSE streams through untouched', async () => {
      const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
      const plugin = adapterPlugin({ parse: () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }) });
      const { chat } = setup([plugin], [entry('p', { adapter: 'custom' })], () => new Response('raw'));
      const { res, text } = await chat('p-m', { stream: true });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toBe(sse);
    });
  });
});
