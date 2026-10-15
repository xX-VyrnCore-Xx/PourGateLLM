import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCHEMA_VERSION, openReadOnly } from './db.js';
import { check as checkDb } from './dbtools.js';
import { KeyStore } from './keys.js';
import { loadRegistry } from './registry.js';
import { parseMasterKey } from './secrets.js';

export type Level = 'ok' | 'warn' | 'fail';
export interface Check {
  level: Level;
  name: string;
  detail: string;
}

export interface DoctorOptions {
  env: NodeJS.ProcessEnv;
  dbPath: string;
  registryDir: string;
  /** Also try every provider key against its provider (sends the key to that provider, like normal use). */
  live?: boolean;
  /** A running gateway to probe (`/health`, and `/v1/models` when `token` is given). */
  url?: string;
  token?: string;
  fetch?: typeof fetch;
}

const split = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Read-only diagnosis of an installation. Never creates or changes files, never prints secrets. */
export async function runDoctor(o: DoctorOptions): Promise<Check[]> {
  const out: Check[] = [];
  const add = (level: Level, name: string, detail: string) => out.push({ level, name, detail });
  const doFetch = o.fetch ?? fetch;

  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) add('ok', 'Node.js', process.versions.node);
  else add('fail', 'Node.js', `${process.versions.node} is too old: 22.13 or newer is required`);

  // Registry
  let registry: ReturnType<typeof loadRegistry> = [];
  try {
    registry = loadRegistry(o.registryDir);
    add('ok', 'Registry', `${registry.length} providers, ${registry.reduce((n, p) => n + p.models.length, 0)} models (${o.registryDir})`);
  } catch (err) {
    add('fail', 'Registry', err instanceof Error ? err.message : String(err));
  }

  // Database
  let db: ReturnType<typeof openReadOnly> | undefined;
  if (!existsSync(o.dbPath)) {
    add('warn', 'Database', `${o.dbPath} does not exist yet (it is created on first start)`);
  } else {
    try {
      db = openReadOnly(o.dbPath);
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      const integrity = checkDb(db);
      if (!integrity.ok) add('fail', 'Database', `integrity problems: ${integrity.integrity.join('; ')}`);
      else if (version < SCHEMA_VERSION) add('warn', 'Database', `schema v${version}, will upgrade to v${SCHEMA_VERSION} on next start (a backup is written first)`);
      else if (version > SCHEMA_VERSION) add('fail', 'Database', `schema v${version} is newer than this version (v${SCHEMA_VERSION}): upgrade PourGateLLM`);
      else add('ok', 'Database', `schema v${version}, integrity ok`);
    } catch (err) {
      add('fail', 'Database', err instanceof Error ? err.message : String(err));
    }
  }

  // Access
  const envTokens = split(o.env.POURGATE_TOKENS).length;
  let dbTokens = 0;
  try {
    dbTokens = db ? (db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at IS NULL').get() as { n: number }).n : 0;
  } catch {
    // table missing on a brand-new or partial database
  }
  if (envTokens + dbTokens === 0) add('fail', 'API tokens', 'none configured: set POURGATE_TOKENS or run "tokens create"');
  else add('ok', 'API tokens', `${envTokens} from environment, ${dbTokens} active in the database`);
  const pw = o.env.POURGATE_ADMIN_PASSWORD ?? '';
  if (!pw) add('warn', 'Dashboard', 'POURGATE_ADMIN_PASSWORD is not set: the dashboard and admin API are disabled');
  else if (pw.length < 12) add('warn', 'Dashboard', 'admin password is shorter than 12 characters');
  else add('ok', 'Dashboard', 'admin password set');

  // Provider keys: environment plus stored (encrypted) ones
  const keyfile = resolve(o.env.POURGATE_MASTER_KEY_FILE ?? resolve(dirname(o.dbPath), 'master.key'));
  let masterKey: Buffer | undefined;
  try {
    if (o.env.POURGATE_MASTER_KEY?.trim()) masterKey = parseMasterKey(o.env.POURGATE_MASTER_KEY);
    else if (existsSync(keyfile)) masterKey = parseMasterKey(readFileSync(keyfile, 'utf8'));
  } catch (err) {
    add('fail', 'Master key', err instanceof Error ? err.message : String(err));
  }
  let storedKeys: { provider: string; enabled: number }[] = [];
  try {
    storedKeys = db ? (db.prepare('SELECT provider, enabled FROM provider_keys').all() as unknown as typeof storedKeys) : [];
  } catch {
    // no provider_keys table yet
  }
  if (storedKeys.length > 0 && !masterKey) add('fail', 'Master key', `${storedKeys.length} stored provider keys but no master key (POURGATE_MASTER_KEY or ${keyfile})`);
  else if (masterKey) {
    add('ok', 'Master key', o.env.POURGATE_MASTER_KEY?.trim() ? 'from POURGATE_MASTER_KEY' : keyfile);
    if (process.platform !== 'win32' && !o.env.POURGATE_MASTER_KEY?.trim() && existsSync(keyfile) && (statSync(keyfile).mode & 0o077) !== 0) {
      add('warn', 'Master key file', `${keyfile} is readable by other users: chmod 600`);
    }
  }

  let providersWithKeys = 0;
  for (const p of registry) {
    const fromEnv = split(o.env[p.api_key_env]).length;
    const stored = storedKeys.filter((k) => k.provider === p.provider);
    const enabled = stored.filter((k) => k.enabled !== 0).length;
    const total = fromEnv + enabled;
    if (total > 0) providersWithKeys++;
    const parts = [`${fromEnv} from ${p.api_key_env}`, `${enabled} stored`];
    if (stored.length > enabled) parts.push(`${stored.length - enabled} paused`);
    add(total > 0 ? 'ok' : 'warn', `Provider ${p.provider}`, total > 0 ? parts.join(', ') : `no enabled key (${p.api_key_env} or dashboard): provider disabled`);
  }
  if (registry.length > 0 && providersWithKeys === 0) add('fail', 'Providers', 'no provider has a key: nothing can answer requests yet');

  // Optional live checks
  if (o.live) {
    const store = db && masterKey ? new KeyStore(db as never, masterKey) : undefined;
    for (const p of registry) {
      const keys = [
        ...split(o.env[p.api_key_env]).map((key, i) => ({ key, label: `${p.api_key_env}[${i + 1}]` })),
        ...(store ? store.active(p.provider).map((k, i) => ({ key: k.key, label: `stored #${i + 1}` })) : []),
      ];
      for (const { key, label } of keys) {
        try {
          const res = await doFetch(`${p.base_url.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
          await res.body?.cancel();
          if (res.ok) add('ok', `Live ${p.provider}`, `${label}: key accepted`);
          else if (res.status === 401 || res.status === 403) add('fail', `Live ${p.provider}`, `${label}: rejected (HTTP ${res.status}), check the key`);
          else add('warn', `Live ${p.provider}`, `${label}: HTTP ${res.status}`);
        } catch (err) {
          add('warn', `Live ${p.provider}`, `${label}: unreachable (${err instanceof Error ? err.message : err})`);
        }
      }
    }
  }

  // Optional probe of a running gateway
  if (o.url) {
    const base = o.url.replace(/\/$/, '');
    try {
      const res = await doFetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
      await res.body?.cancel();
      add(res.ok ? 'ok' : 'fail', 'Gateway', `${base}/health -> HTTP ${res.status}`);
      if (res.ok && o.token) {
        const models = await doFetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(5000) });
        if (models.ok) add('ok', 'Gateway API', `${((await models.json()) as { data: unknown[] }).data.length} models listed`);
        else add('fail', 'Gateway API', `/v1/models -> HTTP ${models.status} (is the token valid?)`);
      }
    } catch (err) {
      add('fail', 'Gateway', `${base} is not reachable (${err instanceof Error ? err.message : err})`);
    }
  }

  db?.close();
  return out;
}

export const symbol = (l: Level) => (l === 'ok' ? '✓' : l === 'warn' ? '!' : '✗');
