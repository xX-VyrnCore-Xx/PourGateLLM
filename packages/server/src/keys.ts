import type { DatabaseSync } from 'node:sqlite';
import { decryptSecret, encryptSecret } from './secrets.js';

export interface ProviderKeyRecord {
  id: number;
  provider: string;
  label: string;
  last4: string;
  createdAt: number;
  /** A disabled key stays stored but is never used. */
  enabled: boolean;
  /** Relative share of this provider's traffic (1-10). */
  weight: number;
}

interface Row {
  id: number;
  provider: string;
  label: string;
  last4: string;
  ciphertext: string;
  created_at: number;
  enabled: number;
  weight: number;
}

export const MAX_KEYS_PER_PROVIDER = 50;
const toRecord = (r: Row): ProviderKeyRecord => ({
  id: r.id,
  provider: r.provider,
  label: r.label,
  last4: r.last4,
  createdAt: r.created_at,
  enabled: r.enabled !== 0,
  weight: r.weight,
});

export const MAX_WEIGHT = 10;

export class KeyStoreError extends Error {}

/** Provider API keys, encrypted at rest (AES-256-GCM, bound to the provider name). */
export class KeyStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly masterKey: Buffer,
    private readonly now: () => number = Date.now,
  ) {}

  add(provider: string, apiKey: string, label?: string, weight = 1): ProviderKeyRecord {
    if (!Number.isInteger(weight) || weight < 1 || weight > MAX_WEIGHT) throw new KeyStoreError(`weight must be an integer from 1 to ${MAX_WEIGHT}`);
    const key = apiKey.trim();
    if (key.length < 8 || key.length > 500 || /[\s,]/.test(key)) {
      throw new KeyStoreError('API key must be 8-500 characters without spaces or commas');
    }
    if (this.secrets(provider).includes(key)) throw new KeyStoreError('this key is already stored');
    if (this.list(provider).length >= MAX_KEYS_PER_PROVIDER) {
      throw new KeyStoreError(`at most ${MAX_KEYS_PER_PROVIDER} keys per provider`);
    }
    const res = this.db
      .prepare('INSERT INTO provider_keys (provider, label, last4, ciphertext, created_at, weight) VALUES (?, ?, ?, ?, ?, ?)')
      .run(provider, (label ?? '').trim().slice(0, 100), key.slice(-4), encryptSecret(key, this.masterKey, provider), this.now(), weight);
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

  /** Changes the label, the on/off switch or the traffic weight of a stored key. Returns false if it does not exist. */
  update(id: number, patch: { label?: string; enabled?: boolean; weight?: number }): boolean {
    if (patch.weight !== undefined && (!Number.isInteger(patch.weight) || patch.weight < 1 || patch.weight > MAX_WEIGHT)) {
      throw new KeyStoreError(`weight must be an integer from 1 to ${MAX_WEIGHT}`);
    }
    const row = this.db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(id) as unknown as Row | undefined;
    if (!row) return false;
    this.db
      .prepare('UPDATE provider_keys SET label = ?, enabled = ?, weight = ? WHERE id = ?')
      .run(
        patch.label === undefined ? row.label : patch.label.trim().slice(0, 100),
        patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
        patch.weight ?? row.weight,
        id,
      );
    return true;
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

  /** Enabled keys with their weights, for building the provider pool. */
  active(provider: string, onError?: (id: number) => void): { key: string; weight: number }[] {
    const rows = this.db.prepare('SELECT * FROM provider_keys WHERE provider = ? AND enabled = 1 ORDER BY id').all(provider) as unknown as Row[];
    const out: { key: string; weight: number }[] = [];
    for (const r of rows) {
      try {
        out.push({ key: decryptSecret(r.ciphertext, this.masterKey, r.provider), weight: r.weight });
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
