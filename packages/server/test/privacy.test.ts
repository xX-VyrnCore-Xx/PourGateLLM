import { describe, expect, it, vi } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import {
  needsRedaction,
  parsePiiMode,
  parsePolicy,
  providerAllowed,
  redactBody,
  redactText,
  tighten,
  type PrivacyConfig,
} from '../src/privacy.js';
import { RequestLog } from '../src/requestlog.js';
import { TokenStore } from '../src/tokens.js';

describe('redactText', () => {
  const r = (s: string) => redactText(s).text;

  it('masks emails and secrets', () => {
    expect(r('write to anna.rossi+x@example.co.uk now')).toBe('write to [EMAIL] now');
    expect(r('key gsk_abcdefghijklmnop1234 and sk-abcdefghijklmnopqrstuv')).toBe('key [SECRET] and [SECRET]');
    expect(r('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123')).toBe('Authorization: [SECRET]');
    expect(r('AKIAIOSFODNN7EXAMPLE')).toBe('[SECRET]');
    expect(r('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----')).toBe('[SECRET]');
    expect(r('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk')).toBe('jwt [SECRET]');
  });

  it('masks only valid card numbers (Luhn) and valid IBANs (mod 97)', () => {
    expect(r('card 4111 1111 1111 1111 ok')).toBe('card [CARD] ok');
    expect(r('card 4111-1111-1111-1111 ok')).toBe('card [CARD] ok');
    expect(r('order 1234 5678 9012 3456')).toBe('order 1234 5678 9012 3456'); // fails Luhn
    expect(r('IBAN IT60 X054 2811 1010 0000 0123 456')).toBe('IBAN [IBAN]');
    expect(r('IBAN IT60X0542811101000000123456')).toBe('IBAN [IBAN]');
    expect(r('IBAN IT61 X054 2811 1010 0000 0123 456')).toContain('IT61'); // wrong check digits
  });

  it('masks Italian tax ids and phone numbers', () => {
    expect(r('CF RSSMRA85T10A562S del cliente')).toBe('CF [TAX_ID] del cliente');
    expect(r('call +39 347 123 4567 please')).toBe('call [PHONE] please');
    expect(r('chiama 347 123 4567')).toBe('chiama [PHONE]');
    expect(r('+1 (415) 555-0132')).not.toContain('555');
  });

  it('leaves ordinary text and numbers alone', () => {
    for (const s of ['The year 2024 had 365 days.', 'pi is 3.14159', 'version 1.2.3', 'Hello, how are you?', 'x = 12345']) {
      expect(r(s)).toBe(s);
    }
  });

  it('counts replacements and is idempotent', () => {
    const once = redactText('a@b.co and c@d.io');
    expect(once).toEqual({ text: '[EMAIL] and [EMAIL]', count: 2 });
    expect(redactText(once.text).count).toBe(0);
  });
});

describe('redactBody', () => {
  it('masks message text, content parts and tool call arguments, leaving everything else', () => {
    const body = {
      model: 'm',
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'be nice' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'mail me at a@b.co' },
            { type: 'image_url', image_url: { url: 'https://x.test/a@b.co.png' } },
          ],
        },
        { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'f', arguments: '{"to":"a@b.co"}' } }] },
        { role: 'user', content: 'plain' },
      ],
    };
    const { body: out, count } = redactBody(body);
    expect(count).toBe(2);
    const msgs = out.messages as { content: unknown; tool_calls?: { function: { arguments: string } }[] }[];
    expect((msgs[1]!.content as { text?: string; image_url?: { url: string } }[])[0]!.text).toBe('mail me at [EMAIL]');
    expect((msgs[1]!.content as { image_url?: { url: string } }[])[1]!.image_url!.url).toContain('a@b.co.png');
    expect(msgs[2]!.tool_calls![0]!.function.arguments).toBe('{"to":"[EMAIL]"}');
    expect(out.temperature).toBe(0.2);
    expect(JSON.stringify(body)).toContain('mail me at a@b.co'); // original untouched
  });

  it('tolerates malformed bodies', () => {
    expect(redactBody({ model: 'm' }).count).toBe(0);
    expect(redactBody({ messages: [null, 3, { role: 'user' }] }).count).toBe(0);
  });
});

