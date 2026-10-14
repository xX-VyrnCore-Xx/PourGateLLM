import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { Metrics } from '../src/metrics.js';
import { observeResponse, type Finished } from '../src/observe.js';
import { RequestLog, percentile, type LogEntry } from '../src/requestlog.js';
import { TokenStore } from '../src/tokens.js';

const collect = (res: Response) => {
  const done: Finished[] = [];
  const out = observeResponse(res, performance.now(), (f) => done.push(f));
  return { out, done };
};

describe('observeResponse', () => {
  it('passes the body through and reads usage from small JSON bodies', async () => {
    const { out, done } = collect(Response.json({ usage: { total_tokens: 42 }, x: 'y' }));
    expect(await out.json()).toEqual({ usage: { total_tokens: 42 }, x: 'y' });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ tokens: 42, error: null });
  });

  it('flags HTTP errors and never calls back twice', async () => {
    const { out, done } = collect(Response.json({ error: 'x' }, { status: 503 }));
    await out.text();
    await out.body?.cancel().catch(() => {});
    expect(done).toHaveLength(1);
    expect(done[0]!.error).toBe('http_503');
  });

  it('reports a client abort when the stream is cancelled', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode('data: x\n\n'));
      },
    });
    const { out, done } = collect(new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }));
    const reader = out.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(done).toHaveLength(1);
    expect(done[0]!.error).toBe('client_aborted');
  });

  it('reports upstream stream errors', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error('boom'));
      },
    });
    const { out, done } = collect(new Response(upstream));
    await expect(out.text()).rejects.toThrow();
    expect(done[0]!.error).toBe('stream_error');
  });

  it('skips token parsing for bodies larger than the capture limit', async () => {
    const big = JSON.stringify({ usage: { total_tokens: 5 }, pad: 'x'.repeat(300 * 1024) });
    const { out, done } = collect(new Response(big, { headers: { 'content-type': 'application/json' } }));
    await out.text();
    expect(done[0]!.tokens).toBeNull();
  });
});

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  ts: Date.now(),
  tokenId: null,
  requested: 'auto',
  provider: 'groq',
  model: 'm1',
  tier: 'small',
  complexity: 'easy',
  status: 200,
  ttfbMs: 10,
  totalMs: 100,
  tokens: 10,
  redacted: null,
  stream: false,
  error: null,
  ...over,
});

describe('RequestLog', () => {
  it('computes percentiles', () => {
    expect(percentile([], 50)).toBeNull();
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
  });

  it('aggregates summary, per-model stats and a dense series', () => {
    const log = new RequestLog(openDatabase(':memory:'));
    const now = Date.now();
    for (const ms of [100, 200, 300, 400]) log.insert(entry({ totalMs: ms }));
    log.insert(entry({ status: 429, error: 'http_429', totalMs: 5, tokens: null }));
    log.insert(entry({ provider: 'gemini', model: 'g1', totalMs: 50, tokens: 1 }));
    const a = log.analytics(now - 3_600_000, 600_000);
    expect(a.summary).toMatchObject({ requests: 6, errors: 1, tokens: 41 });
    expect(a.summary.errorRate).toBeCloseTo(1 / 6);
    expect(a.summary.p50Ms).toBe(200); // successful requests only: 50,100,200,300,400
    const groq = a.byModel.find((m) => m.model === 'm1')!;
    expect(groq).toMatchObject({ requests: 5, errors: 1, tokens: 40, p95Ms: 400 });
    expect(a.byModel[0]!.model).toBe('m1'); // sorted by volume
    expect(a.series.length).toBeGreaterThanOrEqual(6);
    expect(a.series.reduce((n, p) => n + p.requests, 0)).toBe(6);
  });

  it('lists recent entries, exports since a time and prunes old rows', () => {
    const log = new RequestLog(openDatabase(':memory:'));
    log.insert(entry({ ts: 1_000, requested: 'old' }));
    log.insert(entry({ ts: 5_000, requested: 'new' }));
    expect(log.recent(1)[0]!.requested).toBe('new');
    expect(log.since(2_000).map((e) => e.requested)).toEqual(['new']);
    log.prune(2_000);
    expect(log.recent().map((e) => e.requested)).toEqual(['new']);
  });
});

