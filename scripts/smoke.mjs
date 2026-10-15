#!/usr/bin/env node
// End-to-end self-test: starts a fake provider and the real built gateway, then exercises routing,
// failover, caching, streaming, tokens and the dashboard API. Needs no API keys and makes no real
// provider calls.   Usage: pnpm build && pnpm smoke
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'packages/server/dist/index.js');
const staticDir = join(root, 'packages/client/dist');
const work = mkdtempSync(join(tmpdir(), 'pourgate-smoke-'));

// ---- fake provider -------------------------------------------------------------------------
const seen = []; // [{ key, stream, model }]
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const key = (req.headers.authorization ?? '').replace('Bearer ', '');
    const payload = body ? JSON.parse(body) : {};
    if (req.url === '/v1/models') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
    seen.push({ key, stream: payload.stream === true, model: payload.model });
    if (key === 'key-limited') return void res.writeHead(429, { 'retry-after': '60' }).end('{"error":"rate limited"}');
    if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const part of ['pon', 'g']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
      return void res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'smoke', choices: [{ message: { role: 'assistant', content: 'pong' } }], usage: { total_tokens: 7 } }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

// ---- registry + gateway --------------------------------------------------------------------
const registryDir = join(work, 'registry');
mkdirSync(registryDir);
writeFileSync(
  join(registryDir, 'fake.yaml'),
  `provider: fake
base_url: ${upstreamUrl}
api_key_env: FAKE_API_KEYS
models:
  - id: fake-small
    tier: small
    capabilities: [chat]
  - id: fake-large
    tier: large
    capabilities: [chat]
`,
);
writeFileSync(join(work, 'profiles.yaml'), 'smoke:\n  - fake-large\n  - fake-small\n');
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const gateway = spawn(process.execPath, ['--no-warnings', server], {
  env: {
    ...process.env,
    PORT: String(port),
    POURGATE_DB: join(work, 'smoke.db'),
    POURGATE_REGISTRY_DIR: registryDir,
    POURGATE_STATIC_DIR: staticDir,
    POURGATE_TOKENS: 'pg-smoke',
    POURGATE_ADMIN_PASSWORD: 'smoke-password-123',
    FAKE_API_KEYS: 'key-limited,key-ok',
    POURGATE_CACHE_TTL_SECONDS: '60',
    POURGATE_CACHE_MODE: 'all',
    POURGATE_METRICS_TOKEN: 'metrics-secret',
    POURGATE_PROFILES_FILE: join(work, 'profiles.yaml'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
gateway.stdout.on('data', (d) => (log += d));
gateway.stderr.on('data', (d) => (log += d));

// ---- tiny test harness ---------------------------------------------------------------------
let failed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${name}\n    ${err instanceof Error ? err.message : err}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const chat = (body, extra = {}) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer pg-smoke', ...extra },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], ...body }),
  });

try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 49) throw new Error(`gateway did not start:\n${log}`);
  }

  await step('health endpoint answers', async () => assert((await fetch(`${base}/health`)).ok, 'not ok'));
  await step('requests without a token are rejected (401)', async () =>
    assert((await fetch(`${base}/v1/models`)).status === 401, 'expected 401'));
  await step('models list includes registry and virtual models', async () => {
    const ids = (await (await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer pg-smoke' } })).json()).data.map((m) => m.id);
    assert(ids.includes('fake-small') && ids.includes('auto'), `got ${ids.join(',')}`);
  });
  await step('failover: a rate-limited key is skipped and the next key answers', async () => {
    const res = await chat({ model: 'fake-small' });
    assert(res.status === 200, `status ${res.status}`);
    assert(res.headers.get('x-pourgate-provider') === 'fake', 'no provider header');
    assert(seen.some((s) => s.key === 'key-limited') && seen.at(-1).key === 'key-ok', 'keys were not rotated');
  });
  await step('the rate-limited key is rested: later requests go straight to the good key', async () => {
    seen.length = 0;
    await chat({ model: 'fake-small', messages: [{ role: 'user', content: 'another one' }] });
    assert(seen.length === 1 && seen[0].key === 'key-ok', `saw ${JSON.stringify(seen)}`);
  });
  await step('auto routes a short prompt to the small tier', async () => {
    const res = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    assert(res.headers.get('x-pourgate-tier') === 'small', `tier ${res.headers.get('x-pourgate-tier')}`);
  });
  await step('auto routes a demanding prompt to the large tier', async () => {
    const hard = 'Design and implement a distributed, fault-tolerant consensus algorithm, prove its correctness, analyse the complexity and write the code.\n' + 'x'.repeat(4000);
    const res = await chat({ model: 'auto', messages: [{ role: 'user', content: hard }] });
    assert(res.headers.get('x-pourgate-tier') === 'large', `tier ${res.headers.get('x-pourgate-tier')}`);
  });
  await step('identical requests are served from the cache without calling the provider', async () => {
    const body = { model: 'fake-large', temperature: 0, messages: [{ role: 'user', content: 'cache me' }] };
    await chat(body);
    seen.length = 0;
    const second = await chat(body);
    assert(second.headers.get('x-pourgate-cache') === 'hit', `cache header ${second.headers.get('x-pourgate-cache')}`);
    assert(seen.length === 0, 'provider was called again');
  });
  await step('streaming is passed through', async () => {
    const res = await chat({ model: 'fake-small', stream: true, messages: [{ role: 'user', content: 'stream please' }] });
    const text = await res.text();
    assert(res.headers.get('content-type')?.includes('text/event-stream'), 'not an event stream');
    assert(text.includes('pon') && text.includes('[DONE]'), 'missing chunks');
  });
  await step('/v1/completions and /v1/responses work, including streaming', async () => {
    const h = { 'content-type': 'application/json', authorization: 'Bearer pg-smoke' };
    const comp = await (await fetch(`${base}/v1/completions`, { method: 'POST', headers: h, body: JSON.stringify({ model: 'fake-large', prompt: 'ping', max_tokens: 5 }) })).json();
    assert(comp.object === 'text_completion' && comp.choices[0].text === 'pong', `completions ${JSON.stringify(comp)}`);
    const resp = await (await fetch(`${base}/v1/responses`, { method: 'POST', headers: h, body: JSON.stringify({ model: 'fake-large', input: 'ping uniq-1' }) })).json();
    assert(resp.object === 'response' && resp.output[0].content[0].text === 'pong', `responses ${JSON.stringify(resp)}`);
    const streamed = await (await fetch(`${base}/v1/responses`, { method: 'POST', headers: h, body: JSON.stringify({ model: 'fake-small', input: 'stream uniq-2', stream: true }) })).text();
    assert(streamed.includes('response.output_text.delta') && streamed.includes('response.completed') && streamed.includes('pong'), 'responses stream incomplete');
  });
  await step('profiles route in the configured order and fusion merges a panel', async () => {
    const res = await chat({ model: 'auto:smoke', messages: [{ role: 'user', content: 'profile uniq-3' }] });
    assert(res.status === 200 && res.headers.get('x-pourgate-model') === 'fake-large', `profile served by ${res.headers.get('x-pourgate-model')}`);
    const fusion = await chat({ model: 'fusion', messages: [{ role: 'user', content: 'fusion uniq-4' }] });
    assert(fusion.status === 200 && fusion.headers.get('x-pourgate-fusion')?.includes('judge'), `fusion ${fusion.status} ${fusion.headers.get('x-pourgate-fusion')}`);
  });
  await step('a custom endpoint and pasted keys can be added from the dashboard API', async () => {
    const login = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'smoke-password-123' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const api = (path, body) => fetch(`${base}/admin/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    const added = await api('/custom-providers', { name: 'mine', baseUrl: upstreamUrl, models: 'my-model' });
    assert(added.status === 201, `custom provider ${added.status}`);
    const keys = await (await api('/providers/mine/keys/bulk', { keys: 'custom-key-aaaa\ncustom-key-bbbb\ncustom-key-aaaa' })).json();
    assert(keys.added === 2 && keys.skipped.length === 0, `bulk ${JSON.stringify(keys)}`);
    const res = await chat({ model: 'my-model', messages: [{ role: 'user', content: 'custom uniq-5' }] });
    assert(res.status === 200 && res.headers.get('x-pourgate-provider') === 'mine', `custom served by ${res.headers.get('x-pourgate-provider')}`);
  });
  await step('the dashboard is served', async () => {
    const res = await fetch(`${base}/`);
    assert(res.ok && (await res.text()).includes('<div id="root">'), 'dashboard not served');
  });
  await step('dashboard login, key settings, playground and audit log work', async () => {
    const login = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'smoke-password-123' }) });
    assert(login.status === 204, `login ${login.status}`);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const api = (path, init = {}) => fetch(`${base}/admin/api${path}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...init.headers } });
    const providers = await (await api('/providers')).json();
    assert(providers[0].enabled && providers[0].models[0].circuit === 'closed', 'provider state wrong');
    const play = await (await api('/playground', { method: 'POST', body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hello' }] }) })).json();
    assert(play.ok && play.content === 'pong' && play.route.provider === 'fake', 'playground failed');
    const audit = await (await api('/audit')).json();
    assert(audit.some((e) => e.action === 'login') && audit.some((e) => e.action === 'playground'), 'audit entries missing');
    const token = await (await api('/tokens', { method: 'POST', body: JSON.stringify({ name: 'smoke-client', rpm: 5 }) })).json();
    const viaToken = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${token.token}` } });
    assert(viaToken.ok, 'a freshly created client token does not work');
  });
  await step('metrics require their token', async () => {
    const open = await fetch(`${base}/metrics`);
    assert(open.status === 401, `unauthenticated /metrics gave ${open.status}`);
    const ok = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer metrics-secret' } });
    assert(ok.ok && (await ok.text()).includes('pourgate_'), 'metrics not served with the token');
  });
} catch (err) {
  failed++;
  console.log(`✗ setup\n    ${err instanceof Error ? err.message : err}`);
} finally {
  gateway.kill('SIGTERM');
  upstream.close();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
