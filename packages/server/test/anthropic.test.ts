import { describe, expect, it, vi } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import {
  estimateInputTokens,
  mapModel,
  toAnthropicMessage,
  toOpenAIRequest,
  translateStream,
  validateRequest,
  wrapResponse,
} from '../src/anthropic.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { TokenStore } from '../src/tokens.js';

type Json = Record<string, any>;

const sseOf = (chunks: (Json | '[DONE]')[]) => chunks.map((c) => `data: ${c === '[DONE]' ? c : JSON.stringify(c)}\n\n`).join('');
const streamOf = (text: string, size = text.length) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const bytes = new TextEncoder().encode(text);
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
      c.close();
    },
  });
const events = async (stream: ReadableStream<Uint8Array>) => {
  const text = await new Response(stream).text();
  return text
    .trim()
    .split('\n\n')
    .map((block) => {
      const [e, d] = block.split('\n');
      return { event: e!.replace('event: ', ''), data: JSON.parse(d!.replace('data: ', '')) as Json };
    });
};

describe('request translation', () => {
  it('maps Anthropic model names to gateway tiers', () => {
    expect(mapModel('claude-3-5-haiku-20241022')).toBe('auto:small');
    expect(mapModel('claude-sonnet-4-5')).toBe('auto:medium');
    expect(mapModel('claude-opus-4-1')).toBe('auto:large');
    expect(mapModel('claude-something')).toBe('auto');
    expect(mapModel('llama-3.3-70b-versatile')).toBe('llama-3.3-70b-versatile');
    expect(mapModel('auto:large')).toBe('auto:large');
  });

  it('validates required fields', () => {
    const ok = { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };
    expect(validateRequest(ok)).toBeNull();
    expect(validateRequest({ ...ok, model: '' })).toMatch(/model/);
    expect(validateRequest({ ...ok, messages: [] })).toMatch(/messages/);
    expect(validateRequest({ ...ok, max_tokens: undefined })).toMatch(/max_tokens/);
    expect(validateRequest({ ...ok, max_tokens: 0 })).toMatch(/max_tokens/);
    expect(validateRequest({ ...ok, messages: [{ role: 'system', content: 'x' }] })).toMatch(/role/);
    expect(validateRequest({ ...ok, messages: [{ role: 'user', content: 5 }] })).toMatch(/content/);
  });

  it('translates system, text, images and sampling options', () => {
    const out = toOpenAIRequest({
      model: 'claude-3-5-haiku',
      max_tokens: 50,
      temperature: 0.3,
      top_p: 0.9,
      stop_sequences: ['END'],
      stream: true,
      system: [{ type: 'text', text: 'Be brief.' }, { type: 'text', text: 'Be kind.' }],
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } },
          ],
        },
      ],
    }) as Json;
    expect(out).toMatchObject({ model: 'auto:small', max_tokens: 50, temperature: 0.3, top_p: 0.9, stop: ['END'], stream: true });
    expect(out.messages[0]).toEqual({ role: 'system', content: 'Be brief.\nBe kind.' });
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(out.messages[2].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'https://x.test/a.png' } },
    ]);
  });

  it('translates tools, tool choices, tool_use and tool_result blocks', () => {
    const out = toOpenAIRequest({
      model: 'm',
      max_tokens: 10,
      tools: [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      tool_choice: { type: 'any' },
      messages: [
        { role: 'user', content: 'weather in Rome?' },
        { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Rome' } }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '21C' }] },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true },
            { type: 'text', text: 'thanks' },
          ],
        },
      ],
    }) as Json;
    expect(out.tools).toEqual([{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]);
    expect(out.tool_choice).toBe('required');
    expect(out.messages[1]).toEqual({
      role: 'assistant',
      content: 'Checking.',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } }],
    });
    // tool results come first, in order, then the user's own text
    expect(out.messages.slice(2)).toEqual([
      { role: 'tool', tool_call_id: 'toolu_1', content: '21C' },
      { role: 'tool', tool_call_id: 'toolu_2', content: 'Error: boom' },
      { role: 'user', content: 'thanks' },
    ]);
    expect(toOpenAIRequest({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }], tool_choice: { type: 'tool', name: 'f' } }).tool_choice).toEqual({ type: 'function', function: { name: 'f' } });
    expect(toOpenAIRequest({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }], tool_choice: { type: 'none' } }).tool_choice).toBe('none');
  });

  it('estimates input tokens from system, messages and tools', () => {
    expect(estimateInputTokens({ messages: [{ role: 'user', content: 'x'.repeat(400) }] })).toBe(100);
    expect(estimateInputTokens({ system: 'y'.repeat(40), messages: [] })).toBe(10);
    expect(estimateInputTokens({})).toBe(1);
  });
});

