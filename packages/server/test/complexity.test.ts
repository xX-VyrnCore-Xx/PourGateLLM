import { describe, expect, it, vi } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { analyzePrompt } from '../src/complexity.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { TokenStore } from '../src/tokens.js';

const user = (content: unknown) => ({ role: 'user', content });
const analyze = (messages: unknown[], extra: Record<string, unknown> = {}) => analyzePrompt({ messages, ...extra });

describe('analyzePrompt', () => {
  it('classifies short, simple prompts as easy', () => {
    for (const q of ['hi', 'Ciao!', 'What is the capital of France?', 'Traduci "good morning" in italiano', 'Define entropy']) {
      expect(analyze([user(q)]).complexity, q).toBe('easy');
    }
  });

  it('classifies a reasoning/engineering task as medium or hard', () => {
    const a = analyze([user('Analyze the trade-offs of this architecture and design a migration plan, step by step.')]);
    expect(a.complexity).toBe('hard');
    const b = analyze([user('Debug this function:\n```js\nfunction f(a){return a+1}\n```')]);
    expect(b.complexity).toBe('medium');
  });

  it('understands Italian wording', () => {
    const a = analyze([user('Analizza e ottimizza questo algoritmo, ragiona passo passo e dimostra la complessità.')]);
    expect(a.complexity).toBe('hard');
  });

  it('grows with prompt size, history depth and tools', () => {
    const big = 'lorem ipsum dolor sit amet '.repeat(1200); // ~8k tokens
    expect(analyze([user(big)]).complexity).toBe('hard');
    const long = Array.from({ length: 12 }, (_, i) => user(`message ${i} with some ordinary text about the weather today`));
    expect(analyze(long).score).toBe(1);
    const withTools = analyze([user('Book a table for two tomorrow evening please, near the station, italian food')], {
      tools: [{ type: 'function', function: { name: 'book' } }],
    });
    expect(withTools.reasons.join()).toMatch(/tool use/);
    expect(withTools.needs.tools).toBe(true);
  });

  it('detects needs and handles content parts', () => {
    const a = analyze(
      [user([{ type: 'text', text: 'what is in this image?' }, { type: 'image_url', image_url: { url: 'data:...' } }])],
      { response_format: { type: 'json_object' } },
    );
    expect(a.needs).toEqual({ tools: false, json: true, vision: true });
    expect(a.promptTokens).toBeGreaterThan(0);
  });

  it('never throws on malformed bodies', () => {
    expect(analyzePrompt({}).complexity).toBe('easy');
    expect(analyzePrompt({ messages: [null, 5, { content: { x: 1 } }] }).complexity).toBe('easy');
  });
});

describe('complexity routing through the gateway', () => {
  const model = (id: string, tier: 'small' | 'medium' | 'large' | undefined, extra: Record<string, unknown> = {}) => ({
    id,
    tier,
    capabilities: ['chat' as const],
    limits: {},
    quirks: [],
    ...extra,
  });
  const registry: ProviderEntry[] = [
    {
      provider: 'p1',
      base_url: 'https://p1.test/v1',
      api_key_env: 'P1_API_KEYS',
      auth: 'bearer',
      models: [model('big', 'large', { capabilities: ['chat', 'tools', 'json_mode'] }), model('tiny', 'small', { context: 1000 })],
    },
    {
      provider: 'p2',
      base_url: 'https://p2.test/v1',
      api_key_env: 'P2_API_KEYS',
      auth: 'bearer',
      models: [model('mid', 'medium'), model('legacy', undefined)],
    },
  ];

  function setup(limitsBig?: { rpd: number }) {
    const reg = limitsBig
      ? registry.map((p) => ({ ...p, models: p.models.map((m) => (m.id === 'big' ? { ...m, limits: limitsBig } : m)) }))
      : registry;
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((JSON.parse(init.body as string) as { model: string }).model);
      return Response.json({ ok: true });
    });
    const app = createApp({
      registry: reg,
      store: new TokenStore(openDatabase(':memory:')),
      envTokens: ['pg'],
      pools: new Map([
        ['p1', new KeyPool(['k1'])],
        ['p2', new KeyPool(['k2'])],
      ]),
      fetch: fetchMock as unknown as typeof fetch,
    });
    const call = (model: string, body: Record<string, unknown> = {}, text = 'hi') =>
      app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer pg', 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: text }], ...body }),
      });
    return { call, seen };
  }

  const HARD = 'Analyze the trade-offs of this architecture and design a migration plan, step by step.';

  it('sends easy prompts to the small tier and hard ones to the large tier', async () => {
    const { call, seen } = setup();
    const easy = await call('auto', {}, 'hi');
    expect(easy.headers.get('x-pourgate-complexity')).toBe('easy');
    expect(easy.headers.get('x-pourgate-tier')).toBe('small');
    const hard = await call('auto', {}, HARD);
    expect(hard.headers.get('x-pourgate-complexity')).toBe('hard');
    expect(hard.headers.get('x-pourgate-tier')).toBe('large');
    expect(seen).toEqual(['tiny', 'big']);
  });

  it('treats untiered models as medium', async () => {
    const { call, seen } = setup();
    await call('auto:medium');
    expect(seen).toEqual(['mid']); // 'mid' (medium, p2) and 'legacy' (untiered) tie; the less-used/earlier one wins
  });

  it('falls back to other tiers when the preferred one is exhausted', async () => {
    const { call, seen } = setup({ rpd: 1 });
    await call('auto:large');
    const res = await call('auto:large');
    expect(res.status).toBe(200);
    expect(seen).toEqual(['big', 'mid']);
  });

  it('spreads load within a tier by today usage', async () => {
    const { call, seen } = setup();
    await call('auto:medium');
    await call('auto:medium');
    expect(seen).toEqual(['mid', 'legacy']);
  });

  it('only considers models that can serve the request', async () => {
    const { call, seen } = setup();
    await call('auto', { tools: [{ type: 'function', function: { name: 'x' } }] }, 'hi');
    expect(seen).toEqual(['big']); // only model with the tools capability
    const none = await call('auto', {}, 'hi');
    expect(none.status).toBe(200);
    const vision = await call('auto', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] });
    expect(vision.status).toBe(400);
    expect(((await vision.json()) as { error: { code: string } }).error.code).toBe('no_capable_model');
  });

  it('skips models whose context window is too small', async () => {
    const { call, seen } = setup();
    await call('auto:small', {}, 'x'.repeat(8000)); // ~2000 tokens > tiny's 1000
    expect(seen).toEqual(['mid']);
  });

  it('leaves explicit models alone and rejects unknown virtual ids', async () => {
    const { call, seen } = setup();
    const res = await call('mid', {}, HARD);
    expect(res.headers.get('x-pourgate-complexity')).toBeNull();
    expect(seen).toEqual(['mid']);
    expect((await call('auto:huge')).status).toBe(404);
  });

  it('forced tiers do not report a complexity', async () => {
    const { call } = setup();
    const res = await call('auto:large');
    expect(res.headers.get('x-pourgate-complexity')).toBeNull();
    expect(res.headers.get('x-pourgate-tier')).toBe('large');
  });
});