describe('Metrics', () => {
  it('renders counters, a cumulative histogram and gauges', () => {
    const m = new Metrics();
    m.observe({ provider: 'groq', model: 'm1', status: 200, complexity: 'easy', seconds: 0.2, tokens: 10 });
    m.observe({ provider: 'groq', model: 'm1', status: 503, complexity: 'easy', seconds: 3, tokens: null });
    const text = m.render([{ name: 'pourgate_keys', help: 'k', samples: [{ labels: { provider: 'groq' }, value: 2 }] }]);
    expect(text).toContain('pourgate_requests_total{provider="groq",model="m1",status="2xx",complexity="easy"} 1');
    expect(text).toContain('status="5xx"');
    expect(text).toContain('pourgate_tokens_total{provider="groq",model="m1"} 10');
    expect(text).toContain('pourgate_request_duration_seconds_bucket{provider="groq",model="m1",le="0.25"} 1');
    expect(text).toContain('pourgate_request_duration_seconds_bucket{provider="groq",model="m1",le="5"} 2');
    expect(text).toContain('pourgate_request_duration_seconds_count{provider="groq",model="m1"} 2');
    expect(text).toContain('pourgate_keys{provider="groq"} 2');
  });
});

describe('gateway observability', () => {
  const registry: ProviderEntry[] = [
    {
      provider: 'groq',
      base_url: 'https://up.test/v1',
      api_key_env: 'GROQ_API_KEYS',
      auth: 'bearer',
      models: [{ id: 'm1', capabilities: ['chat'], limits: {}, quirks: [] }],
    },
  ];
  const json = { 'content-type': 'application/json' };

  function setup(metricsToken?: string) {
    const db = openDatabase(':memory:');
    const requestLog = new RequestLog(db);
    const app = createApp({
      registry,
      store: new TokenStore(db),
      envTokens: ['pg'],
      pools: new Map([['groq', new KeyPool(['k1'])]]),
      fetch: (async () => Response.json({ usage: { total_tokens: 7 } })) as unknown as typeof fetch,
      requestLog,
      metrics: new Metrics(),
      metricsToken,
      adminPassword: 'pw',
    });
    const chat = async (text = 'my secret prompt') => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { ...json, authorization: 'Bearer pg' },
        body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: text }] }),
      });
      await res.text(); // consume the body so the observer finishes
      return res;
    };
    return { app, requestLog, chat };
  }

  async function cookie(app: ReturnType<typeof setup>['app']) {
    const r = await app.request('/admin/api/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'pw' }) });
    return r.headers.get('set-cookie')!.split(';')[0]!;
  }

  it('logs metadata (never prompts) for each request', async () => {
    const { requestLog, chat } = setup();
    await chat('my secret prompt');
    const [row] = requestLog.recent();
    expect(row).toMatchObject({ requested: 'm1', provider: 'groq', model: 'm1', status: 200, tokens: 7, stream: false, error: null });
    expect(JSON.stringify(requestLog.recent())).not.toContain('secret');
  });

  it('serves /metrics only with the right token, and only when configured', async () => {
    const { app, chat } = setup('mtoken');
    await chat();
    expect((await app.request('/metrics')).status).toBe(401);
    expect((await app.request('/metrics', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    const ok = await app.request('/metrics', { headers: { authorization: 'Bearer mtoken' } });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).toContain('pourgate_requests_total{provider="groq",model="m1",status="2xx",complexity="none"} 1');
    expect(text).toContain('pourgate_keys{provider="groq"} 1');
    const off = setup();
    expect((await off.app.request('/metrics')).status).toBe(404);
  });

  it('exposes analytics and a JSONL export to admins only', async () => {
    const { app, chat } = setup();
    await chat();
    expect((await app.request('/admin/api/analytics')).status).toBe(401);
    expect((await app.request('/admin/api/requests.jsonl')).status).toBe(401);
    const c = await cookie(app);
    const a = (await (await app.request('/admin/api/analytics?range=24h', { headers: { cookie: c } })).json()) as { summary: { requests: number } };
    expect(a.summary.requests).toBe(1);
    expect((await app.request('/admin/api/analytics?range=1y', { headers: { cookie: c } })).status).toBe(400);
    const jsonl = await app.request('/admin/api/requests.jsonl', { headers: { cookie: c } });
    expect(jsonl.headers.get('content-type')).toContain('ndjson');
    const lines = (await jsonl.text()).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).model).toBe('m1');
  });
});
