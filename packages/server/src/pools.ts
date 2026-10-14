import type { ProviderEntry } from '@pourgate/shared';
import type { KeyStore } from './keys.js';
import { KeyPool } from './keypool.js';

/** Builds one KeyPool per provider from environment keys plus keys stored in the database. */
export class PoolManager {
  readonly pools = new Map<string, KeyPool>();
  private entries: ProviderEntry[] = [];
  private readonly warned = new Set<string>();

  constructor(
    private readonly keyStore: KeyStore | undefined,
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly log: (msg: string) => void = console.warn,
  ) {}

  envKeys(entry: ProviderEntry): string[] {
    return (this.env[entry.api_key_env] ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
  }

  sync(entries: ProviderEntry[]): void {
    this.entries = entries;
    this.refresh();
  }

  /** Re-reads keys for every provider (call after keys are added/removed). */
  refresh(): void {
    const names = new Set(this.entries.map((e) => e.provider));
    for (const name of [...this.pools.keys()]) if (!names.has(name)) this.pools.delete(name);
    for (const entry of this.entries) {
      const dbKeys =
        this.keyStore?.secrets(entry.provider, (id) =>
          this.log(`[keys] could not decrypt stored key #${id} for ${entry.provider} (wrong master key?)`),
        ) ?? [];
      const keys = [...new Set([...this.envKeys(entry), ...dbKeys])];
      const pool = this.pools.get(entry.provider);
      if (keys.length === 0) {
        this.pools.delete(entry.provider);
        if (!this.warned.has(entry.provider)) {
          this.warned.add(entry.provider);
          this.log(`[registry] ${entry.provider}: no API key (${entry.api_key_env} or dashboard), provider disabled`);
        }
      } else if (pool) {
        pool.setKeys(keys);
      } else {
        this.pools.set(entry.provider, new KeyPool(keys));
      }
    }
  }
}
