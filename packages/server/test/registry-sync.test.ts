import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProviderEntry } from '@pourgate/shared';
import { loadRegistry } from '../src/registry.js';
import {
  RegistryManager,
  applyOverrides,
  applyRemote,
  buildBundle,
  generateSigningKeys,
  isKeyEnvName,
  isPublicHttpsUrl,
  signBundle,
} from '../src/registry-sync.js';

const model = (id: string, rpm?: number) => ({ id, capabilities: ['chat' as const], limits: rpm ? { rpm } : {}, quirks: [] });
const prov = (name: string, models = [model('m1')], extra: Partial<ProviderEntry> = {}): ProviderEntry => ({
  provider: name,
  base_url: `https://api.${name}.test/v1`,
  api_key_env: `${name.toUpperCase()}_API_KEYS`,
  auth: 'bearer',
  models,
  ...extra,
});

const LOCAL = [prov('groq')];
const URL_ = 'https://registry.test/registry.json';

/** Fake fetch serving {url: body}; missing urls 404. */
function serve(files: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const body = files[String(input)];
    return body === undefined ? new Response('nope', { status: 404 }) : new Response(body);
  }) as typeof fetch;
}

describe('url and env policy', () => {
  it('only accepts public https endpoints', () => {
    expect(isPublicHttpsUrl('https://api.groq.com/openai/v1')).toBe(true);
    for (const bad of ['http://api.groq.com', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://169.254.169.254/x', 'https://192.168.1.1/x', 'https://172.20.0.1/x', 'https://foo.local/x', 'https://[::1]/x', 'not a url']) {
      expect(isPublicHttpsUrl(bad), bad).toBe(false);
    }
  });

  it('only accepts *_API_KEYS env names', () => {
    expect(isKeyEnvName('GROQ_API_KEYS')).toBe(true);
    for (const bad of ['POURGATE_TOKENS', 'POURGATE_ADMIN_PASSWORD', 'API_KEYS', 'HOME', 'groq_API_KEYS']) {
      expect(isKeyEnvName(bad), bad).toBe(false);
    }
  });
});

describe('applyRemote', () => {
  const bundle = (providers: ProviderEntry[]) => ({ version: 1, generated_at: 'x', providers });

  it('unsigned: updates models but never endpoints or key env of shipped providers', () => {
    const evil = prov('groq', [model('m2', 5)], { base_url: 'https://evil.test/v1', api_key_env: 'POURGATE_TOKENS' });
    const { entries } = applyRemote(LOCAL, bundle([evil]), false);
    expect(entries[0]!.models.map((m) => m.id)).toEqual(['m2']);
    expect(entries[0]!.base_url).toBe('https://api.groq.test/v1');
    expect(entries[0]!.api_key_env).toBe('GROQ_API_KEYS');
  });

  it('unsigned: refuses new providers', () => {
    const { entries, ignored } = applyRemote(LOCAL, bundle([prov('newco')]), false);
    expect(entries.map((e) => e.provider)).toEqual(['groq']);
    expect(ignored[0]).toMatch(/signed/);
  });

  it('signed: accepts new providers but still blocks unsafe endpoints/env names', () => {
    const ok = prov('newco');
    const privateIp = prov('bad1', [model('m')], { base_url: 'https://10.0.0.1/v1' });
    const stealer = prov('bad2', [model('m')], { api_key_env: 'POURGATE_TOKENS' });
    const { entries, ignored } = applyRemote(LOCAL, bundle([ok, privateIp, stealer]), true);
    expect(entries.map((e) => e.provider)).toEqual(['groq', 'newco']);
    expect(ignored).toHaveLength(2);
  });
});

describe('applyOverrides', () => {
  it('merges models by id, overrides fields and adds providers', () => {
    const base = [prov('groq', [model('a', 10), model('b')])];
    const out = applyOverrides(base, [prov('groq', [model('a', 99), model('c')], { trains_on_prompts: true }), prov('mine')]);
    expect(out.map((p) => p.provider)).toEqual(['groq', 'mine']);
    const groq = out[0]!;
    expect(groq.models.map((m) => [m.id, m.limits.rpm])).toEqual([['a', 99], ['b', undefined], ['c', undefined]]);
    expect(groq.trains_on_prompts).toBe(true);
  });
});

describe('RegistryManager (unsigned)', () => {
  it('applies a remote update, then reports unchanged, and rejects rollback', async () => {
    const v2 = buildBundle([prov('groq', [model('m9')])], 2);
    const files: Record<string, string> = { [URL_]: v2 };
    const mgr = new RegistryManager({ base: LOCAL, url: URL_, fetch: (...a) => serve(files)(...a) });
    expect((await mgr.sync()).lastResult).toBe('updated');
    expect(mgr.entries[0]!.models[0]!.id).toBe('m9');
    expect((await mgr.sync()).lastResult).toBe('unchanged');
    files[URL_] = buildBundle([prov('groq', [model('old')])], 1);
    const res = await mgr.sync();
    expect(res.lastResult).toBe('rejected');
    expect(res.detail).toMatch(/rollback/);
    expect(mgr.entries[0]!.models[0]!.id).toBe('m9');
  });

  it('keeps the last good registry on network errors and invalid bundles', async () => {
    const files: Record<string, string> = { [URL_]: buildBundle([prov('groq', [model('good')])], 5) };
    const mgr = new RegistryManager({ base: LOCAL, url: URL_, fetch: (...a) => serve(files)(...a) });
    await mgr.sync();
    delete files[URL_];
    expect((await mgr.sync()).lastResult).toBe('error');
    files[URL_] = '{"version":9,"generated_at":"x","providers":[{"provider":"x"}]}';
    expect((await mgr.sync()).lastResult).toBe('rejected');
    files[URL_] = 'not json';
    expect((await mgr.sync()).lastResult).toBe('rejected');
    expect(mgr.entries[0]!.models[0]!.id).toBe('good');
  });

  it('rejects oversized bundles and non-https urls', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const mgr = new RegistryManager({ base: LOCAL, url: URL_, fetch: serve({ [URL_]: big }) });
    expect((await mgr.sync()).lastResult).toMatch(/error|rejected/);
    const http = new RegistryManager({ base: LOCAL, url: 'http://registry.test/r.json', fetch: serve({}) });
    expect((await http.sync()).detail).toMatch(/https/);
  });
});

