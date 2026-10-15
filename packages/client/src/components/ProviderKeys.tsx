import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ApiError, api, type ProviderKeyRow } from '../lib/api';
import { useT } from '../lib/i18n';

const WEIGHTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

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
  const [weight, setWeight] = useState(1);
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
      await api.addProviderKey(provider, key, label, weight);
      setKey('');
      setLabel('');
      setWeight(1);
      await load();
      onChanged();
    } catch (err) {
      fail(err);
    }
  }

  async function patch(id: number, change: { enabled?: boolean; weight?: number }) {
    try {
      await api.updateProviderKey(id, change);
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
            <span className={k.enabled ? '' : 'opacity-50'}>
              {k.label || '—'} <code className="text-muted">••••{k.last4}</code>
              {!k.enabled && <span className="ml-2 text-xs">{t('keyPaused')}</span>}
              {results[k.id] && <span className="ml-2 text-xs">{results[k.id]}</span>}
            </span>
            <span className="flex items-center gap-1">
              <select
                aria-label={`${t('keyWeight')} ••••${k.last4}`}
                title={t('keyWeight')}
                value={k.weight}
                onChange={(e) => patch(k.id, { weight: Number(e.target.value) })}
                className="rounded-lg border border-border bg-transparent px-1 py-1 text-xs"
              >
                {WEIGHTS.map((w) => (
                  <option key={w} value={w}>
                    ×{w}
                  </option>
                ))}
              </select>
              <Button variant="outline" className="px-2 py-1 text-xs" onClick={() => patch(k.id, { enabled: !k.enabled })}>
                {k.enabled ? t('keyOff') : t('keyOn')}
              </Button>
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
        <select
          aria-label={`${t('keyWeight')} ${provider}`}
          title={t('keyWeight')}
          value={weight}
          onChange={(e) => setWeight(Number(e.target.value))}
          className="rounded-lg border border-border bg-transparent px-2 py-2 text-sm"
        >
          {WEIGHTS.map((w) => (
            <option key={w} value={w}>
              ×{w}
            </option>
          ))}
        </select>
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
