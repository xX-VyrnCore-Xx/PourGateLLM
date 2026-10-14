import { serve } from '@hono/node-server';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { KeyStore } from './keys.js';
import { PoolManager } from './pools.js';
import { loadRegistry } from './registry.js';
import { RegistryManager } from './registry-sync.js';
import { loadMasterKey } from './secrets.js';
import { TokenStore } from './tokens.js';

const dbPath = resolve(process.env.POURGATE_DB ?? 'data/pourgate.db');
const db = openDatabase(dbPath);
const store = new TokenStore(db);
const keyStore = new KeyStore(
  db,
  loadMasterKey({
    env: process.env.POURGATE_MASTER_KEY,
    keyfile: resolve(process.env.POURGATE_MASTER_KEY_FILE ?? resolve(dbPath, '..', 'master.key')),
  }),
);
const poolManager = new PoolManager(keyStore);

const overridesDir = resolve(process.env.POURGATE_OVERRIDES_DIR ?? 'overrides');
const pubKeyEnv = process.env.POURGATE_REGISTRY_PUBKEY?.trim();
const manager = new RegistryManager({
  base: loadRegistry(resolve(process.env.POURGATE_REGISTRY_DIR ?? 'registry')),
  overrides: existsSync(overridesDir) ? loadRegistry(overridesDir) : [],
  url: process.env.POURGATE_REGISTRY_URL || undefined,
  // Inline PEM or a path to a PEM file.
  publicKeyPem: pubKeyEnv ? (pubKeyEnv.startsWith('-----BEGIN') ? pubKeyEnv : readFileSync(resolve(pubKeyEnv), 'utf8')) : undefined,
  cachePath: resolve(process.env.POURGATE_REGISTRY_CACHE ?? resolve(dbPath, '..', 'registry-cache.json')),
  onChange: (entries) => poolManager.sync(entries),
});

const envTokens = (process.env.POURGATE_TOKENS ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
if (envTokens.length === 0 && store.count() === 0) {
  console.error('No API tokens configured. Set POURGATE_TOKENS or run: pnpm --filter @pourgate/server cli tokens create --name <name>');
  process.exit(1);
}

manager.loadCache();
poolManager.sync(manager.entries);

if (!process.env.POURGATE_ADMIN_PASSWORD) {
  console.warn('POURGATE_ADMIN_PASSWORD not set: dashboard/admin API disabled (use the CLI to manage tokens)');
}

const port = Number(process.env.PORT ?? 3000);
serve(
  {
    fetch: createApp({
      registry: () => manager.entries,
      registrySync: manager,
      envTokens,
      store,
      pools: poolManager.pools,
      keyStore,
      poolManager,
      adminPassword: process.env.POURGATE_ADMIN_PASSWORD || undefined,
      secureCookie: process.env.POURGATE_COOKIE_SECURE === 'true',
      staticDir: resolve(process.env.POURGATE_STATIC_DIR ?? 'public'),
    }).fetch,
    port,
  },
  (info) => {
    console.log(`PourGateLLM listening on :${info.port} (${poolManager.pools.size} provider(s) enabled)`);
    if (process.env.POURGATE_REGISTRY_URL) {
      const hours = Number(process.env.POURGATE_REGISTRY_SYNC_HOURS ?? 12);
      manager.start(Math.max(0.1, hours) * 3_600_000);
    }
  },
);
