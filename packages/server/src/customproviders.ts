import type { DatabaseSync } from 'node:sqlite';
import { providerSchema, type ProviderEntry } from '@pourgate/shared';

/**
 * User-defined OpenAI-compatible endpoints (llama.cpp, Ollama, LM Studio, vLLM, another gateway...) added from the
 * dashboard instead of a YAML file. They are stored in the database and merged into the registry like overrides,
 * with their keys managed in the same encrypted key store.
 */
export interface CustomProvider {
  name: string;
  baseUrl: string;
  signupUrl: string | null;
  models: string[];
  tools: boolean;
  createdAt: number;
}

interface Row {
  name: string;
  base_url: string;
  signup_url: string | null;
  models: string;
  tools: number;
  created_at: number;
}

export class CustomProviderError extends Error {}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MODEL_ID = /^[\w./:@+-]{1,200}$/;
export const MAX_CUSTOM_PROVIDERS = 50;
export const MAX_MODELS = 200;

const toRecord = (r: Row): CustomProvider => ({
  name: r.name,
  baseUrl: r.base_url,
  signupUrl: r.signup_url,
  models: JSON.parse(r.models) as string[],
  tools: r.tools !== 0,
  createdAt: r.created_at,
});

export function normalizeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new CustomProviderError('base URL is not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new CustomProviderError('base URL must start with http:// or https://');
  if (u.username || u.password) throw new CustomProviderError('base URL must not contain credentials: add the key in the Keys section');
  if (u.search || u.hash) throw new CustomProviderError('base URL must not contain a query or fragment');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Environment variable name that would hold this provider's keys (shown to the operator; keys can also live in the dashboard). */
export const envNameFor = (name: string) => `${name.toUpperCase().replace(/-/g, '_')}_API_KEYS`;

export class CustomProviders {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  list(): CustomProvider[] {
    return (this.db.prepare('SELECT * FROM custom_providers ORDER BY name').all() as unknown as Row[]).map(toRecord);
  }

  add(input: { name: string; baseUrl: string; models: string[]; signupUrl?: string; tools?: boolean }, taken: ReadonlySet<string>): CustomProvider {
    const name = input.name.trim().toLowerCase();
    if (!NAME.test(name)) throw new CustomProviderError('name must be 1-32 characters: lowercase letters, digits and dashes');
    if (taken.has(name) || this.list().some((p) => p.name === name)) throw new CustomProviderError(`a provider named "${name}" already exists`);
    if (this.list().length >= MAX_CUSTOM_PROVIDERS) throw new CustomProviderError(`at most ${MAX_CUSTOM_PROVIDERS} custom providers`);
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const models = [...new Set(input.models.map((m) => m.trim()).filter(Boolean))];
    if (models.length === 0) throw new CustomProviderError('add at least one model id');
    if (models.length > MAX_MODELS) throw new CustomProviderError(`at most ${MAX_MODELS} models`);
    const bad = models.find((m) => !MODEL_ID.test(m));
    if (bad) throw new CustomProviderError(`invalid model id "${bad.slice(0, 40)}"`);
    let signupUrl: string | null = null;
    if (input.signupUrl?.trim()) {
      try {
        const u = new URL(input.signupUrl.trim());
        if (u.protocol !== 'https:') throw new Error();
        signupUrl = u.toString();
      } catch {
        throw new CustomProviderError('key page link must be an https URL');
      }
    }
    this.db
      .prepare('INSERT INTO custom_providers (name, base_url, signup_url, models, tools, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, baseUrl, signupUrl, JSON.stringify(models), input.tools === false ? 0 : 1, this.now());
    return toRecord(this.db.prepare('SELECT * FROM custom_providers WHERE name = ?').get(name) as unknown as Row);
  }

  remove(name: string): boolean {
    return Number(this.db.prepare('DELETE FROM custom_providers WHERE name = ?').run(name).changes) > 0;
  }

  /** Registry entries for the stored providers (validated with the same schema as YAML files). */
  entries(): ProviderEntry[] {
    return this.list().map((p) =>
      providerSchema.parse({
        provider: p.name,
        base_url: p.baseUrl,
        api_key_env: envNameFor(p.name),
        ...(p.signupUrl ? { signup_url: p.signupUrl } : {}),
        models: p.models.map((id) => ({ id, capabilities: p.tools ? ['chat', 'tools'] : ['chat'] })),
      }),
    );
  }
}

type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Asks the endpoint which models it serves (`GET {base}/models`), so the operator does not have to type them. */
export async function detectModels(baseUrl: string, apiKey: string | undefined, doFetch: Fetcher = fetch as unknown as Fetcher): Promise<string[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await doFetch(`${normalizeBaseUrl(baseUrl)}/models`, { signal: ctl.signal, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
    if (!res.ok) throw new CustomProviderError(`the endpoint answered HTTP ${res.status} to GET /models: type the model ids by hand`);
    const text = await res.text();
    if (text.length > 2_000_000) throw new CustomProviderError('model list is too large');
    const body = JSON.parse(text) as { data?: { id?: unknown }[]; models?: { name?: unknown; model?: unknown; id?: unknown }[] };
    const rows = body.data ?? body.models ?? [];
    const ids = rows
      .map((r) => (r as { id?: unknown; name?: unknown; model?: unknown }).id ?? (r as { name?: unknown }).name ?? (r as { model?: unknown }).model)
      .filter((v): v is string => typeof v === 'string' && MODEL_ID.test(v));
    if (ids.length === 0) throw new CustomProviderError('the endpoint listed no models: type the model ids by hand');
    return [...new Set(ids)].slice(0, MAX_MODELS);
  } catch (e) {
    if (e instanceof CustomProviderError) throw e;
    throw new CustomProviderError(`could not reach the endpoint (${e instanceof Error ? e.message : 'error'}): type the model ids by hand`);
  } finally {
    clearTimeout(timer);
  }
}
