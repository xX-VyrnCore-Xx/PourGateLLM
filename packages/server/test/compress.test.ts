import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { compressMessages, compressPayload, parseCompression, shorten, tidy } from '../src/compress.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { TokenStore } from '../src/tokens.js';

const light = { mode: 'light' as const };

describe('compression primitives', () => {
  it('tidies whitespace but leaves fenced code untouched', () => {
    expect(tidy('a  \n\n\n\nb')).toBe('a\n\nb');
    const code = '```\nx   \n\n\n\ny\n```';
    expect(tidy(`intro   \n\n\n${code}\n\n\n\nend`)).toBe(`intro\n\n${code}\n\nend`);
  });

  it('shortens by keeping head and tail with a marker of the exact omitted size', () => {
    const t = 'a'.repeat(100) + 'b'.repeat(100);
    const s = shorten(t, 100);
    expect(s).toContain('[… 100 characters omitted …]');
    expect(s.startsWith('a'.repeat(60))).toBe(true);
    expect(s.endsWith('b'.repeat(40))).toBe(true);
    expect(shorten('short', 100)).toBe('short');
  });

  it('parses the mode and defaults to off', () => {
    expect([parseCompression('light'), parseCompression('aggressive'), parseCompression('x'), parseCompression(undefined)]).toEqual(['light', 'aggressive', 'off', 'off']);
  });
});

describe('light compression', () => {
  const big = JSON.stringify({ rows: Array.from({ length: 30 }, (_, i) => ({ id: i, name: `n${i}` })) }, null, 2);

  it('minifies JSON, shortens huge tool output, drops duplicates and spares system and the last user message', () => {
    const msgs = [
      { role: 'system', content: 'sys   \n\n\n\nkept as is' },
      { role: 'user', content: 'look   \n\n\n\nat this' },
      { role: 'user', content: 'look   \n\n\n\nat this' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: big },
      { role: 'tool', tool_call_id: 'c2', content: 'x'.repeat(10_000) },
      { role: 'user', content: 'final   \n\n\n\nquestion' },
    ];
    const { messages, saved } = compressMessages(msgs, { ...light, toolOutputChars: 1000 });
    expect(saved).toBeGreaterThan(8000);
    expect(messages[0]).toBe(msgs[0]); // system untouched
    expect(messages.at(-1)).toBe(msgs.at(-1)); // last user message untouched
    expect(messages.filter((m) => m.role === 'user' && m.content === 'look\n\nat this')).toHaveLength(1);
    const tool1 = messages.find((m) => m.tool_call_id === 'c1')!;
    expect(JSON.parse(tool1.content as string).rows).toHaveLength(30);
    expect((tool1.content as string).includes('\n  ')).toBe(false);
    expect((messages.find((m) => m.tool_call_id === 'c2')!.content as string)).toContain('characters omitted');
    expect(messages.find((m) => m.tool_calls)).toBe(msgs[3]); // tool-call structure intact
  });

  it('does nothing in off mode or when there is nothing to gain', () => {
    const msgs = [{ role: 'user', content: 'hello' }];
    expect(compressMessages(msgs, { mode: 'off' })).toEqual({ messages: msgs, saved: 0 });
    const r = compressMessages(msgs, light);
    expect(r.messages).toBe(msgs);
    expect(r.saved).toBe(0);
  });

  it('fails open on malformed payloads', () => {
    const odd = { messages: [null, 5, { role: 'user' }] } as never;
    expect(compressPayload(odd, light).payload).toBe(odd);
    expect(compressPayload({ model: 'm' }, light).saved).toBe(0);
  });
});

describe('aggressive compression', () => {
  const turn = (i: number) => [{ role: 'user', content: `question ${i} ${'x'.repeat(2000)}` }, { role: 'assistant', content: `answer ${i} ${'y'.repeat(2000)}` }];
  const history = [{ role: 'system', content: 'sys' }, ...Array.from({ length: 12 }, (_, i) => turn(i)).flat(), { role: 'user', content: 'now?' }];

  it('replaces old turns with a marker once over budget, keeping system and the latest messages', () => {
    const { messages } = compressMessages(history, { mode: 'aggressive', historyChars: 10_000, keepLast: 4 });
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(messages[1]!.content).toMatch(/earlier messages were removed/);
    expect(messages.slice(-4)).toEqual(history.slice(-4));
    expect(messages.length).toBe(6);
  });

  it('does not cut a tool result away from its tool call', () => {
    const h = [
      ...Array.from({ length: 10 }, (_, i) => turn(i)).flat(),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'result' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'next' },
    ];
    const { messages } = compressMessages(h, { mode: 'aggressive', historyChars: 5000, keepLast: 3 });
    const i = messages.findIndex((m) => m.role === 'tool');
    expect(i).toBeGreaterThan(0);
    expect(messages[i - 1]!.tool_calls).toBeTruthy();
  });

  it('leaves short conversations alone', () => {
    const short = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
    expect(compressMessages(short, { mode: 'aggressive' }).messages).toBe(short);
  });
});

describe('compression through the gateway', () => {
  it('sends the shorter prompt upstream and reports the saving', async () => {
    const entry: ProviderEntry = { provider: 'p', base_url: 'https://p.test/v1', api_key_env: 'P_API_KEYS', auth: 'bearer', models: [{ id: 'm1', capabilities: ['chat'], limits: {}, quirks: [] }] };
    let sent: Record<string, any> = {};
    const fetcher = (async (_u: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
    }) as typeof fetch;
    const mk = (mode: 'off' | 'light') => createApp({ registry: [entry], store: new TokenStore(openDatabase(':memory:')), envTokens: ['pg'], pools: new Map([['p', new KeyPool(['key-aaaaaaaa'])]]), fetch: fetcher, compression: { mode } });
    const body = JSON.stringify({ model: 'm1', messages: [{ role: 'tool', tool_call_id: 'c', content: 'z'.repeat(9000) }, { role: 'user', content: 'sum it' }] });
    const call = (app: ReturnType<typeof mk>) => app.request('/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer pg', 'content-type': 'application/json' }, body });
    const on = await call(mk('light'));
    expect(on.status).toBe(200);
    expect(Number(on.headers.get('x-pourgate-compressed'))).toBeGreaterThan(4000);
    expect(String(sent.messages[0].content).length).toBeLessThan(5000);
    const off = await call(mk('off'));
    expect(off.headers.get('x-pourgate-compressed')).toBeNull();
    expect(String(sent.messages[0].content).length).toBe(9000);
  });
});
