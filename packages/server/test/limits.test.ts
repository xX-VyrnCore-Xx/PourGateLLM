import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { TokenStore } from '../src/tokens.js';

const registry: ProviderEntry[] = [
  {
    provider: 'p',
    base_url: 'https://p.test/v1',
    api_key_env: 'P_API_KEYS',
    auth: 'bearer',
    models: [
      { id: 'm1', capabilities: ['chat'], limits: {}, quirks: [] },
      { id: 'stt', capabilities: ['transcription'], limits: {}, quirks: [] },
    ],
  },
];

function setup() {
  let upstreamCalls = 0;
  const app = createApp({
    registry,
    store: new TokenStore(openDatabase(':memory:')),
    envTokens: ['pg'],
    pools: new Map([['p', new KeyPool(['k'])]]),
    maxBodyBytes: 1000,
    maxUploadBytes: 5000,
    adminPassword: 'pw',
    fetch: (async () => {
      upstreamCalls++;
      return Response.json({ choices: [{ message: { content: 'ok' } }], text: 'ok' });
    }) as unknown as typeof fetch,
  });
  return { app, calls: () => upstreamCalls };
}

const chatBody = (pad: number) => JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'x'.repeat(pad) }] });
const headers = { authorization: 'Bearer pg', 'content-type': 'application/json' };

describe('request size limits', () => {
  it('rejects oversized JSON bodies before reaching a provider, accepts ones under the limit', async () => {
    const { app, calls } = setup();
    const big = await app.request('/v1/chat/completions', { method: 'POST', headers, body: chatBody(5000) });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe('request_too_large');
    expect(calls()).toBe(0);
    const ok = await app.request('/v1/chat/completions', { method: 'POST', headers, body: chatBody(100) });
    expect(ok.status).toBe(200);
  });

  it('enforces the limit on chunked bodies without a content-length', async () => {
    const { app } = setup();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const chunk = new TextEncoder().encode('x'.repeat(400));
        for (let i = 0; i < 10; i++) c.enqueue(chunk);
        c.close();
      },
    });
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(413);
  });

  it('answers in the Anthropic error shape on /v1/messages', async () => {
    const { app } = setup();
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'pg', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm1', max_tokens: 5, messages: [{ role: 'user', content: 'x'.repeat(5000) }] }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
  });

  it('gives transcription uploads their own, larger limit', async () => {
    const { app } = setup();
    const upload = (size: number) => {
      const fd = new FormData();
      fd.set('file', new File([new Uint8Array(size)], 'a.wav'));
      fd.set('model', 'stt');
      return app.request('/v1/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer pg' }, body: fd });
    };
    expect((await upload(3000)).status).toBe(200); // above the 1000 byte JSON limit, below the upload limit
    expect((await upload(8000)).status).toBe(413);
  });

  it('limits admin API bodies to 64 KB', async () => {
    const { app } = setup();
    const res = await app.request('/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(70_000) }) });
    expect(res.status).toBe(413);
    const ok = await app.request('/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
    expect(ok.status).toBe(204);
  });
});
