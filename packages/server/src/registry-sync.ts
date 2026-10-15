import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { bundleSchema, type ModelEntry, type ProviderEntry, type RegistryBundle } from '@pourgate/shared';

const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export type SyncResult = 'never' | 'updated' | 'unchanged' | 'rejected' | 'error';

export interface SyncStatus {
  url: string | null;
  /** True when a public key is configured, i.e. bundles must carry a valid signature. */
  signed: boolean;
  lastAttemptAt: number | null;
  lastResult: SyncResult;
  detail: string;
  version: number | null;
}

// ---------------------------------------------------------------------------
// Pure helpers

/** Public https URL only: no loopback, link-local, private ranges or *.local. */
export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (h.startsWith('[')) return false; // IPv6 literals are not accepted for providers
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return false;
    }
  }
  return true;
}

/** Providers' key env var must look like `<NAME>_API_KEYS` so a registry can never target other secrets. */
export const isKeyEnvName = (name: string) => /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*_API_KEYS$/.test(name);

function mergeModels(base: ModelEntry[], patch: ModelEntry[]): ModelEntry[] {
  const out = base.map((m) => patch.find((p) => p.id === m.id) ?? m);
  for (const p of patch) if (!base.some((m) => m.id === p.id)) out.push(p);
  return out;
}

/** Local overrides win: top-level fields replace, models merge by id. New providers are added. */
export function applyOverrides(base: ProviderEntry[], overrides: ProviderEntry[]): ProviderEntry[] {
  const out = base.map((b) => {
    const o = overrides.find((x) => x.provider === b.provider);
    return o ? { ...b, ...o, models: mergeModels(b.models, o.models) } : b;
  });
  for (const o of overrides) if (!base.some((b) => b.provider === o.provider)) out.push(o);
  return out;
}

/**
 * Applies a remote bundle on top of the local (shipped) registry.
 * Unsigned: only models/limits/quirks of providers we already ship may change; endpoints and key
 * env names are never taken from an unauthenticated source (they receive users' API keys).
 * Signed: the bundle is trusted for everything, subject to the endpoint safety checks.
 */
export function applyRemote(
  local: ProviderEntry[],
  bundle: RegistryBundle,
  trusted: boolean,
): { entries: ProviderEntry[]; ignored: string[] } {
  const ignored: string[] = [];
  const safe = (p: ProviderEntry) => isPublicHttpsUrl(p.base_url) && isKeyEnvName(p.api_key_env);
  const entries = local.map((l) => {
    const r = bundle.providers.find((x) => x.provider === l.provider);
    if (!r) return l;
    if (trusted) {
      if (safe(r)) return r;
      ignored.push(`${r.provider}: unsafe endpoint or key env`);
      return l;
    }
    return { ...l, models: r.models, trains_on_prompts: r.trains_on_prompts ?? l.trains_on_prompts };
  });
  for (const r of bundle.providers) {
    if (local.some((l) => l.provider === r.provider)) continue;
    if (!trusted) ignored.push(`${r.provider}: new providers require a signed bundle`);
    else if (!safe(r)) ignored.push(`${r.provider}: unsafe endpoint or key env`);
    else entries.push(r);
  }
  return { entries, ignored };
}

// ---------------------------------------------------------------------------
// Bundle building / signing (used by the CLI and tests)

