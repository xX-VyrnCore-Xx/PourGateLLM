import { describe, expect, it, vi } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { ResponseCache } from '../src/cache.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { RequestLog } from '../src/requestlog.js';
import { SemanticIndex, contextHash, dot, lastUserText, normalize } from '../src/semantic.js';
import { TokenStore } from '../src/tokens.js';

type Json = Record<string, any>;

describe('helpers', () => {
  it('extracts the last user text from strings and content parts', () => {
    expect(lastUserText({ messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'x' }, { role: 'user', content: '  second ' }] })).toBe('second');
    expect(lastUserText({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url' }, { type: 'text', text: 'b' }] }] })).toBe('a\nb');
    expect(lastUserText({ messages: [{ role: 'system', content: 's' }] })).toBe('');
    expect(lastUserText({})).toBe('');
  });

  it('hashes the context without the last user message', () => {
    const base = { model: 'm', temperature: 0, messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'What is the capital of France?' }] };
    const h = contextHash(base);
    expect(contextHash({ ...base, messages: [base.messages[0], { role: 'user', content: 'Capital city of France?' }] })).toBe(h); // paraphrase
    expect(contextHash({ ...base, stream: false, user: 'u' })).toBe(h);
    expect(contextHash({ ...base, messages: [{ role: 'system', content: 'be verbose' }, base.messages[1]] })).not.toBe(h);
    expect(contextHash({ ...base, temperature: 0.5 })).not.toBe(h);
    expect(contextHash({ ...base, tools: [{ type: 'function' }] })).not.toBe(h);
    expect(contextHash({ ...base, messages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'a' }, base.messages[1]] })).not.toBe(h);
  });

  it('normalizes and compares vectors', () => {
    const v = normalize([3, 4]);
    expect(v[0]).toBeCloseTo(0.6);
    expect(dot(v, v)).toBeCloseTo(1);
    expect(dot(normalize([1, 0]), normalize([0, 1]))).toBeCloseTo(0);
    expect(dot(normalize([1, 2]), normalize([1, 2, 3]))).toBe(-1); // different dimensions never match
    expect(normalize([0, 0]).every((x) => x === 0)).toBe(true);
  });
});

describe('SemanticIndex', () => {
  const make = (threshold = 0.95) => {
    const db = openDatabase(':memory:');
    return { db, index: new SemanticIndex(db, { threshold }) };
  };

  it('finds the best match above the threshold within scope and context only', () => {
    const { index } = make();
    index.add('k1', 'client:1', 'ctx', [1, 0, 0]);
    index.add('k2', 'client:1', 'ctx', [0.9, 0.1, 0]);
    expect(index.find('client:1', 'ctx', [1, 0.01, 0])?.key).toBe('k1');
    expect(index.find('client:1', 'ctx', [0.99, 0.12, 0])?.key).toBe('k2'); // the closer one wins
    expect(index.find('client:1', 'ctx', [0, 1, 0])).toBeUndefined(); // below threshold
    expect(index.find('client:2', 'ctx', [1, 0, 0])).toBeUndefined(); // other client
    expect(index.find('client:1', 'other', [1, 0, 0])).toBeUndefined(); // other context
    expect(index.find('client:1', 'ctx', [1, 0])).toBeUndefined(); // other dimension
  });

  it('upserts, removes and prunes entries whose cached response is gone', () => {
    const { db, index } = make();
    index.add('a', 's', 'c', [1, 0]);
    index.add('a', 's', 'c', [0, 1]); // replaces
    expect(index.find('s', 'c', [0, 1])?.key).toBe('a');
    expect(index.find('s', 'c', [1, 0])).toBeUndefined();
    index.add('b', 's', 'c', [1, 1]);
    index.remove('b');
    expect(index.find('s', 'c', [1, 1])).toBeUndefined();
    const cache = new ResponseCache(db, { ttlMs: 60_000, maxEntries: 10, mode: 'all' });
    cache.set('a', { body: '{}', provider: null, model: null, tier: null, complexity: null });
    index.add('orphan', 's', 'c', [5, 5]);
    index.prune();
    expect(index.find('s', 'c', [0, 1])?.key).toBe('a');
    expect(index.find('s', 'c', [5, 5])).toBeUndefined();
  });
});

