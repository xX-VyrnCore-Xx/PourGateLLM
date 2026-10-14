import { describe, expect, it, vi } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { Tracer, parseHeaders, parseTraceparent, type SpanData } from '../src/otel.js';
import { TokenStore } from '../src/tokens.js';

type Json = Record<string, any>;

const span = (over: Partial<SpanData> = {}): SpanData => ({
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  name: 's',
  kind: 2,
  startMs: 1_700_000_000_000,
  endMs: 1_700_000_000_250,
  attributes: {},
  ...over,
});

describe('helpers', () => {
  it('parses W3C traceparent strictly', () => {
    expect(parseTraceparent(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`)).toEqual({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) });
    expect(parseTraceparent(`00-${'A'.repeat(32)}-${'B'.repeat(16)}-00`)).toBeDefined(); // case-insensitive
    for (const bad of [undefined, '', 'garbage', `00-${'a'.repeat(31)}-${'b'.repeat(16)}-01`, `00-${'0'.repeat(32)}-${'b'.repeat(16)}-01`, `00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`, `01-${'a'.repeat(32)}-${'b'.repeat(16)}-01`]) {
      expect(parseTraceparent(bad), String(bad)).toBeUndefined();
    }
  });

  it('parses OTLP header lists', () => {
    expect(parseHeaders('Authorization=Bearer x, x-team = core ,bad')).toEqual({ Authorization: 'Bearer x', 'x-team': 'core' });
    expect(parseHeaders(undefined)).toEqual({});
  });
});

describe('Tracer', () => {
  const make = (fetchImpl: typeof fetch, extra = {}) => new Tracer({ endpoint: 'http://collector:4318', fetch: fetchImpl, flushIntervalMs: 3_600_000, ...extra });

  it('posts OTLP/HTTP JSON with resource, timestamps in nanoseconds and typed attributes', async () => {
    const f = vi.fn(async () => new Response('{}'));
    const t = make(f as unknown as typeof fetch, { headers: { 'x-key': 'v' }, serviceName: 'svc' });
    t.record(span({ parentSpanId: 'c'.repeat(16), attributes: { s: 'str', i: 3, d: 1.5, b: true, skip: null, skip2: undefined }, error: 'http_500' }));
    await t.flush();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://collector:4318/v1/traces');
    expect((init.headers as Record<string, string>)['x-key']).toBe('v');
    const body = JSON.parse(init.body as string) as Json;
    expect(body.resourceSpans[0].resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'svc' } }]);
    const s = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(s).toMatchObject({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16), name: 's', kind: 2, status: { code: 2, message: 'http_500' } });
    expect(s.startTimeUnixNano).toBe('1700000000000000000');
    expect(s.endTimeUnixNano).toBe('1700000000250000000');
    expect(s.attributes).toEqual([
      { key: 's', value: { stringValue: 'str' } },
      { key: 'i', value: { intValue: '3' } },
      { key: 'd', value: { doubleValue: 1.5 } },
      { key: 'b', value: { boolValue: true } },
    ]);
    await t.flush(); // nothing left to send
    expect(f).toHaveBeenCalledTimes(1);
    await t.shutdown();
  });

  it('does not double the path when the endpoint already ends with /v1/traces', async () => {
    const f = vi.fn(async () => new Response('{}'));
    const t = make(f as unknown as typeof fetch, { endpoint: 'https://otel.example/v1/traces/' });
    t.record(span());
    await t.flush();
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://otel.example/v1/traces');
    await t.shutdown();
  });

  it('flushes when a batch fills, drops the oldest spans beyond the queue cap, and survives export failures', async () => {
    const f = vi.fn(async () => {
      throw new Error('down');
    });
    const t = make(f as unknown as typeof fetch, { maxBatch: 1000, maxQueue: 3 });
    for (let i = 0; i < 5; i++) t.record(span({ name: `s${i}` }));
    expect(t.dropped).toBe(2);
    await expect(t.flush()).resolves.toBeUndefined();
    const batchFetch = vi.fn(async () => new Response('{}'));
    const b = make(batchFetch as unknown as typeof fetch, { maxBatch: 2 });
    b.record(span());
    b.record(span());
    await vi.waitFor(() => expect(batchFetch).toHaveBeenCalledTimes(1));
    await t.shutdown();
    await b.shutdown();
  });
});

describe('gateway tracing', () => {
  const registry: ProviderEntry[] = [
    { provider: 'p', base_url: 'https://p.test/v1', api_key_env: 'P_API_KEYS', auth: 'bearer', models: [{ id: 'm1', capabilities: ['chat'], limits: {}, quirks: [] }] },
  ];

  function setup(upstream: (n: number) => Response) {
    const exported: Json[] = [];
    const tracer = new Tracer({
      endpoint: 'http://collector',
      flushIntervalMs: 3_600_000,
      fetch: (async (_u: string, init: RequestInit) => {
        exported.push(...(JSON.parse(init.body as string) as Json).resourceSpans[0].scopeSpans[0].spans);
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    let n = 0;
    const app = createApp({
      registry,
      store: new TokenStore(openDatabase(':memory:')),
      envTokens: ['pg'],
      pools: new Map([['p', new KeyPool(['k1', 'k2'])]]),
      fetch: (async () => upstream(n++)) as unknown as typeof fetch,
      tracer,
    });
    const chat = async (headers: Record<string, string> = {}) => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer pg', 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'my private prompt' }] }),
      });
      await res.text();
      await tracer.flush();
      return res;
    };
    return { chat, exported };
  }

  const attrs = (s: Json) => Object.fromEntries((s.attributes as Json[]).map((a) => [a.key, Object.values(a.value)[0]]));

  it('emits a server span with an upstream child per attempt, without prompt content', async () => {
    const { chat, exported } = setup((n) => (n === 0 ? new Response('{}', { status: 429 }) : Response.json({ usage: { total_tokens: 12 } })));
    const res = await chat();
    expect(exported).toHaveLength(3); // two upstream attempts (429, then 200) + the server span
    const server = exported.find((s) => s.kind === 2)!;
    const children = exported.filter((s) => s.kind === 3);
    expect(server.name).toBe('POST /v1/chat/completions');
    expect(children.map((c) => attrs(c)['http.response.status_code'])).toEqual(['429', '200']);
    expect(children.every((c) => c.parentSpanId === server.spanId && c.traceId === server.traceId)).toBe(true);
    expect(children[0]!.status.code).toBe(2);
    expect(attrs(server)).toMatchObject({ 'gen_ai.request.model': 'm1', 'gen_ai.response.model': 'm1', 'gen_ai.system': 'p', 'http.response.status_code': '200', 'pourgate.tokens': '12' });
    expect(res.headers.get('x-pourgate-trace-id')).toBe(server.traceId);
    expect(JSON.stringify(exported)).not.toContain('private prompt');
  });

  it('continues a caller trace from traceparent and marks failures', async () => {
    const { chat, exported } = setup(() => new Response('{}', { status: 500 }));
    const traceId = 'd'.repeat(32);
    const res = await chat({ traceparent: `00-${traceId}-${'e'.repeat(16)}-01` });
    expect(res.status).toBe(503);
    const server = exported.find((s) => s.kind === 2)!;
    expect(server.traceId).toBe(traceId);
    expect(server.parentSpanId).toBe('e'.repeat(16));
    expect(server.status.code).toBe(2);
    expect(exported.filter((s) => s.kind === 3)).toHaveLength(2); // both keys tried
  });
});
