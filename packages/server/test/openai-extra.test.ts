import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { TokenStore } from '../src/tokens.js';
import { BadRequest, completionsToChat, responsesToChat } from '../src/openai-extra.js';

const entry: ProviderEntry = {
  provider: 'p',
  base_url: 'https://p.test/v1',
  api_key_env: 'P_API_KEYS',
  auth: 'bearer',
  models: [{ id: 'm1', capabilities: ['chat', 'tools'], limits: {}, quirks: [] }],
};

const sse = (...chunks: unknown[]) =>
  new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join(''), { headers: { 'content-type': 'text/event-stream' } });

function setup(upstream: (body: Record<string, unknown>) => Response) {
  const seen: Record<string, unknown>[] = [];
  const fetcher = (async (_u: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push(body);
    return upstream(body);
  }) as typeof fetch;
  const app = createApp({ registry: [entry], store: new TokenStore(openDatabase(':memory:')), envTokens: ['pg'], pools: new Map([['p', new KeyPool(['key-aaaaaaaa'])]]), fetch: fetcher });
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { authorization: 'Bearer pg', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { post, seen };
}

const chatReply = (message: Record<string, unknown>, finish = 'stop') =>
  Response.json({ id: 'chatcmpl-1', created: 5, choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });

const events = async (res: Response) =>
  (await res.text())
    .split('\n\n')
    .filter((b) => b.startsWith('event:'))
    .map((b) => ({ type: b.split('\n')[0]!.slice(7), data: JSON.parse(b.split('\n')[1]!.slice(6)) as Record<string, any> }));

describe('/v1/completions', () => {
  it('translates a legacy completion, including the fill-in-the-middle suffix', async () => {
    const { post, seen } = setup(() => chatReply({ content: ' world' }));
    const res = await post('/v1/completions', { model: 'm1', prompt: 'hello', suffix: '!', max_tokens: 7, stop: ['\n'], temperature: 0 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ object: 'text_completion', model: 'm1', choices: [{ text: ' world', index: 0, finish_reason: 'stop' }], usage: { total_tokens: 5 } });
    expect(body.id).toMatch(/^cmpl/);
    expect(seen[0]).toMatchObject({ max_tokens: 7, stop: ['\n'], temperature: 0 });
    expect((seen[0]!.messages as any[])[1].content).toContain('PREFIX:\nhello');
  });

  it('streams text_completion chunks and ends with [DONE]', async () => {
    const delta = (content: string, finish: string | null = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] });
    const { post } = setup(() => sse(delta('a'), delta('b'), delta('', 'stop'), { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
    const text = await (await post('/v1/completions', { model: 'm1', prompt: 'x', stream: true })).text();
    const chunks = text.split('\n\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(6)));
    expect(chunks.map((c) => c.choices[0]?.text).filter((t) => t !== undefined)).toEqual(['a', 'b', '']);
    expect(chunks.find((c) => c.choices[0]?.finish_reason === 'stop')).toBeTruthy();
    expect(chunks.at(-1).usage.total_tokens).toBe(3);
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('rejects batched prompts and passes upstream errors through', () => {
    expect(() => completionsToChat({ model: 'm', prompt: ['a', 'b'] })).toThrow(BadRequest);
    expect(() => completionsToChat({ model: 'm', prompt: 'a', n: 2 })).toThrow(BadRequest);
  });
});

describe('/v1/responses', () => {
  it('translates input items, tools and structured output into a chat request', () => {
    const chat = responsesToChat({
      model: 'm1',
      instructions: 'be brief',
      max_output_tokens: 50,
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'https://x/y.png' }] },
        { type: 'function_call', call_id: 'c1', name: 'ls', arguments: '{"p":1}' },
        { type: 'function_call_output', call_id: 'c1', output: 'file.txt' },
      ],
      tools: [{ type: 'function', name: 'ls', description: 'list', parameters: { type: 'object', properties: {} } }, { type: 'web_search' }],
      tool_choice: { type: 'function', name: 'ls' },
      text: { format: { type: 'json_schema', name: 'o', schema: { type: 'object' } } },
    });
    expect(chat.max_tokens).toBe(50);
    expect((chat.messages as any[]).map((m) => m.role)).toEqual(['system', 'system', 'user', 'assistant', 'tool']);
    expect((chat.messages as any[])[2].content[1]).toEqual({ type: 'image_url', image_url: { url: 'https://x/y.png' } });
    expect((chat.messages as any[])[3].tool_calls[0].function).toEqual({ name: 'ls', arguments: '{"p":1}' });
    expect((chat.tools as any[]).length).toBe(1);
    expect(chat.tool_choice).toEqual({ type: 'function', function: { name: 'ls' } });
    expect((chat.response_format as any).json_schema.name).toBe('o');
    expect(() => responsesToChat({ model: 'm', input: 'x', previous_response_id: 'resp_1' })).toThrow(/not supported/);
    expect(() => responsesToChat({ model: 'm' })).toThrow(BadRequest);
  });

  it('returns a response object with text and tool calls', async () => {
    const { post } = setup(() => chatReply({ content: 'ok', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{}' } }] }, 'tool_calls'));
    const res = await post('/v1/responses', { model: 'm1', input: 'hi' });
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ object: 'response', status: 'completed', model: 'm1', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } });
    expect(body.output[0]).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] });
    expect(body.output[1]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'ls', arguments: '{}' });
  });

  it('marks a truncated answer as incomplete', async () => {
    const { post } = setup(() => chatReply({ content: 'cut' }, 'length'));
    const body = (await (await post('/v1/responses', { model: 'm1', input: 'hi' })).json()) as any;
    expect(body).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
  });

  it('streams the documented event sequence for text then a tool call', async () => {
    const d = (delta: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
    const { post } = setup(() =>
      sse(
        d({ content: 'He' }),
        d({ content: 'llo' }),
        d({ tool_calls: [{ index: 0, id: 'call_9', function: { name: 'ls', arguments: '{"a"' } }] }),
        d({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
        d({}, 'tool_calls'),
        { choices: [], usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } },
      ),
    );
    const ev = await events(await post('/v1/responses', { model: 'm1', input: 'hi', stream: true }));
    expect(ev.map((e) => e.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(ev.map((e) => e.data.sequence_number)).toEqual(ev.map((_, i) => i));
    expect(ev.find((e) => e.type === 'response.output_text.done')!.data.text).toBe('Hello');
    const done = ev.at(-1)!.data.response;
    expect(done.status).toBe('completed');
    expect(done.output.map((o: any) => o.type)).toEqual(['message', 'function_call']);
    expect(done.output[1]).toMatchObject({ call_id: 'call_9', name: 'ls', arguments: '{"a":1}' });
    expect(done.usage.total_tokens).toBe(10);
  });

  it('rejects malformed bodies with an OpenAI-style error', async () => {
    const { post } = setup(() => chatReply({ content: 'x' }));
    const res = await post('/v1/responses', { model: 'm1', input: 5 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.message).toMatch(/input/);
  });
});