describe('response translation', () => {
  it('converts text, usage and stop reasons', () => {
    const msg = toAnthropicMessage(
      { model: 'upstream', choices: [{ message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'length' }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
      'claude-3-5-haiku',
    ) as Json;
    expect(msg).toMatchObject({ type: 'message', role: 'assistant', model: 'claude-3-5-haiku', stop_reason: 'max_tokens', stop_sequence: null, usage: { input_tokens: 7, output_tokens: 3 } });
    expect(msg.id).toMatch(/^msg_/);
    expect(msg.content).toEqual([{ type: 'text', text: 'Hi!' }]);
  });

  it('converts tool calls, tolerating invalid argument JSON, and pads empty content', () => {
    const msg = toAnthropicMessage(
      {
        choices: [
          {
            message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'f', arguments: '{"a":1}' } }, { id: 'call_2', function: { name: 'g', arguments: '{oops' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'm',
    ) as Json;
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'f', input: { a: 1 } },
      { type: 'tool_use', id: 'call_2', name: 'g', input: {} },
    ]);
    expect((toAnthropicMessage({ choices: [] }, 'm') as Json).content).toEqual([{ type: 'text', text: '' }]);
  });

  it('wraps errors in the Anthropic error shape', async () => {
    const mk = (status: number) => wrapResponse(Response.json({ error: { message: 'nope', type: 'x', code: null } }, { status }), 'm', 1);
    expect(await (await mk(404)).json()).toEqual({ type: 'error', error: { type: 'not_found_error', message: 'nope' } });
    expect(((await (await mk(429)).json()) as Json).error.type).toBe('rate_limit_error');
    expect(((await (await mk(503)).json()) as Json).error.type).toBe('overloaded_error');
    expect(((await (await mk(401)).json()) as Json).error.type).toBe('authentication_error');
    expect(((await (await mk(400)).json()) as Json).error.type).toBe('invalid_request_error');
    expect((await mk(502)).status).toBe(502);
  });
});

describe('stream translation', () => {
  const chunk = (delta: Json, finish: string | null = null, extra: Json = {}) => ({ choices: [{ delta, finish_reason: finish }], ...extra });

  it('streams text with the full event sequence, even when SSE lines are split across reads', async () => {
    const upstream = sseOf([chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hel' }), chunk({ content: 'lo' }), chunk({}, 'stop'), { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }, '[DONE]']);
    for (const size of [upstream.length, 7, 1]) {
      const ev = await events(translateStream(streamOf(upstream, size), 'claude-x', 5));
      expect(ev.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
      expect(ev[0]!.data.message).toMatchObject({ model: 'claude-x', role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 0 } });
      expect(ev.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text).join('')).toBe('Hello');
      expect(ev.at(-2)!.data).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 9, output_tokens: 2 } });
    }
  });

  it('estimates output tokens when the provider sends no usage, and closes a stream that never finished', async () => {
    const ev = await events(translateStream(streamOf(sseOf([chunk({ content: 'x'.repeat(40) })])), 'm', 3));
    expect(ev.at(-2)!.data).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 3, output_tokens: 10 } });
    expect(ev.at(-1)!.event).toBe('message_stop');
    expect(ev.some((e) => e.event === 'content_block_stop')).toBe(true);
  });

  it('streams tool calls as tool_use blocks with partial JSON, after text', async () => {
    const upstream = sseOf([
      chunk({ content: 'Let me check.' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'get_weather', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Rome"}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'second', arguments: '{}' } }] }),
      chunk({}, 'tool_calls'),
      '[DONE]',
    ]);
    const ev = await events(translateStream(streamOf(upstream, 11), 'm', 1));
    const starts = ev.filter((e) => e.event === 'content_block_start').map((e) => e.data.content_block);
    expect(starts).toEqual([
      { type: 'text', text: '' },
      { type: 'tool_use', id: 'call_a', name: 'get_weather', input: {} },
      { type: 'tool_use', id: 'call_b', name: 'second', input: {} },
    ]);
    const json = ev.filter((e) => e.event === 'content_block_delta' && e.data.index === 1).map((e) => e.data.delta.partial_json).join('');
    expect(JSON.parse(json)).toEqual({ city: 'Rome' });
    expect(ev.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index)).toEqual([0, 1, 2]);
    expect(ev.at(-2)!.data.delta.stop_reason).toBe('tool_use');
  });

  it('reports upstream error events and ignores garbage lines', async () => {
    const ev = await events(translateStream(streamOf(`: keep-alive\n\ndata: not json\n\n${sseOf([{ error: { message: 'rate limited' } }])}`), 'm', 1));
    expect(ev.at(-1)).toEqual({ event: 'error', data: { type: 'error', error: { type: 'api_error', message: 'rate limited' } } });
  });
});

