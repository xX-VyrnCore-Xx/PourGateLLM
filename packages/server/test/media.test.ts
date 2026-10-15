import { describe, expect, it, vi } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { KeyPool } from '../src/keypool.js';
import { RequestLog } from '../src/requestlog.js';
import { TokenStore } from '../src/tokens.js';

type Json = Record<string, any>;

const entry = (name: string, models: Json[], extra: Partial<ProviderEntry> = {}): ProviderEntry => ({
  provider: name,
  base_url: `https://${name}.test/v1`,
  api_key_env: `${name.toUpperCase()}_API_KEYS`,
  auth: 'bearer',
  models: models.map((m) => ({ limits: {}, quirks: [], ...m })) as unknown as ProviderEntry['models'],
  ...extra,
});
const registry = [
  entry('a', [{ id: 'chat-a', capabilities: ['chat'] }, { id: 'stt-a', capabilities: ['transcription'] }, { id: 'tts-a', capabilities: ['speech'] }]),
  entry('b', [{ id: 'stt-b', capabilities: ['transcription'] }, { id: 'img-b', capabilities: ['images'] }]),
];

interface Call {
  url: string;
  headers: Record<string, string>;
  body: FormData | Json;
}

function setup(opts: { upstream?: (call: Call) => Response; privacy?: boolean; maxUploadBytes?: number } = {}) {
  const calls: Call[] = [];
  const db = openDatabase(':memory:');
  const store = new TokenStore(db);
  const requestLog = new RequestLog(db);
  const app = createApp({
    registry,
    store,
    envTokens: ['pg'],
    pools: new Map([['a', new KeyPool(['ka1', 'ka2'])], ['b', new KeyPool(['kb'])]]),
    fetch: (async (url: string, init: RequestInit) => {
      const call: Call = { url, headers: init.headers as Record<string, string>, body: init.body instanceof FormData ? init.body : JSON.parse(init.body as string) };
      calls.push(call);
      return opts.upstream ? opts.upstream(call) : Response.json({ text: 'transcribed', usage: { total_tokens: 2 } });
    }) as unknown as typeof fetch,
    privacy: opts.privacy ? { pii: 'all', policy: 'any' } : undefined,
    requestLog,
    maxUploadBytes: opts.maxUploadBytes,
  });
  const auth = { authorization: 'Bearer pg' };
  const transcribe = async (fields: Record<string, string>, file: File | null = new File([new Uint8Array([1, 2, 3, 4])], 'a.wav', { type: 'audio/wav' })) => {
    const fd = new FormData();
    if (file) fd.set('file', file);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const res = await app.request('/v1/audio/transcriptions', { method: 'POST', headers: auth, body: fd });
    return { res, text: await res.text() };
  };
  const json = async (path: string, body: Json) => {
    const res = await app.request(path, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { res, buf: Buffer.from(await res.arrayBuffer()) };
  };
  return { app, calls, transcribe, json, store, requestLog };
}

describe('POST /v1/audio/transcriptions', () => {
  it('forwards the multipart upload with the model replaced and the key set', async () => {
    const { transcribe, calls } = setup();
    const { res, text } = await transcribe({ model: 'stt-a', language: 'it', response_format: 'json' });
    expect(res.status).toBe(200);
    expect(JSON.parse(text).text).toBe('transcribed');
    const call = calls[0]!;
    expect(call.url).toBe('https://a.test/v1/audio/transcriptions');
    expect(call.headers.authorization).toBe('Bearer ka1');
    expect(call.headers['content-type']).toBeUndefined(); // set by fetch, with the multipart boundary
    const fd = call.body as FormData;
    expect(fd.get('model')).toBe('stt-a');
    expect(fd.get('language')).toBe('it');
    const file = fd.get('file') as File;
    expect(file.name).toBe('a.wav');
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(res.headers.get('x-pourgate-provider')).toBe('a');
  });

  it('spreads "auto" over transcription models only and keeps endpoints apart', async () => {
    const { transcribe, calls } = setup();
    for (let i = 0; i < 4; i++) await transcribe({ model: 'auto' });
    expect(new Set(calls.map((c) => (c.body as FormData).get('model')))).toEqual(new Set(['stt-a', 'stt-b']));
    expect((await transcribe({ model: 'chat-a' })).res.status).toBe(404);
    expect((await transcribe({ model: 'tts-a' })).res.status).toBe(404);
  });

  it('retries the same upload on the next key after a 429', async () => {
    let n = 0;
    const { transcribe, calls } = setup({ upstream: () => (n++ === 0 ? new Response('{}', { status: 429 }) : Response.json({ text: 'ok' })) });
    const { res } = await transcribe({ model: 'stt-a' });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.headers.authorization)).toEqual(['Bearer ka1', 'Bearer ka2']);
    expect(((calls[1]!.body as FormData).get('file') as File).size).toBe(4);
  });

  it('validates the request and enforces the upload limit', async () => {
    const { transcribe, app } = setup({ maxUploadBytes: 8 });
    expect((await transcribe({ model: 'stt-a' }, null)).res.status).toBe(400);
    expect((await transcribe({}, new File([new Uint8Array(1)], 'a.wav'))).res.status).toBe(400);
    const big = await transcribe({ model: 'stt-a' }, new File([new Uint8Array(64)], 'big.wav'));
    expect(big.res.status).toBe(413);
    expect(JSON.parse(big.text).error.code).toBe('file_too_large');
    const notMultipart = await app.request('/v1/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer pg', 'content-type': 'application/json' }, body: '{}' });
    expect(notMultipart.status).toBe(400);
    const declared = await app.request('/v1/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer pg', 'content-length': '999999999', 'content-type': 'multipart/form-data; boundary=x' }, body: '--x--' });
    expect(declared.status).toBe(413);
  });

  it('applies client quotas and logs the request', async () => {
    const { app, store, requestLog } = setup();
    const { token } = store.create({ name: 'c', dailyRequestLimit: 1 });
    const send = () => {
      const fd = new FormData();
      fd.set('file', new File([new Uint8Array(2)], 'a.wav'));
      fd.set('model', 'stt-a');
      return app.request('/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
    };
    const first = await send();
    await first.text();
    expect(first.status).toBe(200);
    expect((await send()).status).toBe(429);
    expect(requestLog.recent()[0]).toMatchObject({ requested: 'stt-a', provider: 'a', status: 200 });
  });
});