describe('gateway semantic cache', () => {
  const registry: ProviderEntry[] = [
    {
      provider: 'p',
      base_url: 'https://p.test/v1',
      api_key_env: 'P_API_KEYS',
      auth: 'bearer',
      models: [
        { id: 'chat-m', capabilities: ['chat'], limits: {}, quirks: [] },
        { id: 'embed-m', capabilities: ['embeddings'], limits: {}, quirks: [] },
      ],
    },
  ];
  // Tiny fake embedding space: paraphrases share a direction, other topics do not.
  const VECTORS: Record<string, number[]> = {
    'What is the capital of France?': [1, 0.02, 0],
    'Tell me the capital city of France': [0.99, 0.05, 0],
    'How do I bake sourdough bread?': [0, 1, 0],
  };

  function setup(opts: { embedFails?: boolean } = {}) {
    const db = openDatabase(':memory:');
    const store = new TokenStore(db);
    const calls = { chat: 0, embed: 0 };
    const cache = new ResponseCache(db, { ttlMs: 60_000, maxEntries: 100, mode: 'deterministic' });
    const index = new SemanticIndex(db, { threshold: 0.97 });
    const requestLog = new RequestLog(db);
    const app = createApp({
      registry,
      store,
      envTokens: ['pg-env'],
      pools: new Map([['p', new KeyPool(['k'])]]),
      fetch: (async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as Json;
        if (url.endsWith('/embeddings')) {
          calls.embed++;
          if (opts.embedFails) return new Response('{}', { status: 500 });
          return Response.json({ data: [{ embedding: VECTORS[body.input] ?? [0, 0, 1] }] });
        }
        calls.chat++;
        return Response.json({ choices: [{ message: { content: `answer #${calls.chat}` } }], usage: { total_tokens: 3 } });
      }) as unknown as typeof fetch,
      cache,
      semantic: { index, model: 'embed-m' },
      requestLog,
    });
    const ask = async (text: string, extra: Json = {}, headers: Record<string, string> = {}, token = 'pg-env', system = 'You are terse.') => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'chat-m', temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: text }], ...extra }),
      });
      return { res, text: await res.text() };
    };
    return { ask, calls, store, requestLog, index };
  }

  it('serves a paraphrase from the cache, reports similarity, and logs it as a hit', async () => {
    const { ask, calls, requestLog } = setup();
    const a = await ask('What is the capital of France?');
    expect(a.res.headers.get('x-pourgate-cache')).toBeNull();
    const b = await ask('Tell me the capital city of France');
    expect(b.res.headers.get('x-pourgate-cache')).toBe('semantic');
    expect(Number(b.res.headers.get('x-pourgate-cache-similarity'))).toBeGreaterThan(0.97);
    expect(b.text).toBe(a.text); // same answer, no second chat call
    expect(calls.chat).toBe(1);
    expect(requestLog.recent()[0]).toMatchObject({ cache: 'semantic' });
    expect(requestLog.analytics(0, 3_600_000).summary.cacheHits).toBe(1);
  });

  it('does not reuse answers across different topics, system prompts, parameters or clients', async () => {
    const { ask, calls, store } = setup();
    await ask('What is the capital of France?');
    expect((await ask('How do I bake sourdough bread?')).res.headers.get('x-pourgate-cache')).toBeNull(); // different topic
    expect((await ask('Tell me the capital city of France', {}, {}, 'pg-env', 'You are verbose.')).res.headers.get('x-pourgate-cache')).toBeNull(); // other system prompt
    expect((await ask('Tell me the capital city of France', { max_tokens: 5 })).res.headers.get('x-pourgate-cache')).toBeNull(); // other parameters
    const other = store.create({ name: 'other' }).token;
    expect((await ask('Tell me the capital city of France', {}, {}, other)).res.headers.get('x-pourgate-cache')).toBeNull(); // other client
    expect(calls.chat).toBe(5);
  });

  it('falls back to a normal request when embedding fails, and respects bypass headers', async () => {
    const failing = setup({ embedFails: true });
    const a = await failing.ask('What is the capital of France?');
    expect(a.res.status).toBe(200);
    expect((await failing.ask('Tell me the capital city of France')).res.headers.get('x-pourgate-cache')).toBeNull();
    expect(failing.calls.chat).toBe(2);

    const { ask, calls } = setup();
    await ask('What is the capital of France?');
    const before = calls.embed;
    const bypassed = await ask('Tell me the capital city of France', {}, { 'x-pourgate-cache': 'bypass' });
    expect(bypassed.res.headers.get('x-pourgate-cache')).toBeNull();
    expect(calls.embed).toBe(before); // no embedding call when the cache is bypassed
  });

  it('skips semantic lookup for short prompts and non-deterministic requests', async () => {
    const { ask, calls } = setup();
    await ask('hi');
    await ask('hi there', { temperature: 0.9 });
    expect(calls.embed).toBe(0);
    vi.restoreAllMocks();
  });

  it('exact hits still win and cost no embedding call', async () => {
    const { ask, calls } = setup();
    await ask('What is the capital of France?');
    const embedsAfterFirst = calls.embed;
    const again = await ask('What is the capital of France?');
    expect(again.res.headers.get('x-pourgate-cache')).toBe('hit');
    expect(calls.embed).toBe(embedsAfterFirst);
  });
});
