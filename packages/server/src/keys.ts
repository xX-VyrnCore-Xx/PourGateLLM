import type { DatabaseSync } from 'node:sqlite';
import { decryptSecret, encryptSecret } from './secrets.js';

export interface ProviderKeyRecord {
  id: number;
  provider: string;
  label: string;
  last4: string;
  createdAt: number;
}

interface Row {
  id: number;
  provider: string;
  label: string;
  last4: string;
  ciphertext: string;
  created_at: number;
}

export const MAX_KEYS_PER_PROVIDER = 50;
const toRecord = (r: Row): ProviderKeyRecord => ({
  id: r.id,
  provider: r.provider,
  label: r.label,
  last4: r.last4,
  createdAt: r.created_at,
});

export class KeyStoreError extends Error {}

/** Provider API keys, encrypted at rest (AES-256-GCM, bound to the provider name). */
export class KeyStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly masterKey: Buffer,
    private readonly now: () => number = Date.now,
  ) {}

  add(provider: string, apiKey: string, label?: string): ProviderKeyRecord {
    const key = apiKey.trim();
    if (key.length < 8 || key.length > 500 || /[\s,]/.test(key)) {
      throw new KeyStoreError('API key must be 8-500 characters without spaces or commas');
    }
    if (this.secrets(provider).includes(key)) throw new KeyStoreError('this key is already stored');
    if (this.list(provider).length >= MAX_KEYS_PER_PROVIDER) {
      throw new KeyStoreError(`at most ${MAX_KEYS_PER_PROVIDER} keys per provider`);
    }
    const res = this.db
      .prepare('INSERT INTO provider_keys (provider, label, last4, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(provider, (label ?? '').trim().slice(0, 100), key.slice(-4), encryptSecret(key, this.masterKey, provider), this.now());
    return toRecord(this.db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(Number(res.lastInsertRowid)) as unknown as Row);
  }

  list(provider?: string): ProviderKeyRecord[] {
    const rows = (
      provider === undefined
        ? this.db.prepare('SELECT * FROM provider_keys ORDER BY id').all()
        : this.db.prepare('SELECT * FROM provider_keys WHERE provider = ? ORDER BY id').all(provider)
    ) as unknown as Row[];
    return rows.map(toRecord);
  }

  remove(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM provider_keys WHERE id = ?').run(id).changes) > 0;
  }

  /** Decrypted keys for a provider. Rows that fail to decrypt (wrong master key, tampering) are skipped. */
  secrets(provider: string, onError?: (id: number) => void): string[] {
    const rows = this.db.prepare('SELECT * FROM provider_keys WHERE provider = ? ORDER BY id').all(provider) as unknown as Row[];
    const out: string[] = [];
    for (const r of rows) {
      try {
        out.push(decryptSecret(r.ciphertext, this.masterKey, r.provider));
      } catch {
        onError?.(r.id);
      }
    }
    return out;
  }

  secretById(id: number): { provider: string; key: string } | undefined {
    const r = this.db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(id) as unknown as Row | undefined;
    if (!r) return undefined;
    try {
      return { provider: r.provider, key: decryptSecret(r.ciphertext, this.masterKey, r.provider) };
    } catch {
      return undefined;
    }
  }
}
