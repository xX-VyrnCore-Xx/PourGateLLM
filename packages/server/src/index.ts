import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { KeyPool } from './keypool.js';
import { loadRegistry } from './registry.js';
import { TokenStore } from './tokens.js';

const registry = loadRegistry(resolve(process.env.POURGATE_REGISTRY_DIR ?? 'registry'));
const store = new TokenStore(openDatabase(resolve(process.env.POURGATE_DB ?? 'data/pourgate.db')));

const envTokens = (process.env.POURGATE_TOKENS ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
if (envTokens.length === 0 && store.count() === 0) {
  console.error('No API tokens configured. Set POURGATE_TOKENS or run: pnpm --filter @pourgate/server cli tokens create --name <name>');
  process.exit(1);
}

const pools = new Map<string, KeyPool>();
for (const provider of registry) {
  const keys = (process.env[provider.api_key_env] ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (keys.length === 0) {
    console.warn(`[registry] ${provider.provider}: ${provider.api_key_env} not set, provider disabled`);
    continue;
  }
  pools.set(provider.provider, new KeyPool(keys));
}

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: createApp({ registry, envTokens, store, pools }).fetch, port }, (info) => {
  console.log(`PourGateLLM listening on :${info.port} (${pools.size} provider(s) enabled)`);
});