describe('RegistryManager (signed)', () => {
  const keys = generateSigningKeys();
  const bundle = buildBundle([prov('groq', [model('m2')]), prov('newco')], 10);
  const sig = signBundle(bundle, keys.privatePem);
  const make = (files: Record<string, string>, extra = {}) =>
    new RegistryManager({ base: LOCAL, url: URL_, publicKeyPem: keys.publicPem, fetch: serve(files), ...extra });

  it('accepts a correctly signed bundle, including new providers', async () => {
    const mgr = make({ [URL_]: bundle, [`${URL_}.sig`]: sig });
    expect((await mgr.sync()).lastResult).toBe('updated');
    expect(mgr.entries.map((e) => e.provider)).toEqual(['groq', 'newco']);
  });

  it('rejects missing, wrong and foreign signatures and tampered content', async () => {
    const other = generateSigningKeys();
    const cases: Record<string, string>[] = [
      { [URL_]: bundle },
      { [URL_]: bundle, [`${URL_}.sig`]: 'AAAA' },
      { [URL_]: bundle, [`${URL_}.sig`]: signBundle(bundle, other.privatePem) },
      { [URL_]: bundle.replace('m2', 'm3'), [`${URL_}.sig`]: sig },
    ];
    for (const files of cases) {
      const mgr = make(files);
      const res = await mgr.sync();
      expect(res.lastResult).toBe('rejected');
      expect(mgr.entries).toEqual(LOCAL);
    }
  });

  it('restores from cache on restart and re-verifies it', async () => {
    const cachePath = join(mkdtempSync(join(tmpdir(), 'pg-reg-')), 'cache.json');
    await make({ [URL_]: bundle, [`${URL_}.sig`]: sig }, { cachePath }).sync();

    const restarted = make({}, { cachePath });
    restarted.loadCache();
    expect(restarted.entries.map((e) => e.provider)).toEqual(['groq', 'newco']);

    // tamper with the cached bundle: signature no longer matches, cache is ignored
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    cached.bundle = cached.bundle.replace('m2', 'evil');
    writeFileSync(cachePath, JSON.stringify(cached));
    const tampered = make({}, { cachePath });
    tampered.loadCache();
    expect(tampered.entries).toEqual(LOCAL);
  });
});

describe('bundle building', () => {
  it('builds a valid bundle from the shipped registry', () => {
    const entries = loadRegistry(resolve(__dirname, '../../../registry'));
    const parsed = JSON.parse(buildBundle(entries, 1)) as { providers: unknown[]; version: number };
    expect(parsed.version).toBe(1);
    expect(parsed.providers).toHaveLength(entries.length);
  });
});
