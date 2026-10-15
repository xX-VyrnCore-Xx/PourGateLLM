import type { Capability, ModelEntry, ProviderEntry, Tier } from '@pourgate/shared';

/**
 * Builds registry entries from a provider's own live `/models` list, keeping only the models the provider
 * itself marks as free. This is how the registry grows to hundreds of free models without hand-curating ids
 * that rotate every few weeks. Limits are left empty on purpose: the gateway learns the real ones from the
 * provider's rate-limit headers and 429 answers.
 */
export interface DiscoverySource {
  provider: string;
  base_url: string;
  api_key_env: string;
  signup_url: string;
  /** True when the provider logs prompts for training on its free routes. */
  trains_on_prompts?: boolean;
  /** Decides from one raw `/models` row whether the model is free. */
  isFree: (row: Row) => boolean;
}

type Row = Record<string, unknown> & { id: string };

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const zero = (v: unknown) => num(v) === 0;
const idHas = (re: RegExp) => (r: Row) => re.test(r.id);

export const SOURCES: DiscoverySource[] = [
  {
    provider: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_env: 'OPENROUTER_API_KEYS',
    signup_url: 'https://openrouter.ai/keys',
    isFree: (r) => r.id.endsWith(':free') && zero((r.pricing as Record<string, unknown> | undefined)?.prompt),
  },
  {
    provider: 'kilo',
    base_url: 'https://api.kilo.ai/api/gateway/v1',
    api_key_env: 'KILO_API_KEYS',
    signup_url: 'https://app.kilo.ai',
    trains_on_prompts: true,
    isFree: (r) => r.isFree === true && !r.id.startsWith('kilo-auto/') && !r.id.startsWith('stealth/'),
  },
  {
    provider: 'routeway',
    base_url: 'https://api.routeway.ai/v1',
    api_key_env: 'ROUTEWAY_API_KEYS',
    signup_url: 'https://routeway.ai',
    isFree: idHas(/:free$/),
  },
  {
    provider: 'orcarouter',
    base_url: 'https://api.orcarouter.ai/v1',
    api_key_env: 'ORCAROUTER_API_KEYS',
    signup_url: 'https://orcarouter.ai',
    isFree: (r) => /-free$/.test(r.id) && !r.id.startsWith('orca/'),
  },
  {
    provider: 'bazaarlink',
    base_url: 'https://bazaarlink.ai/api/v1',
    api_key_env: 'BAZAARLINK_API_KEYS',
    signup_url: 'https://bazaarlink.ai',
    isFree: (r) => /:free$/.test(r.id) && !r.id.startsWith('auto:'),
  },
  {
    provider: 'requesty',
    base_url: 'https://router.requesty.ai/v1',
    api_key_env: 'REQUESTY_API_KEYS',
    signup_url: 'https://app.requesty.ai',
    isFree: (r) => zero(r.input_price) && zero(r.output_price) && r.api === 'chat',
  },
  {
    provider: 'xkiro',
    base_url: 'https://api.xkiro.com/v1',
    api_key_env: 'XKIRO_API_KEYS',
    signup_url: 'https://xkiro.com',
    isFree: (r) => r.access_tier === 'free' && r.modality === 'chat',
  },
];

/** Rough size class from a parameter count in the id ("70b" large, 15-59b medium, smaller small). */
export function guessTier(id: string): Tier {
  const sizes = [...id.toLowerCase().matchAll(/(?<![a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/g)].map((m) => Number(m[1]));
  // MoE ids like "120b-a12b" carry total then active parameters: the first number is the capacity.
  const size = sizes[0];
  if (size === undefined) return /(mini|small|lite|nano|tiny|flash|lightning|instant)/i.test(id) ? 'small' : 'medium';
  return size >= 60 ? 'large' : size >= 15 ? 'medium' : 'small';
}

const SAFE_ID = /^[\w./:@+-]{1,200}$/;

export function toModel(row: Row): ModelEntry | undefined {
  if (!SAFE_ID.test(row.id) || /embed|rerank|moderation|guard|safety|whisper|tts|image|diffusion|flux/i.test(row.id)) return undefined;
  const params = new Set<string>([...(Array.isArray(row.supported_parameters) ? (row.supported_parameters as string[]) : [])]);
  const caps = new Set<Capability>(['chat']);
  if (params.has('tools')) caps.add('tools');
  if (params.has('response_format') || params.has('structured_outputs')) caps.add('json_mode');
  const arch = row.architecture as { input_modalities?: string[] } | undefined;
  const mods = arch?.input_modalities ?? (row.input_modalities as string[] | undefined) ?? [];
  if (mods.includes('image') || row.supports_vision === true) caps.add('vision');
  const context = num(row.context_length) ?? num(row.context_window);
  const model: ModelEntry = {
    id: row.id,
    tier: guessTier(row.id),
    capabilities: [...caps],
    limits: {},
    quirks: [],
  } as ModelEntry;
  if (context && context > 0) model.context = Math.round(context);
  return model;
}

type Fetcher = (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface Discovered {
  source: DiscoverySource;
  entry?: ProviderEntry;
  error?: string;
}

/** Fetches each source's model list and returns a registry entry holding only its free models. */
export async function discover(opts: { only?: string; fetch?: Fetcher; env?: NodeJS.ProcessEnv; today?: string; timeoutMs?: number; sources?: DiscoverySource[] } = {}): Promise<Discovered[]> {
  const doFetch = opts.fetch ?? (fetch as unknown as Fetcher);
  const env = opts.env ?? process.env;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const out: Discovered[] = [];
  for (const source of opts.sources ?? SOURCES) {
    if (opts.only && source.provider !== opts.only) continue;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
    try {
      const key = env[source.api_key_env]?.split(',')[0]?.trim();
      const res = await doFetch(`${source.base_url}/models`, { signal: ctl.signal, headers: key ? { authorization: `Bearer ${key}` } : {} });
      if (!res.ok) {
        out.push({ source, error: `HTTP ${res.status}` });
        continue;
      }
      const body = (await res.json()) as { data?: unknown };
      const rows = Array.isArray(body?.data) ? (body.data as Row[]) : [];
      const models: ModelEntry[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (typeof row?.id !== 'string' || seen.has(row.id) || !source.isFree(row)) continue;
        const m = toModel(row);
        if (!m) continue;
        seen.add(row.id);
        models.push({ ...m, verified_at: today });
      }
      if (models.length === 0) {
        out.push({ source, error: 'no free models recognised' });
        continue;
      }
      models.sort((a, b) => a.id.localeCompare(b.id));
      out.push({
        source,
        entry: {
          provider: source.provider,
          base_url: source.base_url,
          api_key_env: source.api_key_env,
          auth: 'bearer',
          signup_url: source.signup_url,
          ...(source.trains_on_prompts ? { trains_on_prompts: true } : {}),
          models,
        } as ProviderEntry,
      });
    } catch (e) {
      out.push({ source, error: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}
