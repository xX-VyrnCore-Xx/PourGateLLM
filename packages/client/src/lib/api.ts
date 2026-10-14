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
  keysCooling: number;
  trainsOnPrompts: boolean | null;
  models: {
    id: string;
    capabilities: string[];
    context: number | null;
    limits: Record<string, number>;
    verifiedAt: string | null;
  }[];
}

export interface RegistryStatus {
  url: string | null;
  signed: boolean;
  lastAttemptAt: number | null;
  lastResult: 'never' | 'updated' | 'unchanged' | 'rejected' | 'error';
  detail: string;
  version: number | null;
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
  registry: () => request<RegistryStatus | null>('/registry'),
  syncRegistry: () => request<RegistryStatus>('/registry/sync', { method: 'POST' }),
};
