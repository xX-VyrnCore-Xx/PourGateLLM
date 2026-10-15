import { chmodSync, existsSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

/** Tables shown by `db stats` (names are fixed here, never user input). */
const TABLES = [
  'api_tokens',
  'token_usage',
  'provider_keys',
  'key_usage',
  'key_cooldowns',
  'request_log',
  'response_cache',
  'eval_results',
  'observed_limits',
  'semantic_index',
  'audit_log',
] as const;

/** Connection settings suited to a small, write-light, single-process server. */
export function tune(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;      -- CLI and server may touch the file at the same time
    PRAGMA synchronous = NORMAL;     -- safe with WAL: a crash can lose the last commit, never corrupt
    PRAGMA temp_store = MEMORY;
    PRAGMA journal_size_limit = 67108864;
  `);
}

/** Routine upkeep: refresh planner statistics and shrink the WAL file. */
export function maintain(db: DatabaseSync): void {
  db.exec('PRAGMA optimize');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

/**
 * Writes a consistent, compacted copy using VACUUM INTO (safe while the server runs).
 * The copy holds encrypted provider keys and token hashes, so it is created owner-only.
 */
export function backup(db: DatabaseSync, outPath: string): void {
  if (existsSync(outPath)) throw new Error(`${outPath} already exists; refusing to overwrite`);
  db.prepare('VACUUM INTO ?').run(outPath);
  chmodSync(outPath, 0o600);
}

export interface CheckResult {
  ok: boolean;
  integrity: string[];
  foreignKeyViolations: number;
}

export function check(db: DatabaseSync): CheckResult {
  const integrity = (db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((r) => r.integrity_check);
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  return { ok: integrity.length === 1 && integrity[0] === 'ok' && foreignKeyViolations === 0, integrity, foreignKeyViolations };
}

export interface DbStats {
  schemaVersion: number;
  fileBytes: number | null;
  walBytes: number | null;
  tables: Record<string, number>;
}

export function stats(db: DatabaseSync, path?: string): DbStats {
  const size = (p: string) => (existsSync(p) ? statSync(p).size : null);
  const tables: Record<string, number> = {};
  for (const t of TABLES) {
    tables[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return {
    schemaVersion: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    fileBytes: path ? size(path) : null,
    walBytes: path ? size(`${path}-wal`) : null,
    tables,
  };
}
