import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { backup, tune } from './dbtools.js';

// Loaded via require: vite-node (vitest) strips the `node:` prefix from node:sqlite, breaking a static import.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncType;

/** Ordered, append-only migrations; the index + 1 is stored in PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `CREATE TABLE api_tokens (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     prefix TEXT NOT NULL,
     rpm_limit INTEGER,
     daily_request_limit INTEGER,
     created_at INTEGER NOT NULL,
     expires_at INTEGER,
     revoked_at INTEGER
   );
   CREATE TABLE token_usage (
     token_id INTEGER NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
     day TEXT NOT NULL,
     requests INTEGER NOT NULL DEFAULT 0,
     tokens INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (token_id, day)
   );`,
  `CREATE TABLE provider_keys (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     provider TEXT NOT NULL,
     label TEXT NOT NULL,
     last4 TEXT NOT NULL,
     ciphertext TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_provider_keys_provider ON provider_keys(provider);`,
  `CREATE TABLE key_usage (
     provider TEXT NOT NULL,
     key_fp TEXT NOT NULL,
     model TEXT NOT NULL,
     day TEXT NOT NULL,
     requests INTEGER NOT NULL DEFAULT 0,
     tokens INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (provider, key_fp, model, day)
   );
   CREATE TABLE key_cooldowns (
     provider TEXT NOT NULL,
     key_fp TEXT NOT NULL,
     until INTEGER NOT NULL,
     PRIMARY KEY (provider, key_fp)
   );`,
  `CREATE TABLE request_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     token_id INTEGER,
     requested TEXT NOT NULL,
     provider TEXT,
     model TEXT,
     tier TEXT,
     complexity TEXT,
     status INTEGER NOT NULL,
     ttfb_ms INTEGER NOT NULL,
     total_ms INTEGER NOT NULL,
     tokens INTEGER,
     stream INTEGER NOT NULL,
     error TEXT
   );
   CREATE INDEX idx_request_log_ts ON request_log(ts);`,
  `ALTER TABLE request_log ADD COLUMN redacted INTEGER;`,
  `ALTER TABLE request_log ADD COLUMN cache TEXT;
   CREATE TABLE response_cache (
     key TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     hits INTEGER NOT NULL DEFAULT 0,
     body TEXT NOT NULL,
     provider TEXT,
     model TEXT,
     tier TEXT,
     complexity TEXT,
     size INTEGER NOT NULL
   );
   CREATE INDEX idx_response_cache_created ON response_cache(created_at);`,
  `CREATE TABLE eval_results (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     task_id TEXT NOT NULL,
     passed INTEGER NOT NULL,
     latency_ms INTEGER NOT NULL,
     error TEXT
   );
   CREATE INDEX idx_eval_results_ts ON eval_results(ts);`,
  `CREATE TABLE observed_limits (
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     limit_requests INTEGER,
     limit_tokens INTEGER,
     observed_at INTEGER NOT NULL,
     PRIMARY KEY (provider, model)
   );`,
  `CREATE TABLE semantic_index (
     key TEXT PRIMARY KEY,
     scope TEXT NOT NULL,
     context TEXT NOT NULL,
     dim INTEGER NOT NULL,
     vector BLOB NOT NULL
   );
   CREATE INDEX idx_semantic_lookup ON semantic_index(scope, context);`,
  `CREATE TABLE audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     action TEXT NOT NULL,
     ip TEXT,
     target TEXT,
     detail TEXT
   );
   CREATE INDEX idx_audit_ts ON audit_log(ts);`,
  `ALTER TABLE provider_keys ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE provider_keys ADD COLUMN weight INTEGER NOT NULL DEFAULT 1;`,
];

/** Number of schema migrations; a database reporting this user_version is up to date. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Opens an existing database without creating, migrating or backing anything up. */
export function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  tune(db);
  migrate(db, path);
  return db;
}

function migrate(db: DatabaseSync, path: string): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  // Keep a copy of an existing database before upgrading its schema, so a bad upgrade can be undone.
  if (path !== ':memory:' && row.user_version > 0 && row.user_version < MIGRATIONS.length) {
    const copy = `${path}.pre-v${row.user_version}.bak`;
    if (!existsSync(copy)) {
      try {
        backup(db, copy);
        console.log(`[db] schema v${row.user_version} -> v${MIGRATIONS.length}: backup written to ${copy}`);
      } catch (err) {
        console.warn(`[db] could not write the pre-migration backup: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