describe('POST /v1/audio/speech', () => {
  it('passes binary audio through byte for byte', async () => {
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02]);
    const { json, calls } = setup({ upstream: () => new Response(audio, { headers: { 'content-type': 'audio/mpeg' } }) });
    const { res, buf } = await json('/v1/audio/speech', { model: 'tts-a', input: 'hello', voice: 'alloy' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect([...buf]).toEqual([...audio]);
    expect(calls[0]!.url).toBe('https://a.test/v1/audio/speech');
    expect(calls[0]!.body).toMatchObject({ model: 'tts-a', input: 'hello', voice: 'alloy' });
  });

  it('validates input and keeps the capability boundary', async () => {
    const { json } = setup();
    expect((await json('/v1/audio/speech', { model: 'tts-a' })).res.status).toBe(400);
    expect((await json('/v1/audio/speech', { model: 'tts-a', input: '' })).res.status).toBe(400);
    expect((await json('/v1/audio/speech', { model: 'stt-a', input: 'x' })).res.status).toBe(404);
  });

  it('masks PII in the text to be spoken when masking is on', async () => {
    const { json, calls } = setup({ privacy: true });
    const { res } = await json('/v1/audio/speech', { model: 'tts-a', input: 'call a@b.co' });
    expect(res.headers.get('x-pourgate-redacted')).toBe('1');
    expect(calls[0]!.body).toMatchObject({ input: 'call [EMAIL]' });
  });
});

describe('POST /v1/images/generations', () => {
  it('forwards the JSON request and response', async () => {
    const out = { created: 1, data: [{ url: 'https://img.test/1.png' }] };
    const { json, calls } = setup({ upstream: () => Response.json(out) });
    const { res, buf } = await json('/v1/images/generations', { model: 'img-b', prompt: 'a red fox', n: 1, size: '512x512' });
    expect(res.status).toBe(200);
    expect(JSON.parse(buf.toString())).toEqual(out);
    expect(calls[0]).toMatchObject({ url: 'https://b.test/v1/images/generations', headers: { authorization: 'Bearer kb' } });
    expect(calls[0]!.body).toMatchObject({ model: 'img-b', prompt: 'a red fox', n: 1, size: '512x512' });
  });

  it('validates and masks the prompt', async () => {
    const { json, calls } = setup({ privacy: true });
    expect((await json('/v1/images/generations', { model: 'img-b' })).res.status).toBe(400);
    expect((await json('/v1/images/generations', { model: 'chat-a', prompt: 'x' })).res.status).toBe(404);
    await json('/v1/images/generations', { model: 'auto', prompt: 'portrait of a@b.co' });
    expect(calls.at(-1)!.body).toMatchObject({ prompt: 'portrait of [EMAIL]' });
  });

  it('requires authentication', async () => {
    const { app } = setup();
    const res = await app.request('/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    vi.restoreAllMocks();
  });
});
