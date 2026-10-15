import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { backup, check, maintain, stats } from '../src/dbtools.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'pg-db-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('database tools', () => {
  it('applies the tuned pragmas', () => {
    const db = openDatabase(join(dir, 'a.db'));
    expect((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5000);
    expect((db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(1);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    db.close();
  });

  it('reports stats, passes the check and optimizes', () => {
    const path = join(dir, 'a.db');
    const db = openDatabase(path);
    db.prepare("INSERT INTO audit_log (ts, action) VALUES (1, 'login')").run();
    const s = stats(db, path);
    expect(s.tables.audit_log).toBe(1);
    expect(s.schemaVersion).toBeGreaterThanOrEqual(10);
    expect(check(db)).toEqual({ ok: true, integrity: ['ok'], foreignKeyViolations: 0 });
    expect(() => maintain(db)).not.toThrow();
    db.close();
  });

  it('writes an owner-only backup and refuses to overwrite', () => {
    const db = openDatabase(join(dir, 'a.db'));
    db.prepare("INSERT INTO audit_log (ts, action) VALUES (1, 'login')").run();
    const out = join(dir, 'copy.db');
    backup(db, out);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(() => backup(db, out)).toThrow(/already exists/);
    const copy = openDatabase(out);
    expect(stats(copy).tables.audit_log).toBe(1);
    copy.close();
    db.close();
  });

  it('copies an outdated database before migrating it', () => {
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, token_hash TEXT NOT NULL UNIQUE, prefix TEXT, rpm_limit INTEGER, daily_request_limit INTEGER, created_at INTEGER, expires_at INTEGER, revoked_at INTEGER);');
    old.exec('CREATE TABLE token_usage (token_id INTEGER, day TEXT, requests INTEGER, tokens INTEGER, PRIMARY KEY (token_id, day));');
    old.exec('PRAGMA user_version = 1');
    old.close();
    const db = openDatabase(path);
    expect(existsSync(`${path}.pre-v1.bak`)).toBe(true);
    db.close();
    // A second open on an up-to-date schema writes nothing new.
    openDatabase(path).close();
    expect(existsSync(`${path}.pre-v11.bak`)).toBe(false);
  });
});
