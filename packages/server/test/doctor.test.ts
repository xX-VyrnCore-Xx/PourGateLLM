import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { runDoctor } from '../src/doctor.js';
import { KeyStore } from '../src/keys.js';
import { TokenStore } from '../src/tokens.js';

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'pg-doctor-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const registryDir = resolve(__dirname, '../../../registry');
const find = (checks: Awaited<ReturnType<typeof runDoctor>>, name: string) => checks.filter((c) => c.name === name);

describe('doctor', () => {
  it('reports a missing database and missing tokens/keys on a fresh install', async () => {
    const checks = await runDoctor({ env: {}, dbPath: join(dir, 'p.db'), registryDir });
    expect(find(checks, 'Database')[0]!.level).toBe('warn');
    expect(find(checks, 'API tokens')[0]!.level).toBe('fail');
    expect(find(checks, 'Providers')[0]!.level).toBe('fail');
    expect(find(checks, 'Registry')[0]!.level).toBe('ok');
  });

  it('is happy with a configured install and does not modify the database', async () => {
    const dbPath = join(dir, 'p.db');
    const db = openDatabase(dbPath);
    new TokenStore(db).create({ name: 'laptop' });
    const mk = randomBytes(32);
    new KeyStore(db, mk).add('cerebras', 'csk_abcdefghij');
    db.close();
    writeFileSync(join(dir, 'master.key'), `${mk.toString('base64')}\n`, { mode: 0o600 });
    chmodSync(join(dir, 'master.key'), 0o600);
    const checks = await runDoctor({ env: { GROQ_API_KEYS: 'gsk_aaaaaaaa,gsk_bbbbbbbb', POURGATE_ADMIN_PASSWORD: 'a-long-enough-password' }, dbPath, registryDir });
    expect(checks.filter((c) => c.level === 'fail')).toEqual([]);
    expect(find(checks, 'Database')[0]!.detail).toMatch(/integrity ok/);
    expect(find(checks, 'Provider groq')[0]!.detail).toMatch(/2 from GROQ_API_KEYS/);
    expect(find(checks, 'Provider cerebras')[0]!.detail).toMatch(/1 stored/);
    expect(JSON.stringify(checks)).not.toContain('gsk_aaaaaaaa');
  });

  it('flags stored keys without a master key', async () => {
    const dbPath = join(dir, 'p.db');
    const db = openDatabase(dbPath);
    new KeyStore(db, randomBytes(32)).add('groq', 'gsk_abcdefghij');
    db.close();
    const checks = await runDoctor({ env: {}, dbPath, registryDir });
    expect(find(checks, 'Master key')[0]!.level).toBe('fail');
  });

  it('checks keys against providers only when asked, and never prints them', async () => {
    const seen: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push(`${url} ${(init?.headers as Record<string, string>).authorization}`);
      return new Response('{}', { status: String(url).includes('groq') ? 200 : 401 });
    }) as typeof fetch;
    const base = { env: { GROQ_API_KEYS: 'gsk_secret_value', GEMINI_API_KEYS: 'bad_key_value_1' }, dbPath: join(dir, 'p.db'), registryDir, fetch: fetcher };
    const quiet = await runDoctor(base);
    expect(seen).toEqual([]);
    expect(quiet.some((c) => c.name.startsWith('Live'))).toBe(false);
    const live = await runDoctor({ ...base, live: true });
    expect(seen.length).toBe(2);
    expect(live.find((c) => c.name === 'Live groq')!.level).toBe('ok');
    expect(live.find((c) => c.name === 'Live gemini')!.level).toBe('fail');
    expect(JSON.stringify(live)).not.toContain('gsk_secret_value');
  });

  it('probes a running gateway', async () => {
    const fetcher = (async (url: string) =>
      String(url).endsWith('/health') ? new Response('ok') : Response.json({ data: [{ id: 'a' }, { id: 'b' }] })) as typeof fetch;
    const checks = await runDoctor({ env: {}, dbPath: join(dir, 'p.db'), registryDir, url: 'http://gw.test/', token: 't', fetch: fetcher });
    expect(find(checks, 'Gateway')[0]!.level).toBe('ok');
    expect(find(checks, 'Gateway API')[0]!.detail).toBe('2 models listed');
    const down = await runDoctor({ env: {}, dbPath: join(dir, 'p.db'), registryDir, url: 'http://gw.test', fetch: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch });
    expect(find(down, 'Gateway')[0]!.level).toBe('fail');
  });
});
