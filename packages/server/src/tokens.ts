import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface TokenRecord {
  id: number;
  name: string;
  prefix: string;
  rpmLimit: number | null;
  dailyRequestLimit: number | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

export interface CreateTokenInput {
  name: string;
  rpmLimit?: number;
  dailyRequestLimit?: number;
  expiresAt?: number;
}

interface Row {
  id: number;
  name: string;
  prefix: string;
  rpm_limit: number | null;
  daily_request_limit: number | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const toRecord = (r: Row): TokenRecord => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  rpmLimit: r.rpm_limit,
  dailyRequestLimit: r.daily_request_limit,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
});

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Client API tokens are stored as SHA-256 hashes; the plaintext is shown only at creation. */
export class TokenStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: CreateTokenInput): { token: string; record: TokenRecord } {
    const token = `pg-${randomBytes(24).toString('base64url')}`;
    const res = this.db
      .prepare(
        `INSERT INTO api_tokens (name, token_hash, prefix, rpm_limit, daily_request_limit, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        hash(token),
        token.slice(0, 8),
        input.rpmLimit ?? null,
        input.dailyRequestLimit ?? null,
        this.now(),
        input.expiresAt ?? null,
      );
    return { token, record: this.get(Number(res.lastInsertRowid))! };
  }

  get(id: number): TokenRecord | undefined {
    const row = this.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as Row | undefined;
    return row && toRecord(row);
  }

  /** Returns the record for a valid, non-revoked, non-expired token. */
  verify(token: string): TokenRecord | undefined {
    const row = this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(hash(token)) as
      | Row
      | undefined;
    if (!row || row.revoked_at !== null) return undefined;
    if (row.expires_at !== null && row.expires_at <= this.now()) return undefined;
    return toRecord(row);
  }

  list(): TokenRecord[] {
    return (this.db.prepare('SELECT * FROM api_tokens ORDER BY id').all() as unknown as Row[]).map(toRecord);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at IS NULL').get() as { n: number })
      .n;
  }

  revoke(id: number): boolean {
    const res = this.db
      .prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(this.now(), id);
    return Number(res.changes) > 0;
  }

  requestsToday(id: number): number {
    const row = this.db
      .prepare('SELECT requests FROM token_usage WHERE token_id = ? AND day = ?')
      .get(id, utcDay(this.now())) as { requests: number } | undefined;
    return row?.requests ?? 0;
  }

  usageToday(id: number): { requests: number; tokens: number } {
    const row = this.db
      .prepare('SELECT requests, tokens FROM token_usage WHERE token_id = ? AND day = ?')
      .get(id, utcDay(this.now())) as { requests: number; tokens: number } | undefined;
    return row ?? { requests: 0, tokens: 0 };
  }

  recordRequest(id: number): void {
    this.db
      .prepare(
        `INSERT INTO token_usage (token_id, day, requests) VALUES (?, ?, 1)
         ON CONFLICT(token_id, day) DO UPDATE SET requests = requests + 1`,
      )
      .run(id, utcDay(this.now()));
  }

  recordTokens(id: number, tokens: number): void {
    this.db
      .prepare(
        `INSERT INTO token_usage (token_id, day, tokens) VALUES (?, ?, ?)
         ON CONFLICT(token_id, day) DO UPDATE SET tokens = tokens + excluded.tokens`,
      )
      .run(id, utcDay(this.now()), tokens);
  }
}
