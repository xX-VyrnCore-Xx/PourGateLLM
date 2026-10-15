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
  models: {
    id: string;
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
  addProviderKey: (provider: string, key: string, label: string) =>
    request<ProviderKeyRow>(`/providers/${encodeURIComponent(provider)}/keys`, {
      method: 'POST',
      body: JSON.stringify({ key, label }),
    }),
  removeProviderKey: (id: number) => request<void>(`/provider-keys/${id}`, { method: 'DELETE' }),
  testProviderKey: (id: number) =>
    request<{ ok: boolean; status: number | null }>(`/provider-keys/${id}/test`, { method: 'POST' }),
  evals: () => request<EvalInfo>('/evals'),
  runEvals: () => request<{ started: boolean }>('/evals/run', { method: 'POST', body: '{}' }),
  cache: () => request<{ enabled: boolean; mode?: string; entries?: number; hits?: number; bytes?: number }>('/cache'),
  clearCache: () => request<{ cleared: number }>('/cache', { method: 'DELETE' }),
  analytics: (range: string) => request<Analytics>(`/analytics?range=${encodeURIComponent(range)}`),
  playground: (model: string, messages: { role: string; content: string }[]) =>
    request<PlaygroundResult>('/playground', { method: 'POST', body: JSON.stringify({ model, messages }) }),
  audit: () => request<AuditRow[]>('/audit?limit=200'),
  registry: () => request<RegistryStatus | null>('/registry'),
  syncRegistry: () => request<RegistryStatus>('/registry/sync', { method: 'POST' }),
};
