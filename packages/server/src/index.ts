import { serve } from '@hono/node-server';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { maintain } from './dbtools.js';
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
import { Breaker } from './breaker.js';
import { loadProfiles } from './profiles.js';
import { CustomProviders } from './customproviders.js';
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
      staleMs: Math.max(0, Number(process.env.POURGATE_CACHE_STALE_SECONDS ?? 0)) * 1000,
      maxBytes: process.env.POURGATE_CACHE_MAX_MB ? Math.max(1, Number(process.env.POURGATE_CACHE_MAX_MB)) * 1024 * 1024 : undefined,
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
  maintain(db);
};
prune();
setInterval(prune, 6 * 3_600_000).unref();

const overridesDir = resolve(process.env.POURGATE_OVERRIDES_DIR ?? 'overrides');
const pubKeyEnv = process.env.POURGATE_REGISTRY_PUBKEY?.trim();
const baseRegistry = loadRegistry(resolve(process.env.POURGATE_REGISTRY_DIR ?? 'registry'));
const fileOverrides = existsSync(overridesDir) ? loadRegistry(overridesDir) : [];
const customProviders = new CustomProviders(db);
const manager = new RegistryManager({
  base: baseRegistry,
  overrides: [...fileOverrides, ...customProviders.entries()],
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

const adminPassword = process.env.POURGATE_ADMIN_PASSWORD || undefined;
if (!adminPassword) {
  console.warn('POURGATE_ADMIN_PASSWORD not set: dashboard/admin API disabled (use the CLI to manage tokens)');
} else if (adminPassword.length < 8) {
  console.error('POURGATE_ADMIN_PASSWORD is shorter than 8 characters: refusing to start with a guessable dashboard password.');
  process.exit(1);
} else if (adminPassword.length < 12) {
  console.warn('POURGATE_ADMIN_PASSWORD is shorter than 12 characters: use a longer one (e.g. "openssl rand -base64 18").');
}

// Listen on the loopback interface unless told otherwise: exposing the gateway to a network is a decision.
const host = process.env.POURGATE_HOST || '127.0.0.1';
const exposed = !['127.0.0.1', 'localhost', '::1'].includes(host);

// Named fallback chains (`auto:<name>`); a missing file simply means none are defined.
const profilesFile = resolve(process.env.POURGATE_PROFILES_FILE ?? 'profiles.yaml');
const profiles = (() => {
  try {
    return loadProfiles(profilesFile);
  } catch (e) {
    console.error(`Cannot read profiles: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();
if (profiles.names().length > 0) console.log(`Profiles: ${profiles.names().map((n) => `auto:${n}`).join(', ')}`);

const port = Number(process.env.PORT ?? 3000);
const server = serve(
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
      customProviders,
      onCustomChange: () => manager.setOverrides([...fileOverrides, ...customProviders.entries()]),
      reservedNames: () => new Set([...baseRegistry, ...fileOverrides].map((p) => p.provider)),
      profiles,
      ollama: ['1', 'true', 'yes'].includes((process.env.POURGATE_OLLAMA_API ?? '').toLowerCase()),
      fusionPanel: Math.min(5, Math.max(2, Number(process.env.POURGATE_FUSION_PANEL ?? 3))),
      breaker: new Breaker({ threshold: Math.max(1, Number(process.env.POURGATE_BREAKER_THRESHOLD ?? 5)) }),
      upstreamTimeoutMs: Math.max(1000, Number(process.env.POURGATE_UPSTREAM_TIMEOUT_MS ?? 60_000)),
      tracer,
      scoring,
      evals,
      cache,
      requestLog,
      audit,
      metrics: new Metrics(),
      metricsToken: process.env.POURGATE_METRICS_TOKEN || undefined,
      adminPassword,
      secureCookie: process.env.POURGATE_COOKIE_SECURE === 'true',
      staticDir: resolve(process.env.POURGATE_STATIC_DIR ?? (existsSync('public') ? 'public' : 'packages/client/dist')),
    }).fetch,
    port,
    hostname: host,
  },
  (info) => {
    const enabled = [...poolManager.pools.keys()];
    console.log(`PourGateLLM listening on ${host}:${info.port} (${enabled.length} provider(s) enabled${enabled.length ? `: ${enabled.join(', ')}` : ''})`);
    console.log(`  API base URL  http://localhost:${info.port}/v1`);
    if (adminPassword) console.log(`  Dashboard     http://localhost:${info.port}/`);
    if (exposed) console.warn(`  Reachable from the network (${host}). Put it behind HTTPS and a firewall; set POURGATE_COOKIE_SECURE=true when serving HTTPS.`);
    else console.log('  Local only (127.0.0.1). Set POURGATE_HOST=0.0.0.0 to accept connections from other machines.');
    if (enabled.length === 0) console.log('  No provider has an API key yet: run "pourgate setup" (or add keys in the dashboard) to get started.');
    if (process.env.POURGATE_REGISTRY_URL) {
      const hours = Number(process.env.POURGATE_REGISTRY_SYNC_HOURS ?? 12);
      manager.start(Math.max(0.1, hours) * 3_600_000);
    }
  },
);

// Graceful shutdown: stop accepting connections, flush the WAL and close the database.
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      try {
        maintain(db);
        db.close();
      } finally {
        process.exit(0);
      }
    });
    // Streams may keep connections open: don't hang forever.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
