import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { NativeBadRequest, geminiToChat, mapGeminiModel, ollamaChatToChat } from '../src/native-apis.js';
import { TokenStore } from '../src/tokens.js';

const entry: ProviderEntry = { provider: 'p', base_url: 'https://p.test/v1', api_key_env: 'P_API_KEYS', auth: 'bearer', models: [{ id: 'm1', capabilities: ['chat', 'tools'], limits: {}, quirks: [] }] };

function setup(ollama = true) {
  const seen: Record<string, any>[] = [];
  let upstream: (b: Record<string, any>) => Response = () => Response.json({});
  const fetcher = (async (_u: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    seen.push(b);
    return upstream(b);
  }) as typeof fetch;
  const app = createApp({ registry: [entry], store: new TokenStore(openDatabase(':memory:')), envTokens: ['pg'], pools: new Map([['p', new KeyPool(['key-aaaaaaaa'])]]), fetch: fetcher, ollama });
  return { app, seen, reply: (fn: (b: Record<string, any>) => Response) => (upstream = fn) };
}
const reply = (message: Record<string, unknown>, finish = 'stop') => Response.json({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: finish }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
const sse = (...chunks: unknown[]) => new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join(''), { headers: { 'content-type': 'text/event-stream' } });
const d = (delta: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
const post = (app: ReturnType<typeof setup>['app'], path: string, body: unknown, headers: Record<string, string> = { authorization: 'Bearer pg' }) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('gemini request translation', () => {
  it('maps contents, system instruction, generation config, images and tools', () => {
    const chat = geminiToChat(
      {
        systemInstruction: { parts: [{ text: 'be brief' }] },
        contents: [
          { role: 'user', parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] },
          { role: 'model', parts: [{ functionCall: { name: 'ls', args: { p: 1 } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'ls', response: { files: ['a'] } } }] },
        ],
        generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 50, stopSequences: ['x'], responseMimeType: 'application/json' },
        tools: [{ functionDeclarations: [{ name: 'ls', description: 'list', parameters: { type: 'object' } }] }],
      },
      'm1',
      true,
    ) as any;
    expect(chat.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(chat.messages[1].content[1].image_url.url).toBe('data:image/png;base64,AAAA');
    expect(chat.messages[2].tool_calls[0]).toMatchObject({ id: 'call_1', function: { name: 'ls', arguments: '{"p":1}' } });
    expect(chat.messages[3]).toMatchObject({ tool_call_id: 'call_1', content: '{"files":["a"]}' });
    expect(chat).toMatchObject({ temperature: 0.2, top_p: 0.9, max_tokens: 50, stop: ['x'], response_format: { type: 'json_object' }, stream: true });
    expect(chat.tools[0].function.name).toBe('ls');
    expect(() => geminiToChat({}, 'm', false)).toThrow(NativeBadRequest);
  });

  it('maps unknown Gemini names to a virtual model by size and keeps known ids', () => {
    const known = (id: string) => id === 'm1';
    expect(mapGeminiModel('models/m1', known)).toBe('m1');
    expect(mapGeminiModel('gemini-2.5-pro', known)).toBe('auto:large');
    expect(mapGeminiModel('gemini-2.5-flash', known)).toBe('auto:medium');
    expect(mapGeminiModel('gemini-2.5-flash-lite', known)).toBe('auto:small');
    expect(mapGeminiModel('auto:coding', known)).toBe('auto:coding');
    expect(mapGeminiModel('something-else', known)).toBe('something-else');
  });
});

