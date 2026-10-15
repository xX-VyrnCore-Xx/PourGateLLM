import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { pickPanel } from '../src/fusion.js';
import { KeyPool } from '../src/keypool.js';
import { TokenStore } from '../src/tokens.js';

const mk = (name: string, ...ids: [string, string?][]): ProviderEntry =>
  ({
    provider: name,
    base_url: `https://${name}.test/v1`,
    api_key_env: `${name.toUpperCase()}_API_KEYS`,
    auth: 'bearer',
    models: ids.map(([id, family]) => ({ id, family, tier: 'large', capabilities: ['chat'], limits: {}, quirks: [] })),
  }) as ProviderEntry;

const registry = [mk('a', ['m-a', 'fam-a']), mk('b', ['m-b', 'fam-b']), mk('c', ['m-c', 'fam-c'], ['m-c2', 'fam-c'])];

function build(handler: (model: string, body: Record<string, any>) => Response, panel = 3) {
  const calls: { model: string; body: Record<string, any> }[] = [];
  const fetcher = (async (_u: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    calls.push({ model: body.model, body });
    return handler(body.model, body);
  }) as typeof fetch;
  const app = createApp({
    registry,
    store: new TokenStore(openDatabase(':memory:')),
    envTokens: ['pg'],
    pools: new Map(registry.map((p) => [p.provider, new KeyPool([`key-${p.provider}-aaaa`])])),
    fetch: fetcher,
    fusionPanel: panel,
  });
  const chat = (extra: Record<string, unknown> = {}) =>
    app.request('/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer pg', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fusion', messages: [{ role: 'user', content: 'What is 2+2?' }], ...extra }) });
  return { chat, calls, app };
}

const reply = (content: string) => Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

describe('panel selection', () => {
  it('prefers distinct providers, then distinct families', () => {
    const cands = registry.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
    expect(pickPanel(cands, 3).map((c) => c.model.id)).toEqual(['m-a', 'm-b', 'm-c']);
    expect(pickPanel(cands, 5).map((c) => c.model.id)).toEqual(['m-a', 'm-b', 'm-c']); // m-c2 shares a family with m-c
    expect(pickPanel(cands, 1)).toHaveLength(1);
  });
});

describe('fusion model', () => {
  it('asks a panel in parallel and returns the judge synthesis with summed usage', async () => {
    const { chat, calls } = build((model, body) => (body.messages[0].role === 'system' && /combine several draft/i.test(body.messages[0].content) ? reply('FINAL: 4') : reply(`draft from ${model}`)));
    const res = await chat();
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.model).toBe('fusion');
    expect(json.choices[0].message.content).toBe('FINAL: 4');
    expect(json.usage).toEqual({ prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 }); // 3 drafts + judge
    expect(res.headers.get('x-pourgate-fusion')).toBe('3 drafts + judge');
    expect(res.headers.get('x-pourgate-fusion-panel')?.split(',').sort()).toEqual(['m-a', 'm-b', 'm-c']);
    const judge = calls.find((c) => /combine several draft/i.test(String(c.body.messages[0]?.content)))!;
    expect(judge.body.messages[1].content).toContain('draft from m-a');
    expect(judge.body.messages[1].content).toContain('What is 2+2?');
    expect(calls.filter((c) => c !== judge)).toHaveLength(3);
  });

  it('returns the only draft when one model answers, and skips the judge', async () => {
    const { chat, calls } = build((model) => (model === 'm-b' ? reply('only b') : new Response('down', { status: 502 })));
    const json = (await (await chat()).json()) as any;
    expect(json.choices[0].message.content).toBe('only b');
    expect(calls.some((c) => /combine several draft/i.test(String(c.body.messages?.[0]?.content)))).toBe(false);
  });

  it('falls back to the first draft when the judge fails', async () => {
    const { chat } = build((model, body) => (/combine several draft/i.test(String(body.messages[0]?.content)) ? new Response('down', { status: 502 }) : reply(`draft ${model}`)));
    const res = await chat();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-pourgate-fusion')).toBe('3 drafts');
    expect(((await res.json()) as any).choices[0].message.content).toMatch(/^draft /);
  });

  it('answers 503 when every panel member fails and 400 when tools are requested', async () => {
    expect((await build(() => new Response('down', { status: 502 })).chat()).status).toBe(503);
    const res = await build(() => reply('x')).chat({ tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('fusion_no_tools');
  });

  it('can stream the final answer and is listed as a model', async () => {
    const { chat, app } = build((model, body) => (/combine several draft/i.test(String(body.messages[0]?.content)) ? reply('streamed answer') : reply('d')));
    const text = await (await chat({ stream: true })).text();
    expect(text).toContain('streamed answer');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    const list = (await (await app.request('/v1/models', { headers: { authorization: 'Bearer pg' } })).json()) as any;
    expect(list.data.map((m: any) => m.id)).toContain('fusion');
  });
});
