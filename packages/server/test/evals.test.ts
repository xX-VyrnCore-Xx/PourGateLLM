import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import {
  EvalRunner,
  EvalStore,
  checkAnswer,
  loadSuite,
  parseStrategy,
  rankScore,
  type EvalResult,
  type EvalTask,
  type ModelScore,
} from '../src/evals.js';
import { KeyPool } from '../src/keypool.js';
import { TokenStore } from '../src/tokens.js';

const task = (check: EvalTask['check'], id = 't'): EvalTask => ({ id, category: 'c', prompt: 'p', check });

describe('shipped suite', () => {
  it('is valid, has unique ids and compilable patterns', () => {
    const tasks = loadSuite(resolve(__dirname, '../../../evals/suite.json'));
    expect(tasks.length).toBeGreaterThanOrEqual(20);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
  });
});

describe('checkAnswer', () => {
  it('equals ignores case, quotes and trailing punctuation unless case-sensitive', () => {
    expect(checkAnswer(task({ type: 'equals', value: 'Au' }), ' "au". ')).toBe(true);
    expect(checkAnswer(task({ type: 'equals', value: 'Au' }), 'gold')).toBe(false);
    expect(checkAnswer(task({ type: 'equals', value: 'PONG', caseSensitive: true }), 'PONG')).toBe(true);
    expect(checkAnswer(task({ type: 'equals', value: 'PONG', caseSensitive: true }), 'pong')).toBe(false);
  });

  it('includes / includesAll / regex', () => {
    expect(checkAnswer(task({ type: 'includes', value: ['canberra'] }), 'It is Canberra.')).toBe(true);
    expect(checkAnswer(task({ type: 'includes', value: ['canberra'] }), 'Sydney')).toBe(false);
    expect(checkAnswer(task({ type: 'includesAll', value: ['red', 'blue'] }), 'red, green, blue')).toBe(true);
    expect(checkAnswer(task({ type: 'includesAll', value: ['red', 'blue'] }), 'red, green')).toBe(false);
    expect(checkAnswer(task({ type: 'regex', value: '\\b391\\b' }), 'The answer is 391')).toBe(true);
    expect(checkAnswer(task({ type: 'regex', value: '\\b391\\b' }), '3910')).toBe(false);
  });

  it('json compares the expected keys and tolerates fences and chatter', () => {
    const t = task({ type: 'json', value: { name: 'Ada', age: 36 } });
    expect(checkAnswer(t, '{"name":"Ada","age":36}')).toBe(true);
    expect(checkAnswer(t, '```json\n{"name": "Ada", "age": 36, "extra": 1}\n```')).toBe(true);
    expect(checkAnswer(t, 'Sure! {"name":"Ada","age":36} Hope that helps')).toBe(true);
    expect(checkAnswer(t, '{"name":"Ada","age":"36"}')).toBe(false);
    expect(checkAnswer(t, 'not json')).toBe(false);
  });
});

describe('scoring', () => {
  const score = (over: Partial<ModelScore> = {}): ModelScore => ({
    provider: 'p',
    model: 'm',
    samples: 10,
    quality: 0.9,
    reliability: 1,
    p50Ms: 1000,
    lastRun: 0,
    ...over,
  });

  it('parses strategies', () => {
    expect(parseStrategy(undefined)).toBe('spread');
    expect(parseStrategy('Balanced')).toBe('balanced');
    expect(() => parseStrategy('x')).toThrow();
  });

  it('ranks by strategy and treats thin data as neutral', () => {
    expect(rankScore('spread', score())).toBe(0.5);
    expect(rankScore('quality', score({ samples: 2 }))).toBe(0.5);
    expect(rankScore('quality', undefined)).toBe(0.5);
    expect(rankScore('quality', score({ quality: 0.9 }))).toBeGreaterThan(rankScore('quality', score({ quality: 0.4 })));
    expect(rankScore('speed', score({ p50Ms: 200 }))).toBeGreaterThan(rankScore('speed', score({ p50Ms: 4000 })));
    expect(rankScore('balanced', score({ reliability: 0.5 }))).toBeLessThan(rankScore('balanced', score({ reliability: 1 })));
  });
});

describe('EvalStore', () => {
  it('aggregates quality, reliability and median latency inside the window', () => {
    let now = 10 * 86_400_000;
    const store = new EvalStore(openDatabase(':memory:'), () => now);
    const row = (over: Partial<EvalResult>): EvalResult => ({ ts: now, provider: 'p', model: 'm', taskId: 't', passed: true, latencyMs: 100, error: null, ...over });
    store.insert([
      row({ latencyMs: 100 }),
      row({ latencyMs: 300 }),
      row({ passed: false, latencyMs: 50 }),
      row({ passed: false, error: 'http_429', latencyMs: 5 }),
      row({ ts: now - 20 * 86_400_000, passed: false }), // outside the 14 day window
    ]);
    const [s] = store.scores();
    expect(s).toMatchObject({ provider: 'p', model: 'm', samples: 4 });
    expect(s!.quality).toBeCloseTo(2 / 3);
    expect(s!.reliability).toBeCloseTo(3 / 4);
    expect(s!.p50Ms).toBe(100);
    store.prune(now - 86_400_000);
    now += 1;
    expect(store.scores(30)).toHaveLength(1);
  });
});