describe('gemini endpoints', () => {
  it('answers generateContent with candidates and usage, accepting every key style', async () => {
    const { app, reply: r, seen } = setup();
    r(() => reply({ content: 'hello', tool_calls: [{ id: 'c', type: 'function', function: { name: 'ls', arguments: '{"a":1}' } }] }, 'tool_calls'));
    const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    for (const [path, headers] of [
      ['/v1beta/models/m1:generateContent', { 'x-goog-api-key': 'pg' }],
      ['/v1beta/models/m1:generateContent?key=pg', {}],
      ['/v1beta/models/m1:generateContent', { authorization: 'Bearer pg' }],
    ] as const) {
      const res = await post(app, path, body, headers);
      expect(res.status).toBe(200);
      const j = (await res.json()) as any;
      expect(j.candidates[0].content).toEqual({ role: 'model', parts: [{ text: 'hello' }, { functionCall: { name: 'ls', args: { a: 1 } } }] });
      expect(j.candidates[0].finishReason).toBe('STOP');
      expect(j.usageMetadata).toEqual({ promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 });
    }
    expect(seen[0]).toMatchObject({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] });
  });

  it('requires a valid key and reports errors in Gemini format', async () => {
    const { app, reply: r } = setup();
    const noKey = await post(app, '/v1beta/models/m1:generateContent', { contents: [] }, {});
    expect(noKey.status).toBe(401);
    expect(((await noKey.json()) as any).error.status).toBe('UNAUTHENTICATED');
    const bad = await post(app, '/v1beta/models/m1:generateContent', { contents: [] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.status).toBe('INVALID_ARGUMENT');
    r(() => new Response('down', { status: 502 }));
    const down = await post(app, '/v1beta/models/m1:generateContent', { contents: [{ role: 'user', parts: [{ text: 'x' }] }] });
    expect(down.status).toBe(503);
    expect(((await down.json()) as any).error.status).toBe('UNAVAILABLE');
    expect((await post(app, '/v1beta/models/m1:embedContent', {})).status).toBe(404);
  });

  it('streams SSE candidates ending with finishReason and usage, lists models, counts tokens', async () => {
    const { app, reply: r } = setup();
    r(() => sse(d({ content: 'He' }), d({ content: 'llo' }), d({}, 'length'), { choices: [], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } }));
    const res = await post(app, '/v1beta/models/m1:streamGenerateContent?alt=sse', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    const chunks = (await res.text()).split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    expect(chunks.map((c) => c.candidates[0].content.parts[0].text)).toEqual(['He', 'llo', '']);
    const last = chunks.at(-1);
    expect(last.candidates[0].finishReason).toBe('MAX_TOKENS');
    expect(last.usageMetadata.totalTokenCount).toBe(8);
    const models = (await (await app.request('/v1beta/models', { headers: { 'x-goog-api-key': 'pg' } })).json()) as any;
    expect(models.models.map((m: any) => m.name)).toContain('models/m1');
    const count = (await (await post(app, '/v1beta/models/m1:countTokens', { contents: [{ role: 'user', parts: [{ text: 'x'.repeat(40) }] }] })).json()) as any;
    expect(count.totalTokens).toBeGreaterThan(5);
  });
});

describe('ollama api', () => {
  it('translates chat and generate requests', () => {
    const chat = ollamaChatToChat({ model: 'm1', messages: [{ role: 'user', content: 'hi', images: ['AAAA'] }], options: { temperature: 0.1, num_predict: 30, stop: ['x'] }, format: 'json', stream: false }, false) as any;
    expect(chat).toMatchObject({ model: 'm1', temperature: 0.1, max_tokens: 30, stop: ['x'], response_format: { type: 'json_object' } });
    expect(chat.stream).toBeUndefined();
    expect(chat.messages[0].content[1].image_url.url).toContain('base64,AAAA');
    const gen = ollamaChatToChat({ model: 'm1', system: 's', prompt: 'p' }, true) as any;
    expect(gen.messages).toEqual([{ role: 'system', content: 's' }, { role: 'user', content: 'p' }]);
    expect(gen.stream).toBe(true); // Ollama streams unless told otherwise
    expect(() => ollamaChatToChat({ messages: [] }, false)).toThrow(NativeBadRequest);
  });

  it('answers /api/chat and /api/generate without streaming', async () => {
    const { app, reply: r } = setup();
    r(() => reply({ content: 'hi there' }));
    const chat = (await (await post(app, '/api/chat', { model: 'm1', messages: [{ role: 'user', content: 'x' }], stream: false })).json()) as any;
    expect(chat).toMatchObject({ model: 'm1', message: { role: 'assistant', content: 'hi there' }, done: true, done_reason: 'stop', prompt_eval_count: 4, eval_count: 2 });
    const gen = (await (await post(app, '/api/generate', { model: 'm1', prompt: 'x', stream: false })).json()) as any;
    expect(gen).toMatchObject({ response: 'hi there', done: true });
  });

  it('streams NDJSON by default and ends with a done line carrying counts', async () => {
    const { app, reply: r } = setup();
    r(() => sse(d({ content: 'a' }), d({ content: 'b' }), d({}, 'stop'), { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
    const res = await post(app, '/api/chat', { model: 'm1', messages: [{ role: 'user', content: 'x' }] });
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.message.content)).toEqual(['a', 'b', '']);
    expect(lines.map((l) => l.done)).toEqual([false, false, true]);
    expect(lines.at(-1)).toMatchObject({ done_reason: 'stop', prompt_eval_count: 1, eval_count: 2 });
  });

  it('lists tags, needs a token, and is absent unless enabled', async () => {
    const { app } = setup();
    const tags = (await (await app.request('/api/tags', { headers: { authorization: 'Bearer pg' } })).json()) as any;
    expect(tags.models.map((m: any) => m.name)).toEqual(expect.arrayContaining(['m1', 'auto', 'fusion']));
    expect((await app.request('/api/tags')).status).toBe(401);
    expect((await post(app, '/api/chat', { model: 'm1' })).status).toBe(400);
    const off = setup(false);
    expect((await off.app.request('/api/tags', { headers: { authorization: 'Bearer pg' } })).status).not.toBe(200);
  });
});