export function buildBundle(providers: ProviderEntry[], version = Math.floor(Date.now() / 1000)): string {
  const bundle: RegistryBundle = { version, generated_at: new Date(version * 1000).toISOString(), providers };
  bundleSchema.parse(bundle);
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export const signBundle = (bytes: Buffer | string, privateKeyPem: string): string =>
  sign(null, Buffer.from(bytes), createPrivateKey(privateKeyPem)).toString('base64');

export function generateSigningKeys(): { publicPem: string; privatePem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

// ---------------------------------------------------------------------------
// Manager

export interface RegistryManagerOptions {
  base: ProviderEntry[];
  overrides?: ProviderEntry[];
  url?: string;
  /** Ed25519 public key (PEM). When set, every bundle needs a valid detached signature at `<url>.sig`. */
  publicKeyPem?: string;
  cachePath?: string;
  fetch?: typeof fetch;
  now?: () => number;
  onChange?: (entries: ProviderEntry[]) => void;
}

type Evaluated = { ok: true; bundle: RegistryBundle } | { ok: false; reason: string };

export class RegistryManager {
  private remote: RegistryBundle | null = null;
  private effective: ProviderEntry[];
  private readonly key: KeyObject | null;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private _status: SyncStatus;

  constructor(private readonly opts: RegistryManagerOptions) {
    this.key = opts.publicKeyPem ? createPublicKey(opts.publicKeyPem) : null;
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.effective = applyOverrides(opts.base, opts.overrides ?? []);
    this._status = {
      url: opts.url ?? null,
      signed: this.key !== null,
      lastAttemptAt: null,
      lastResult: 'never',
      detail: '',
      version: null,
    };
  }

  get entries(): ProviderEntry[] {
    return this.effective;
  }

  status(): SyncStatus {
    return { ...this._status };
  }

  /** Replaces the local overrides (files plus dashboard-defined providers) and re-applies them. */
  setOverrides(overrides: ProviderEntry[]): void {
    this.opts.overrides = overrides;
    this.recompute();
  }

  private recompute(): void {
    const withRemote = this.remote ? applyRemote(this.opts.base, this.remote, this.key !== null).entries : this.opts.base;
    this.effective = applyOverrides(withRemote, this.opts.overrides ?? []);
    this.opts.onChange?.(this.effective);
  }

  private evaluate(bytes: Buffer, sig: string | undefined): Evaluated {
    if (bytes.length > MAX_BUNDLE_BYTES) return { ok: false, reason: 'bundle too large' };
    if (this.key) {
      if (!sig) return { ok: false, reason: 'signature missing' };
      let valid = false;
      try {
        valid = verify(null, bytes, this.key, Buffer.from(sig.trim(), 'base64'));
      } catch {
        valid = false;
      }
      if (!valid) return { ok: false, reason: 'invalid signature' };
    }
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      return { ok: false, reason: 'bundle is not valid JSON' };
    }
    const parsed = bundleSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: `schema validation failed: ${parsed.error.issues[0]?.message}` };
    return { ok: true, bundle: parsed.data };
  }

  /** Restores the last accepted bundle from disk; it is re-verified exactly like a fresh download. */
  loadCache(): void {
    const path = this.opts.cachePath;
    if (!path || !existsSync(path)) return;
    try {
      const cached = JSON.parse(readFileSync(path, 'utf8')) as { bundle: string; sig?: string };
      const res = this.evaluate(Buffer.from(cached.bundle, 'utf8'), cached.sig);
      if (!res.ok) return;
      this.remote = res.bundle;
      this._status.version = res.bundle.version;
      this.recompute();
    } catch {
      // unreadable cache: ignore, a fresh sync will replace it
    }
  }

  private persist(bytes: Buffer, sig: string | undefined): void {
    const path = this.opts.cachePath;
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ bundle: bytes.toString('utf8'), sig }));
    renameSync(tmp, path);
  }

  private async download(url: string): Promise<Buffer> {
    const res = await this.doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_BUNDLE_BYTES) throw new Error('bundle too large');
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BUNDLE_BYTES) {
        await reader.cancel();
        throw new Error('bundle too large');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  async sync(): Promise<SyncStatus> {
    const set = (lastResult: SyncResult, detail: string) => {
      this._status = { ...this._status, lastAttemptAt: this.now(), lastResult, detail };
      return this.status();
    };
    const url = this.opts.url;
    if (!url) return set('error', 'no registry URL configured');
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return set('error', 'invalid registry URL');
    }
    const loopback = ['localhost', '127.0.0.1'].includes(parsedUrl.hostname);
    if (parsedUrl.protocol !== 'https:' && !loopback) return set('error', 'registry URL must use https');

    try {
      const bytes = await this.download(url);
      const sig = this.key ? (await this.download(`${url}.sig`).catch(() => Buffer.alloc(0))).toString('utf8') : undefined;
      const res = this.evaluate(bytes, sig || undefined);
      if (!res.ok) return set('rejected', res.reason);
      if (this.remote) {
        if (res.bundle.version < this.remote.version) return set('rejected', 'rollback: older version than the current one');
        if (res.bundle.version === this.remote.version) return set('unchanged', `version ${res.bundle.version}`);
      }
      this.remote = res.bundle;
      this._status.version = res.bundle.version;
      this.persist(bytes, sig || undefined);
      this.recompute();
      const { ignored } = applyRemote(this.opts.base, res.bundle, this.key !== null);
      return set('updated', ignored.length ? `version ${res.bundle.version}; ignored: ${ignored.join('; ')}` : `version ${res.bundle.version}`);
    } catch (err) {
      return set('error', err instanceof Error ? err.message : 'sync failed');
    }
  }

  start(intervalMs: number): void {
    void this.sync();
    this.timer = setInterval(() => void this.sync(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