describe('EvalRunner', () => {
  const registry: ProviderEntry[] = [
    {
      provider: 'p1',
      base_url: 'https://p1.test/v1',
      api_key_env: 'P1_API_KEYS',
      auth: 'bearer',
      models: [{ id: 'm1', capabilities: ['chat'], limits: {}, quirks: [] }],
    },
    {
      provider: 'p2',
      base_url: 'https://p2.test/v1',
      api_key_env: 'P2_API_KEYS',
      auth: 'bearer',
      models: [{ id: 'm2', capabilities: ['chat'], limits: { rpd: 1 }, quirks: [] }],
    },
  ];
  const suite: EvalTask[] = [
    { id: 'a', category: 'x', prompt: 'say a', check: { type: 'equals', value: 'a' } },
    { id: 'b', category: 'x', prompt: 'say b', check: { type: 'equals', value: 'b' } },
    { id: 'c', category: 'x', prompt: 'say c', check: { type: 'equals', value: 'c' } },
  ];
  const answer = (content: string) => Response.json({ choices: [{ message: { content } }], usage: { total_tokens: 5 } });

  function setup(fetchImpl: typeof fetch, pools?: Map<string, KeyPool>, now = () => 3_600_000 * 100) {
    const store = new EvalStore(openDatabase(':memory:'), now);
    const poolMap = pools ?? new Map([['p1', new KeyPool(['k1'])], ['p2', new KeyPool(['k2'])]]);
    const runner = new EvalRunner({ suite, store, registry: () => registry, pools: () => poolMap, fetch: fetchImpl, now });
    return { runner, store, poolMap };
  }

  it('records passes and failures, scoring each model', async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const prompt = (JSON.parse(init.body as string) as { messages: { content: string }[] }).messages[0]!.content;
      return answer(prompt.replace('say ', ''));
    });
    const { runner, store } = setup(f as unknown as typeof fetch);
    const summary = await runner.run({ tasksPerModel: 1, models: ['m1'] });
    expect(summary).toMatchObject({ models: 1, attempts: 1 });
    expect(store.scores()[0]).toMatchObject({ model: 'm1', quality: 1 });
    const wrong = setup((async () => answer('zzz')) as unknown as typeof fetch);
    await wrong.runner.run({ tasksPerModel: 3 });
    expect(wrong.store.scores().every((s) => s.quality === 0)).toBe(true);
  });

  it('sends deterministic requests with the right key and model', async () => {
    const f = vi.fn(async () => answer('a'));
    const { runner } = setup(f as unknown as typeof fetch);
    await runner.run({ tasksPerModel: 1, models: ['m1'] });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://p1.test/v1/chat/completions');
    const body = JSON.parse(init.body as string) as { model: string; temperature: number };
    expect(body).toMatchObject({ model: 'm1', temperature: 0 });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k1');
  });

  it('records HTTP errors, cools down rate-limited keys and flags empty answers', async () => {
    const limited = setup((async () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } })) as unknown as typeof fetch);
    await limited.runner.run({ tasksPerModel: 2, models: ['m1'] });
    const [s] = limited.store.scores();
    expect(s).toMatchObject({ reliability: 0, quality: 0 });
    expect(limited.poolMap.get('p1')!.coolingCount()).toBe(1);
    const empty = setup((async () => answer('')) as unknown as typeof fetch);
    await empty.runner.run({ tasksPerModel: 1, models: ['m1'] });
    expect(empty.store.scores()[0]!.reliability).toBe(0);
  });

  it('respects key limits and skips models without keys', async () => {
    const f = vi.fn(async () => answer('a'));
    const { runner } = setup(f as unknown as typeof fetch, new Map([['p2', new KeyPool(['k2'])]]));
    const summary = await runner.run({ tasksPerModel: 3 });
    expect(f).toHaveBeenCalledTimes(1); // m2 has rpd: 1
    expect(summary.skipped.join()).toMatch(/m1: no API key/);
    expect(summary.skipped.join()).toMatch(/m2: no key with budget/);
  });

  it('rotates through the suite across hours and refuses concurrent runs', async () => {
    const seen: string[] = [];
    let hour = 100;
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      seen.push((JSON.parse(init.body as string) as { messages: { content: string }[] }).messages[0]!.content);
      await new Promise((r) => setTimeout(r, 20));
      return answer('a');
    });
    const { runner } = setup(f as unknown as typeof fetch, undefined, () => hour * 3_600_000);
    await runner.run({ tasksPerModel: 1, models: ['m1'] });
    hour = 101;
    await runner.run({ tasksPerModel: 1, models: ['m1'] });
    expect(new Set(seen).size).toBe(2);
    const first = runner.run({ tasksPerModel: 1, models: ['m1'] });
    await expect(runner.run({ tasksPerModel: 1 })).rejects.toThrow(/already in progress/);
    await first;
  });
});

