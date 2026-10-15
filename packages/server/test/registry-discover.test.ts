import { describe, expect, it } from 'vitest';
import { providerSchema } from '@pourgate/shared';
import { discover, guessTier, toModel, SOURCES } from '../src/registry-discover.js';

const reply = (body: unknown, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });
const kilo = SOURCES.find((s) => s.provider === 'kilo')!;

describe('registry discover', () => {
  it('guesses a tier from the parameter count, using the capacity of MoE ids', () => {
    expect(guessTier('meta/llama-3.3-70b-instruct')).toBe('large');
    expect(guessTier('nvidia/nemotron-3-super-120b-a12b')).toBe('large');
    expect(guessTier('google/gemma-4-26b-a4b-it')).toBe('medium');
    expect(guessTier('qwen/qwen3-8b')).toBe('small');
    expect(guessTier('vendor/some-flash')).toBe('small');
    expect(guessTier('vendor/unknown')).toBe('medium');
  });

  it('maps capabilities and skips non-chat or unsafe ids', () => {
    expect(toModel({ id: 'a/b:free', supported_parameters: ['tools', 'response_format'], architecture: { input_modalities: ['text', 'image'] }, context_length: 32000 })).toMatchObject({
      capabilities: ['chat', 'tools', 'json_mode', 'vision'],
      context: 32000,
    });
    expect(toModel({ id: 'x/text-embedding-3' })).toBeUndefined();
    expect(toModel({ id: 'bad id with spaces' })).toBeUndefined();
  });

  it('keeps only models the provider marks free and produces a valid registry entry', async () => {
    const rows = [
      { id: 'a/free-70b:free', isFree: true, supported_parameters: ['tools'], context_length: 8000 },
      { id: 'b/paid-70b', isFree: false },
      { id: 'kilo-auto/free', isFree: true },
      { id: 'a/free-70b:free', isFree: true }, // duplicate
    ];
    const [d] = await discover({ sources: [kilo], fetch: reply({ data: rows }), today: '2026-01-02' });
    expect(d?.entry?.models.map((m) => m.id)).toEqual(['a/free-70b:free']);
    expect(d?.entry).toMatchObject({ provider: 'kilo', trains_on_prompts: true });
    expect(providerSchema.safeParse(d?.entry).success).toBe(true);
    expect(d?.entry?.models[0]?.verified_at).toBe('2026-01-02');
  });

  it('reports errors instead of producing an empty entry', async () => {
    expect((await discover({ sources: [kilo], fetch: reply({}, 500) }))[0]?.error).toBe('HTTP 500');
    expect((await discover({ sources: [kilo], fetch: reply({ data: [{ id: 'x', isFree: false }] }) }))[0]?.error).toMatch(/no free models/);
    const boom = async () => {
      throw new Error('offline');
    };
    expect((await discover({ sources: [kilo], fetch: boom }))[0]?.error).toBe('offline');
  });
});
