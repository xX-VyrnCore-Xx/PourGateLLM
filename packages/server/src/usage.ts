import { createHmac } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DailyUsage, UsageBackend } from './keypool.js';

/** HMAC of the key under the master key: stable for a key, useless without the master key. */
export const makeFingerprint = (masterKey: Buffer) => (key: string) =>
  createHmac('sha256', masterKey).update(`pourgate-key-fp:${key}`).digest('hex').slice(0, 24);

/** SQLite-backed per-(key, model) usage and cooldowns for one provider. */
export class SqliteUsage implements UsageBackend {
  constructor(
    private readonly db: DatabaseSync,
    private readonly provider: string,
    private readonly now: () => number = Date.now,
  ) {}

  daily(fp: string, model: string, day: string): DailyUsage {
    const row = this.db
      .prepare('SELECT requests, tokens FROM key_usage WHERE provider = ? AND key_fp = ? AND model = ? AND day = ?')
      .get(this.provider, fp, model, day) as DailyUsage | undefined;
    return row ? { requests: row.requests, tokens: row.tokens } : { requests: 0, tokens: 0 };
  }

  addRequest(fp: string, model: string, day: string): void {
    this.db
      .prepare(
        `INSERT INTO key_usage (provider, key_fp, model, day, requests) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(provider, key_fp, model, day) DO UPDATE SET requests = requests + 1`,
      )
      .run(this.provider, fp, model, day);
  }

  addTokens(fp: string, model: string, day: string, tokens: number): void {
    this.db
      .prepare(
        `INSERT INTO key_usage (provider, key_fp, model, day, tokens) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider, key_fp, model, day) DO UPDATE SET tokens = tokens + excluded.tokens`,
      )
      .run(this.provider, fp, model, day, tokens);
  }

  totalToday(model: string, day: string): DailyUsage {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(tokens), 0) AS tokens FROM key_usage WHERE provider = ? AND model = ? AND day = ?',
      )
      .get(this.provider, model, day) as unknown as DailyUsage;
    return { requests: row.requests, tokens: row.tokens };
  }

  cooldowns(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT key_fp, until FROM key_cooldowns WHERE provider = ? AND until > ?')
      .all(this.provider, this.now()) as unknown as { key_fp: string; until: number }[];
    return new Map(rows.map((r) => [r.key_fp, r.until]));
  }

  setCooldown(fp: string, until: number): void {
    this.db
      .prepare(
        `INSERT INTO key_cooldowns (provider, key_fp, until) VALUES (?, ?, ?)
         ON CONFLICT(provider, key_fp) DO UPDATE SET until = excluded.until`,
      )
      .run(this.provider, fp, until);
  }
}

/** Drops counters older than `keepDays` and expired cooldowns. */
export function pruneUsage(db: DatabaseSync, now = Date.now(), keepDays = 7): void {
  const cutoff = new Date(now - keepDays * 86_400_000).toISOString().slice(0, 10);
  db.prepare('DELETE FROM key_usage WHERE day < ?').run(cutoff);
  db.prepare('DELETE FROM key_cooldowns WHERE until <= ?').run(now);
}