describe('score-aware routing and admin API', () => {
  const model = (id: string) => ({ id, tier: 'large' as const, capabilities: ['chat' as const], limits: {}, quirks: [] });
  const registry: ProviderEntry[] = [
    { provider: 'pa', base_url: 'https://pa.test/v1', api_key_env: 'PA_API_KEYS', auth: 'bearer', models: [model('weak')] },
    { provider: 'pb', base_url: 'https://pb.test/v1', api_key_env: 'PB_API_KEYS', auth: 'bearer', models: [model('strong')] },
  ];
  const scores: Record<string, ModelScore> = {
    'pa|weak': { provider: 'pa', model: 'weak', samples: 10, quality: 0.3, reliability: 1, p50Ms: 500, lastRun: 0 },
    'pb|strong': { provider: 'pb', model: 'strong', samples: 10, quality: 0.95, reliability: 1, p50Ms: 900, lastRun: 0 },
  };

  function setup(strategy: 'spread' | 'quality') {
    const served: string[] = [];
    const db = openDatabase(':memory:');
    const app = createApp({
      registry,
      store: new TokenStore(db),
      envTokens: ['pg'],
      pools: new Map([['pa', new KeyPool(['k'])], ['pb', new KeyPool(['k'])]]),
      fetch: (async (_u: string, init: RequestInit) => {
        served.push((JSON.parse(init.body as string) as { model: string }).model);
        return Response.json({ ok: true });
      }) as unknown as typeof fetch,
      scoring: { strategy, score: (p, m) => scores[`${p}|${m}`] },
      adminPassword: 'pw',
    });
    const chat = async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer pg', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
      });
      await res.text();
    };
    return { app, served, chat };
  }

  it('prefers the higher-quality model within a tier under the quality strategy', async () => {
    const { served, chat } = setup('quality');
    await chat();
    await chat();
    expect(served).toEqual(['strong', 'strong']);
  });

  it('ignores scores under the spread strategy', async () => {
    const { served, chat } = setup('spread');
    await chat();
    await chat();
    expect(served).toEqual(['weak', 'strong']); // least-used first, registry order on ties
  });

  it('reports disabled evals and requires a session', async () => {
    const { app } = setup('spread');
    expect((await app.request('/admin/api/evals')).status).toBe(401);
    const login = await app.request('/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect(await (await app.request('/admin/api/evals', { headers: { cookie } })).json()).toEqual({ enabled: false });
    expect((await app.request('/admin/api/evals/run', { method: 'POST', headers: { cookie } })).status).toBe(404);
  });

  it('starts an eval run (202) and rejects a second one while running (409)', async () => {
    const db = openDatabase(':memory:');
    const store = new EvalStore(db);
    const suite: EvalTask[] = [{ id: 'a', category: 'x', prompt: 'p', check: { type: 'equals', value: 'a' } }];
    const runner = new EvalRunner({
      suite,
      store,
      registry: () => registry,
      pools: () => new Map([['pa', new KeyPool(['k'])]]),
      fetch: (async () => {
        await new Promise((r) => setTimeout(r, 50));
        return Response.json({ choices: [{ message: { content: 'a' } }] });
      }) as unknown as typeof fetch,
    });
    const app = createApp({
      registry,
      store: new TokenStore(db),
      pools: new Map(),
      adminPassword: 'pw',
      evals: { runner, store, strategy: 'quality', tasksPerModel: 1, tasks: 1 },
    });
    const login = await app.request('/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const first = await app.request('/admin/api/evals/run', { method: 'POST', headers: { cookie } });
    expect(first.status).toBe(202);
    expect((await app.request('/admin/api/evals/run', { method: 'POST', headers: { cookie } })).status).toBe(409);
    await vi.waitFor(() => expect(runner.running).toBe(false));
    const info = (await (await app.request('/admin/api/evals', { headers: { cookie } })).json()) as { enabled: boolean; strategy: string; lastRun: { attempts: number }; scores: unknown[] };
    expect(info).toMatchObject({ enabled: true, strategy: 'quality' });
    expect(info.lastRun.attempts).toBe(1);
    expect(info.scores).toHaveLength(1);
  });
});
