import type { DatabaseSync } from 'node:sqlite';

/** Admin actions worth keeping a trail of. Never carries secrets: only names, ids and counts. */
export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'login_rate_limited'
  | 'logout'
  | 'token_create'
  | 'token_revoke'
  | 'provider_key_add'
  | 'provider_key_remove'
  | 'registry_sync'
  | 'cache_clear'
  | 'eval_run'
  | 'playground';

export interface AuditEntry {
  id: number;
  ts: number;
  action: AuditAction;
  ip: string | null;
  target: string | null;
  detail: string | null;
}

interface Row {
  id: number;
  ts: number;
  action: string;
  ip: string | null;
  target: string | null;
  detail: string | null;
}

const clip = (s: string | undefined, n: number) => (s === undefined ? null : s.slice(0, n));

export class AuditLog {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  record(action: AuditAction, info: { ip?: string; target?: string; detail?: string } = {}): void {
    try {
      this.db
        .prepare('INSERT INTO audit_log (ts, action, ip, target, detail) VALUES (?, ?, ?, ?, ?)')
        .run(this.now(), action, clip(info.ip, 64), clip(info.target, 200), clip(info.detail, 500));
    } catch (err) {
      // An audit failure must never break the admin action itself.
      console.error('[audit]', err instanceof Error ? err.message : err);
    }
  }

  recent(limit = 100, action?: string): AuditEntry[] {
    const n = Math.min(500, Math.max(1, Math.floor(limit)));
    const rows = (
      action
        ? this.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ?').all(action, n)
        : this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(n)
    ) as unknown as Row[];
    return rows.map((r) => ({ id: r.id, ts: r.ts, action: r.action as AuditAction, ip: r.ip, target: r.target, detail: r.detail }));
  }

  prune(before: number): number {
    return Number(this.db.prepare('DELETE FROM audit_log WHERE ts < ?').run(before).changes);
  }
}
