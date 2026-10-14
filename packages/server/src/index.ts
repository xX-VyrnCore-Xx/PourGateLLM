import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { KeyPool } from './keypool.js';
import { loadRegistry } from './registry.js';

const registryDir = resolve(process.env.POURGATE_REGISTRY_DIR ?? 'registry');
const registry = loadRegistry(registryDir);

const tokens = (process.env.POURGATE_TOKENS ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
if (tokens.length === 0) {
  console.error('POURGATE_TOKENS is required (comma-separated client tokens).');
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
serve({ fetch: createApp({ registry, tokens, pools }).fetch, port }, (info) => {
  console.log(`PourGateLLM listening on :${info.port} (${pools.size} provider(s) enabled)`);
});
