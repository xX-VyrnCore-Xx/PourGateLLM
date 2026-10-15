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
import { ResponseCache, parseCacheMode } from './cache.js';
import { EvalRunner, EvalStore, loadSuite, parseStrategy, type ModelScore } from './evals.js';
import { Metrics } from './metrics.js';
import { parsePiiMode, parsePolicy } from './privacy.js';
import { Tracer, parseHeaders } from './otel.js';
import { PluginHost } from './plugins.js';
import { SemanticIndex } from './semantic.js';
import { ObservedLimits } from './ratelimits.js';
import { AuditLog } from './audit.js';
import { RequestLog } from './requestlog.js';
import { TokenStore } from './tokens.js';
import { SqliteUsage, makeFingerprint, pruneUsage } from './usage.js';

let privacy;
try {
  privacy = { pii: parsePiiMode(process.env.POURGATE_PII_MODE), policy: parsePolicy(process.env.POURGATE_PRIVACY_POLICY) };
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const dbPath = resolve(process.env.POURGATE_DB ?? 'data/pourgate.db');
const db = openDatabase(dbPath);
const store = new TokenStore(db);
const masterKey = loadMasterKey({
  env: process.env.POURGATE_MASTER_KEY,
  keyfile: resolve(process.env.POURGATE_MASTER_KEY_FILE ?? resolve(dbPath, '..', 'master.key')),
});
const keyStore = new KeyStore(db, masterKey);
const fingerprint = makeFingerprint(masterKey);
const poolManager = new PoolManager(keyStore, process.env, console.warn, (provider) => ({
  backend: new SqliteUsage(db, provider),
  fingerprint,
}));
const requestLog = new RequestLog(db);
const audit = new AuditLog(db);
let plugins: PluginHost;
try {
  plugins = await PluginHost.load(process.env.POURGATE_PLUGINS_DIR ?? 'plugins');
  if (plugins.plugins.length) console.log(`[plugins] loaded: ${plugins.names.join(', ')}`);
} catch (err) {
  console.error(`[plugins] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const tracer = otlpEndpoint
  ? new Tracer({ endpoint: otlpEndpoint, headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS), serviceName: process.env.OTEL_SERVICE_NAME || 'pourgatellm' })
  : undefined;
const cacheTtl = Number(process.env.POURGATE_CACHE_TTL_SECONDS ?? 0);
let cache: ResponseCache | undefined;
if (cacheTtl > 0) {
  try {
    cache = new ResponseCache(db, {
      ttlMs: cacheTtl * 1000,
      maxEntries: Math.max(1, Number(process.env.POURGATE_CACHE_MAX_ENTRIES ?? 1000)),
      mode: parseCacheMode(process.env.POURGATE_CACHE_MODE),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
const retentionMs = Math.max(1, Number(process.env.POURGATE_LOG_RETENTION_DAYS ?? 30)) * 86_400_000;
const evalStore = new EvalStore(db);
const semanticOn = cache !== undefined && /^(on|true|1)$/i.test(process.env.POURGATE_SEMANTIC_CACHE ?? '');
const semanticIndex = semanticOn
  ? new SemanticIndex(db, { threshold: Math.min(1, Math.max(0.5, Number(process.env.POURGATE_SEMANTIC_THRESHOLD ?? 0.97))) })
  : undefined;
if (process.env.POURGATE_SEMANTIC_CACHE && !cache) console.warn('[cache] POURGATE_SEMANTIC_CACHE needs POURGATE_CACHE_TTL_SECONDS > 0: semantic cache disabled');
const prune = () => {
  semanticIndex?.prune();
  pruneUsage(db);
  evalStore.prune(Date.now() - 30 * 86_400_000);
  requestLog.prune(Date.now() - retentionMs);
  audit.prune(Date.now() - 180 * 86_400_000);
};
prune();
setInterval(prune, 6 * 3_600_000).unref();

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
  console.error('No API tokens configured. Set POURGATE_TOKENS or run: pnpm cli tokens create --name <name>');
  process.exit(1);
}

manager.loadCache();
poolManager.sync(manager.entries);
for (const p of manager.entries) {
  if (p.adapter && !plugins.adapters.has(p.adapter)) console.warn(`[plugins] provider ${p.provider} needs adapter "${p.adapter}", which no plugin provides: provider disabled`);
}

// Measured quality (evals) and the routing strategy that uses it.
let strategy;
try {
  strategy = parseStrategy(process.env.POURGATE_ROUTING_STRATEGY);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
let scoreMap = new Map<string, ModelScore>();
let scoresAt = 0;
const scoring = {
  strategy,
  score: (provider: string, model: string) => {
    if (Date.now() - scoresAt > 60_000) {
      scoreMap = new Map(evalStore.scores().map((s) => [`${s.provider}|${s.model}`, s]));
      scoresAt = Date.now();
    }
    return scoreMap.get(`${provider}|${model}`);
  },
};
const suitePath = resolve(process.env.POURGATE_EVALS_FILE ?? 'evals/suite.json');
const evalTasksPerModel = Math.max(1, Number(process.env.POURGATE_EVAL_TASKS ?? 4));
let evals;
if (existsSync(suitePath)) {
  const suite = loadSuite(suitePath);
  const runner = new EvalRunner({ suite, store: evalStore, registry: () => manager.entries, pools: () => poolManager.pools });
  evals = { runner, store: evalStore, strategy, tasksPerModel: evalTasksPerModel, tasks: suite.length };
  const hours = Number(process.env.POURGATE_EVAL_HOURS ?? 0);
  if (hours > 0) runner.start(hours * 3_600_000, { tasksPerModel: evalTasksPerModel });
} else {
  console.warn(`[evals] suite not found at ${suitePath}: evals disabled`);
}

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
      privacy,
      semantic: semanticIndex ? { index: semanticIndex, model: process.env.POURGATE_SEMANTIC_MODEL || 'auto' } : undefined,
      observedLimits: new ObservedLimits(db),
      maxBodyBytes: Math.max(1, Number(process.env.POURGATE_MAX_BODY_MB ?? 20)) * 1024 * 1024,
      maxUploadBytes: Math.max(1, Number(process.env.POURGATE_MAX_UPLOAD_MB ?? 25)) * 1024 * 1024,
      plugins,
      tracer,
      scoring,
      evals,
      cache,
      requestLog,
      audit,
      metrics: new Metrics(),
      metricsToken: process.env.POURGATE_METRICS_TOKEN || undefined,
      adminPassword: process.env.POURGATE_ADMIN_PASSWORD || undefined,
      secureCookie: process.env.POURGATE_COOKIE_SECURE === 'true',
      staticDir: resolve(process.env.POURGATE_STATIC_DIR ?? (existsSync('public') ? 'public' : 'packages/client/dist')),
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
