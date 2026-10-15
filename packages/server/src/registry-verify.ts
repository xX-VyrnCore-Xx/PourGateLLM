import type { ProviderEntry } from '@pourgate/shared';
import { KEYLESS } from './keypool.js';

/**
 * Real end-to-end probe of a provider: one tiny chat completion with the given key (or none for keyless providers).
 * Unlike `GET /models`, which several providers answer for any key, this proves the key, the model id and the route
 * all work. Costs a few tokens of free quota.
 */
export type ProbeStatus = 'ok' | 'bad-key' | 'rate-limited' | 'model-unavailable' | 'server-error' | 'unreachable' | 'no-key';

export interface ProbeResult {
  provider: string;
  status: ProbeStatus;
  model?: string;
  httpStatus?: number;
  ms?: number;
  detail?: string;
}

type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Cheapest model likely to answer: smallest tier first, chat-capable only. */
export function probeModel(entry: ProviderEntry): string | undefined {
  const order = { small: 0, medium: 1, large: 2 } as const;
  return [...entry.models].filter((m) => m.capabilities.includes('chat')).sort((a, b) => order[a.tier ?? 'medium'] - order[b.tier ?? 'medium'])[0]?.id;
}

/** Collapses whitespace, caps the length and never lets the key itself through (some providers echo it in errors). */
const clip = (s: string, secret?: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return (secret ? t.split(secret).join('[key]') : t).slice(0, 160);
};

export async function probeProvider(entry: ProviderEntry, key: string | undefined, opts: { fetch?: Fetcher; timeoutMs?: number; model?: string } = {}): Promise<ProbeResult> {
  const model = opts.model ?? probeModel(entry);
  if (!model) return { provider: entry.provider, status: 'model-unavailable', detail: 'no chat model in the registry' };
  const realKey = key && key !== KEYLESS ? key : undefined;
  if (!realKey && !entry.keyless) return { provider: entry.provider, status: 'no-key', model, detail: `set ${entry.api_key_env} or add a key in the dashboard` };
  const doFetch = opts.fetch ?? (fetch as unknown as Fetcher);
  const started = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await doFetch(`${entry.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(realKey ? { authorization: `Bearer ${realKey}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 32 }),
      signal: ctl.signal,
    });
    const ms = Math.round(performance.now() - started);
    const text = await res.text();
    const base = { provider: entry.provider, model, httpStatus: res.status, ms };
    if (res.ok) {
      try {
        const m = (JSON.parse(text) as { choices?: { message?: { content?: unknown; reasoning?: unknown } }[] }).choices?.[0]?.message;
        const said = typeof m?.content === 'string' && m.content.trim() !== '' ? m.content : typeof m?.reasoning === 'string' ? m.reasoning : '';
        // A reasoning model may spend the whole budget thinking: still a working route.
        return { ...base, status: 'ok', detail: said ? clip(said, realKey).slice(0, 60) : 'answered without text (reasoning model?)' };
      } catch {
        return { ...base, status: 'server-error', detail: `HTTP 200 but not JSON: ${clip(text, realKey)}` };
      }
    }
    const detail = clip(text, realKey);
    if (res.status === 401 || res.status === 403) return { ...base, status: 'bad-key', detail };
    if (res.status === 429) return { ...base, status: 'rate-limited', detail };
    if (res.status === 404 || res.status === 400 || res.status === 422) return { ...base, status: 'model-unavailable', detail };
    return { ...base, status: 'server-error', detail };
  } catch (e) {
    return { provider: entry.provider, status: 'unreachable', model, ms: Math.round(performance.now() - started), detail: clip(e instanceof Error ? e.message : String(e), realKey) };
  } finally {
    clearTimeout(timer);
  }
}

/** Probes every provider (or one) with the first key from its environment variable; keyless providers need none. */
export async function verifyRegistry(registry: readonly ProviderEntry[], opts: { env?: NodeJS.ProcessEnv; only?: string; fetch?: Fetcher; allModels?: boolean } = {}): Promise<ProbeResult[]> {
  const env = opts.env ?? process.env;
  const out: ProbeResult[] = [];
  for (const p of registry) {
    if (opts.only && p.provider !== opts.only) continue;
    if (p.adapter) continue;
    const key = env[p.api_key_env]?.split(',')[0]?.trim();
    if (!opts.allModels) {
      out.push(await probeProvider(p, key, { fetch: opts.fetch }));
      continue;
    }
    // Every chat model, one request each: finds ids a provider lists but no longer routes.
    const ids = p.models.filter((m) => m.capabilities.includes('chat')).map((m) => m.id);
    if (ids.length === 0) out.push(await probeProvider(p, key, { fetch: opts.fetch }));
    for (const id of ids) out.push(await probeProvider(p, key, { fetch: opts.fetch, model: id }));
  }
  return out;
}