describe('policy helpers', () => {
  it('parses and validates modes', () => {
    expect(parsePiiMode(undefined)).toBe('off');
    expect(parsePiiMode(' ALL ')).toBe('all');
    expect(() => parsePiiMode('maybe')).toThrow();
    expect(parsePolicy(undefined)).toBe('any');
    expect(() => parsePolicy('x')).toThrow();
  });

  it('applies provider policies', () => {
    const t = { trains_on_prompts: true };
    const f = { trains_on_prompts: false };
    const u = {};
    expect([t, f, u].map((p) => providerAllowed('any', p))).toEqual([true, true, true]);
    expect([t, f, u].map((p) => providerAllowed('no-training', p))).toEqual([false, true, true]);
    expect([t, f, u].map((p) => providerAllowed('strict', p))).toEqual([false, true, false]);
    expect([t, f, u].map((p) => needsRedaction('training', p))).toEqual([true, false, true]);
    expect([t, f, u].map((p) => needsRedaction('all', p))).toEqual([true, true, true]);
    expect([t, f, u].map((p) => needsRedaction('off', p))).toEqual([false, false, false]);
  });

  it('lets clients tighten but never loosen', () => {
    const lax: PrivacyConfig = { pii: 'off', policy: 'any' };
    expect(tighten(lax, 'redact, strict')).toEqual({ pii: 'all', policy: 'strict' });
    expect(tighten(lax, 'no-training')).toEqual({ pii: 'off', policy: 'no-training' });
    const strict: PrivacyConfig = { pii: 'all', policy: 'strict' };
    expect(tighten(strict, 'no-training')).toEqual(strict);
    expect(tighten(strict, 'off, any')).toEqual(strict);
    expect(tighten(lax, undefined)).toBe(lax);
  });
});

describe('gateway privacy', () => {
  const entry = (name: string, trains: boolean | undefined): ProviderEntry => ({
    provider: name,
    base_url: `https://${name}.test/v1`,
    api_key_env: `${name.toUpperCase()}_API_KEYS`,
    auth: 'bearer',
    trains_on_prompts: trains,
    models: [{ id: `${name}-m`, capabilities: ['chat'], limits: {}, quirks: [] }],
  });
  const registry = [entry('trainer', true), entry('private', false), entry('unknown', undefined)];

  function setup(privacy: PrivacyConfig) {
    const sent: { url: string; body: string }[] = [];
    const db = openDatabase(':memory:');
    const requestLog = new RequestLog(db);
    const app = createApp({
      registry,
      store: new TokenStore(db),
      envTokens: ['pg'],
      pools: new Map(registry.map((p) => [p.provider, new KeyPool(['k'])])),
      fetch: vi.fn(async (url: string, init: RequestInit) => {
        sent.push({ url, body: init.body as string });
        return Response.json({ ok: true });
      }) as unknown as typeof fetch,
      privacy,
      requestLog,
    });
    let lastText = '';
    const call = async (model: string, headers: Record<string, string> = {}) => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer pg', 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'reach me at a@b.co' }] }),
      });
      lastText = await res.text();
      return res;
    };
    return { call, sent, requestLog, text: () => lastText };
  }

  it('masks PII only for providers that may train, in "training" mode', async () => {
    const { call, sent } = setup({ pii: 'training', policy: 'any' });
    const a = await call('trainer-m');
    expect(a.headers.get('x-pourgate-redacted')).toBe('1');
    expect(sent[0]!.body).toContain('[EMAIL]');
    const b = await call('private-m');
    expect(b.headers.get('x-pourgate-redacted')).toBeNull();
    expect(sent[1]!.body).toContain('a@b.co');
    const c = await call('unknown-m');
    expect(c.headers.get('x-pourgate-redacted')).toBe('1');
  });

  it('masks everywhere in "all" mode and nowhere when off', async () => {
    const all = setup({ pii: 'all', policy: 'any' });
    await all.call('private-m');
    expect(all.sent[0]!.body).toContain('[EMAIL]');
    const off = setup({ pii: 'off', policy: 'any' });
    const res = await off.call('trainer-m');
    expect(res.headers.get('x-pourgate-redacted')).toBeNull();
    expect(off.sent[0]!.body).toContain('a@b.co');
  });

  it('records the number of masked items in the request log', async () => {
    const { call, requestLog } = setup({ pii: 'all', policy: 'any' });
    await call('trainer-m');
    expect(requestLog.recent()[0]!.redacted).toBe(1);
  });

  it('skips excluded providers when routing with auto', async () => {
    const { call, sent } = setup({ pii: 'off', policy: 'no-training' });
    for (let i = 0; i < 4; i++) await call('auto');
    expect(sent.every((s) => !s.url.includes('trainer'))).toBe(true);
    const strict = setup({ pii: 'off', policy: 'strict' });
    for (let i = 0; i < 3; i++) await strict.call('auto');
    expect(strict.sent.every((s) => s.url.includes('private'))).toBe(true);
  });

  it('rejects explicit models that the policy excludes', async () => {
    const { call, sent, text } = setup({ pii: 'off', policy: 'no-training' });
    const res = await call('trainer-m');
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
    expect((JSON.parse(text()) as { error: { code: string } }).error.code).toBe('privacy_policy');
  });

  it('honors client-requested tightening via x-pourgate-privacy', async () => {
    const { call, sent } = setup({ pii: 'off', policy: 'any' });
    expect((await call('trainer-m', { 'x-pourgate-privacy': 'strict' })).status).toBe(400);
    const res = await call('private-m', { 'x-pourgate-privacy': 'redact' });
    expect(res.headers.get('x-pourgate-redacted')).toBe('1');
    expect(sent.at(-1)!.body).toContain('[EMAIL]');
  });
});