describe('POST /v1/messages', () => {
  const model = (id: string, tier: 'small' | 'large') => ({ id, tier, capabilities: ['chat' as const, 'tools' as const], limits: {}, quirks: [] });
  const registry: ProviderEntry[] = [
    { provider: 'p', base_url: 'https://p.test/v1', api_key_env: 'P_API_KEYS', auth: 'bearer', models: [model('tiny', 'small'), model('big', 'large')] },
  ];

  function setup(upstream: (body: Json) => Response) {
    const sent: Json[] = [];
    const db = openDatabase(':memory:');
    const app = createApp({
      registry,
      store: new TokenStore(db),
      envTokens: ['sk-ant-test'],
      pools: new Map([['p', new KeyPool(['k'])]]),
      fetch: vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as Json;
        sent.push(body);
        return upstream(body);
      }) as unknown as typeof fetch,
    });
    const post = (body: unknown, headers: Record<string, string> = { 'x-api-key': 'sk-ant-test' }) =>
      app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers }, body: JSON.stringify(body) });
    return { app, post, sent };
  }
  const base = { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
  const ok = () => Response.json({ choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } });

  it('answers in the Anthropic format, authenticating with x-api-key or Bearer', async () => {
    const { post, sent } = setup(ok);
    const res = await post({ ...base, model: 'claude-3-5-haiku-20241022' });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as Json;
    expect(msg).toMatchObject({ type: 'message', role: 'assistant', model: 'claude-3-5-haiku-20241022', stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 2 } });
    expect(msg.content).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(res.headers.get('x-pourgate-tier')).toBe('small'); // haiku -> auto:small
    expect(sent[0]!.model).toBe('tiny');
    const bearer = await post({ ...base, model: 'claude-opus-4' }, { authorization: 'Bearer sk-ant-test' });
    expect(bearer.status).toBe(200);
    expect(bearer.headers.get('x-pourgate-tier')).toBe('large');
  });

  it('returns Anthropic-shaped errors for auth, validation, unknown models and exhaustion', async () => {
    const { post } = setup(() => new Response('{}', { status: 500 }));
    const unauth = await post({ ...base, model: 'm' }, { 'x-api-key': 'wrong' });
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
    const bad = await post({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Json).error.message).toMatch(/max_tokens/);
    const unknown = await post({ ...base, model: 'does-not-exist' });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as Json).error.type).toBe('not_found_error');
    const exhausted = await post({ ...base, model: 'claude-sonnet-4' });
    expect(exhausted.status).toBe(503);
    expect(((await exhausted.json()) as Json).error.type).toBe('overloaded_error');
  });

  it('returns tool_use blocks for tool calls', async () => {
    const { post, sent } = setup(() =>
      Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'f', arguments: '{"x":1}' } }] }, finish_reason: 'tool_calls' }] }),
    );
    const res = await post({ ...base, model: 'big', tools: [{ name: 'f', input_schema: { type: 'object' } }] });
    const msg = (await res.json()) as Json;
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'f', input: { x: 1 } }]);
    expect(sent[0]!.tools).toHaveLength(1);
  });

  it('streams Anthropic events', async () => {
    const body = sseOf([{ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
    const { post } = setup(() => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const res = await post({ ...base, model: 'big', stream: true });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const ev = await events(res.body!);
    expect(ev[0]!.event).toBe('message_start');
    expect(ev.at(-1)!.event).toBe('message_stop');
    expect(ev.find((e) => e.event === 'content_block_delta')!.data.delta).toEqual({ type: 'text_delta', text: 'Hi' });
  });

  it('counts tokens approximately', async () => {
    const { app } = setup(ok);
    const res = await app.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'x-api-key': 'sk-ant-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(80) }] }),
    });
    expect(await res.json()).toEqual({ input_tokens: 20 });
  });
});
