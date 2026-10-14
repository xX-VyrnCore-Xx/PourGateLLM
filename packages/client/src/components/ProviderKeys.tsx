import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ApiError, api, type ProviderKeyRow } from '../lib/api';
import { useT } from '../lib/i18n';

interface Props {
  provider: string;
  onChanged: () => void;
  onUnauthorized: () => void;
}

export function ProviderKeys({ provider, onChanged, onUnauthorized }: Props) {
  const t = useT();
  const [data, setData] = useState<{ env: number; keys: ProviderKeyRow[] } | null>(null);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [results, setResults] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      setError(err instanceof ApiError ? err.message : t('error'));
    },
    [onUnauthorized, t],
  );
  const load = useCallback(() => api.providerKeys(provider).then(setData).catch(fail), [provider, fail]);
  useEffect(() => void load(), [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.addProviderKey(provider, key, label);
      setKey('');
      setLabel('');
      await load();
      onChanged();
    } catch (err) {
      fail(err);
    }
  }

  async function remove(id: number) {
    try {
      await api.removeProviderKey(id);
      await load();
      onChanged();
    } catch (err) {
      fail(err);
    }
  }

  async function test(id: number) {
    try {
      const r = await api.testProviderKey(id);
      setResults((prev) => ({ ...prev, [id]: r.ok ? t('testOk') : `${t('testFail')}${r.status ? ` (${r.status})` : ''}` }));
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="mb-1 text-xs text-muted">
        {t('apiKeys')}
        {data && data.env > 0 && ` · ${data.env} ${t('fromEnv')}`}
      </p>
      {data && data.keys.length === 0 && <p className="text-xs text-muted">{t('noDbKeys')}</p>}
      <ul className="space-y-1 text-sm">
        {data?.keys.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {k.label || '—'} <code className="text-muted">••••{k.last4}</code>
              {results[k.id] && <span className="ml-2 text-xs">{results[k.id]}</span>}
            </span>
            <span className="flex gap-1">
              <Button variant="outline" className="px-2 py-1 text-xs" onClick={() => test(k.id)}>
                {t('test')}
              </Button>
              <Button variant="danger" className="px-2 py-1 text-xs" onClick={() => remove(k.id)}>
                {t('remove')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-2 flex flex-wrap gap-2">
        <Input
          type="password"
          autoComplete="off"
          aria-label={`${t('keyValue')} ${provider}`}
          placeholder={t('keyValue')}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="min-w-40 flex-1"
        />
        <Input
          aria-label={`${t('keyLabel')} ${provider}`}
          placeholder={t('keyLabel')}
          maxLength={100}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-36"
        />
        <Button type="submit" disabled={key.trim().length < 8}>
          {t('addKey')}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
