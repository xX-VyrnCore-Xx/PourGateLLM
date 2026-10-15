export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? res.statusText);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface TokenRow {
  id: number;
  name: string;
  prefix: string;
  rpmLimit: number | null;
  dailyRequestLimit: number | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  usageToday: { requests: number; tokens: number };
}

export interface ProviderRow {
  provider: string;
  enabled: boolean;
  keys: number;
  keysFromEnv: number | null;
  keysCooling: number;
  trainsOnPrompts: boolean | null;
  signupUrl?: string | null;
  models: {
    id: string;
    circuit: 'closed' | 'open' | 'half-open';
    latencyMs?: number | null;
    tier: 'small' | 'medium' | 'large' | null;
    capabilities: string[];
    context: number | null;
    limits: Record<string, number>;
    verifiedAt: string | null;
    usageToday: { requests: number; tokens: number };
    observed: { limitRequests: number | null; limitTokens: number | null; observedAt: number; drift: string[] } | null;
  }[];
}

export interface ProviderKeyRow {
  id: number;
  provider: string;
  label: string;
  last4: string;
  createdAt: number;
  enabled: boolean;
  weight: number;
}

export interface RegistryStatus {
  url: string | null;
  signed: boolean;
  lastAttemptAt: number | null;
  lastResult: 'never' | 'updated' | 'unchanged' | 'rejected' | 'error';
  detail: string;
  version: number | null;
}

export interface Analytics {
  since: number;
  bucketMs: number;
  summary: { requests: number; errors: number; errorRate: number; cacheHits: number; tokens: number; p50Ms: number | null; p95Ms: number | null };
  byModel: { provider: string; model: string; requests: number; errors: number; tokens: number; p50Ms: number | null; p95Ms: number | null }[];
  series: { t: number; requests: number; errors: number }[];
}

export interface EvalInfo {
  enabled: boolean;
  strategy?: string;
  tasks?: number;
  tasksPerModel?: number;
  running?: boolean;
  lastRun?: { startedAt: number; finishedAt: number; models: number; attempts: number; skipped: string[] } | null;
  scores?: { provider: string; model: string; samples: number; quality: number; reliability: number; p50Ms: number | null; lastRun: number }[];
}

export interface AuditRow {
  id: number;
  ts: number;
  action: string;
  ip: string | null;
  target: string | null;
  detail: string | null;
}

export interface PlaygroundResult {
  ok: boolean;
  status: number;
  content: string | null;
  error: string | null;
  tokens: number | null;
  elapsedMs: number;
  route: { provider: string | null; model: string | null; tier: string | null; complexity: string | null; cache: string | null };
}

export const api = {
  session: () => request<{ authenticated: boolean }>('/session'),
  login: (password: string) => request<void>('/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<void>('/logout', { method: 'POST' }),
  tokens: () => request<TokenRow[]>('/tokens'),
  createToken: (body: { name: string; rpm?: number; daily?: number; expiresDays?: number }) =>
    request<{ token: string; record: TokenRow }>('/tokens', { method: 'POST', body: JSON.stringify(body) }),
  revokeToken: (id: number) => request<void>(`/tokens/${id}`, { method: 'DELETE' }),
  providers: () => request<ProviderRow[]>('/providers'),
  providerKeys: (provider: string) =>
    request<{ env: number; keys: ProviderKeyRow[] }>(`/providers/${encodeURIComponent(provider)}/keys`),
  updateProviderKey: (id: number, patch: { label?: string; enabled?: boolean; weight?: number }) =>
    request<ProviderKeyRow>(`/provider-keys/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  addProviderKey: (provider: string, key: string, label: string, weight = 1) =>
    request<ProviderKeyRow>(`/providers/${encodeURIComponent(provider)}/keys`, {
      method: 'POST',
      body: JSON.stringify({ key, label, weight }),
    }),
  addProviderKeys: (provider: string, keys: string, weight = 1) =>
    request<{ added: number; skipped: { key: string; reason: string }[] }>(`/providers/${encodeURIComponent(provider)}/keys/bulk`, {
      method: 'POST',
      body: JSON.stringify({ keys, weight }),
    }),
  customProviders: () => request<CustomProviderRow[]>('/custom-providers'),
  addCustomProvider: (body: { name: string; baseUrl: string; models?: string; apiKey?: string }) =>
    request<CustomProviderRow & { detected: boolean }>('/custom-providers', { method: 'POST', body: JSON.stringify(body) }),
  removeCustomProvider: (name: string) => request<void>(`/custom-providers/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  profiles: () => request<ProfileRow[]>('/profiles'),
  saveProfile: (name: string, chain: { model: string; provider?: string }[]) =>
    request<ProfileRow>(`/profiles/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ chain }) }),
  deleteProfile: (name: string) => request<void>(`/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  removeProviderKey: (id: number) => request<void>(`/provider-keys/${id}`, { method: 'DELETE' }),
  testProviderKey: (id: number) =>
    request<{ ok: boolean; status: number | null; result?: string; model?: string | null; ms?: number | null; detail?: string | null }>(`/provider-keys/${id}/test`, { method: 'POST' }),
  evals: () => request<EvalInfo>('/evals'),
  runEvals: () => request<{ started: boolean }>('/evals/run', { method: 'POST', body: '{}' }),
  cache: () =>
    request<{ enabled: boolean; mode?: string; entries?: number; hits?: number; bytes?: number; served?: Record<string, number> }>('/cache'),
  clearCache: () => request<{ cleared: number }>('/cache', { method: 'DELETE' }),
  analytics: (range: string) => request<Analytics>(`/analytics?range=${encodeURIComponent(range)}`),
  /** Streams a playground answer; resolves with the route headers once the stream ends. */
  async playgroundStream(
    model: string,
    messages: { role: string; content: string }[],
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<PlaygroundResult> {
    const started = Date.now();
    const res = await fetch('/admin/api/playground', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
    if (res.status === 401) throw new ApiError(401, 'unauthorized');
    // Cache hits and errors come back as plain JSON.
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream') || !res.body) {
      const json = (await res.json().catch(() => null)) as PlaygroundResult | { error?: string } | null;
      if (json && 'route' in json) {
        if (json.content) onDelta(json.content);
        return json;
      }
      throw new ApiError(res.status, (json as { error?: string } | null)?.error ?? res.statusText);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const delta = (JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            content += delta;
            onDelta(delta);
          }
        } catch {
          // ignore keep-alives / non-JSON lines
        }
      }
    }
    const h = (n: string) => res.headers.get(`x-pourgate-${n}`);
    return {
      ok: true,
      status: 200,
      content,
      error: null,
      tokens: null,
      elapsedMs: Date.now() - started,
      route: { provider: h('provider'), model: h('model'), tier: h('tier'), complexity: h('complexity'), cache: h('cache') },
    };
  },
  audit: () => request<AuditRow[]>('/audit?limit=200'),
  registry: () => request<RegistryStatus | null>('/registry'),
  syncRegistry: () => request<RegistryStatus>('/registry/sync', { method: 'POST' }),
};

export interface CustomProviderRow {
  name: string;
  baseUrl: string;
  models: string[];
  envName: string;
  keys: number;
}

export interface ProfileRow {
  name: string;
  chain: { model: string; provider?: string }[];
  resolved?: number;
}
