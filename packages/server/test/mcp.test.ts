import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { handleMessage, type McpBackend } from '../src/mcp.js';
import { TokenStore } from '../src/tokens.js';

const entry: ProviderEntry = { provider: 'p', base_url: 'https://p.test/v1', api_key_env: 'P_API_KEYS', auth: 'bearer', models: [{ id: 'm1', capabilities: ['chat'], limits: {}, quirks: [] }] };

function setup() {
  const bodies: Record<string, any>[] = [];
  const fetcher = (async (_u: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'hello from m1' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  const app = createApp({ registry: [entry], store: new TokenStore(openDatabase(':memory:')), envTokens: ['pg'], pools: new Map([['p', new KeyPool(['key-aaaaaaaa'])]]), fetch: fetcher });
  const rpc = (body: unknown, path = '/v1/mcp', token = 'pg') =>
    app.request(path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, rpc, bodies };
}

describe('MCP server', () => {
  it('negotiates the protocol version and lists the tools', async () => {
    const { rpc } = setup();
    const init = (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json()) as any;
    expect(init.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'pourgatellm' }, capabilities: { tools: {} } });
    const unknown = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).json()) as any;
    expect(unknown.result.protocolVersion).toBe('2025-06-18');
    const tools = (await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json()) as any;
    expect(tools.result.tools.map((t: any) => t.name)).toEqual(['chat', 'list_models', 'provider_status']);
  });

  it('answers notifications with 202 and no body, pings, and rejects unknown methods', async () => {
    const { rpc } = setup();
    const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe('');
    expect(((await (await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).json()) as any).result).toEqual({});
    expect(((await (await rpc({ jsonrpc: '2.0', id: 2, method: 'nope' })).json()) as any).error.code).toBe(-32601);
    expect(((await (await rpc({ hello: 1 })).json()) as any).error.code).toBe(-32600);
  });

  it('runs chat through the gateway pipeline with the caller token and names the model that answered', async () => {
    const { rpc, bodies } = setup();
    const res = (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chat', arguments: { prompt: 'hi', system: 'be brief', model: 'm1', max_tokens: 20 } } })).json()) as any;
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain('hello from m1');
    expect(res.result.content[0].text).toContain('[answered by p / m1]');
    expect(bodies[0]).toMatchObject({ model: 'm1', max_tokens: 20, messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] });
  });

  it('reports tool errors inside the result, lists models and provider status', async () => {
    const { rpc } = setup();
    const bad = (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chat', arguments: {} } })).json()) as any;
    expect(bad.result.isError).toBe(true);
    const missing = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } })).json()) as any;
    expect(missing.error.code).toBe(-32602);
    const models = (await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_models' } })).json()) as any;
    expect(models.result.content[0].text).toMatch(/auto[\s\S]*fusion[\s\S]*m1/);
    const status = (await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'provider_status' } })).json()) as any;
    expect(status.result.content[0].text).toBe('p: enabled, 1 models');
  });

  it('supports batches, is reachable at /mcp too, needs a valid token and has no GET stream', async () => {
    const { rpc, app } = setup();
    const batch = (await (await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }])).json()) as any[];
    expect(batch.map((r) => r.id)).toEqual([1, 2]);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, '/mcp')).status).toBe(200);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, '/mcp', 'wrong-token')).status).toBe(401);
    expect((await app.request('/v1/mcp', { headers: { authorization: 'Bearer pg' } })).status).toBe(405);
    expect((await rpc(Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' })))).status).toBe(400);
  });

  it('survives a backend that throws', async () => {
    const backend: McpBackend = { version: 't', models: () => [], providers: () => [], chat: async () => { throw new Error('boom'); } };
    const r = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chat', arguments: { prompt: 'x' } } }, backend)) as any;
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('boom');
  });
});
