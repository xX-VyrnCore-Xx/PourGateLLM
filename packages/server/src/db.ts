import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

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
];

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
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
