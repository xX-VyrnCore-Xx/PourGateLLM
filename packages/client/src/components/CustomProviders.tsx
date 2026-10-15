import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card } from './ui/card';
import { ApiError, api, type CustomProviderRow } from '../lib/api';
import { useT } from '../lib/i18n';

/** Add or remove OpenAI-compatible endpoints (Ollama, llama.cpp, LM Studio, another gateway...). */
export function CustomProviders({ onChanged, onUnauthorized }: { onChanged: () => void; onUnauthorized: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<CustomProviderRow[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [models, setModels] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      setError(err instanceof ApiError ? err.message : t('error'));
    },
    [onUnauthorized, t],
  );
  const load = useCallback(() => api.customProviders().then(setRows).catch(fail), [fail]);
  useEffect(() => void load(), [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const r = await api.addCustomProvider({ name, baseUrl: url, models: models || undefined });
      setInfo(r.detected ? `${r.models.length} ${t('customDetected')}. ${t('customKeyHint')}` : t('customKeyHint'));
      setName('');
      setUrl('');
      setModels('');
      await load();
      onChanged();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove(n: string) {
    try {
      await api.removeCustomProvider(n);
      await load();
      onChanged();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <Card className="md:col-span-2">
      <h2 className="font-semibold">{t('customProviders')}</h2>
      <p className="mt-1 text-sm text-muted">{t('customHint')}</p>
      <ul className="mt-2 space-y-1 text-sm">
        {rows.map((r) => (
          <li key={r.name} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <code>{r.name}</code> <span className="text-muted">{r.baseUrl} · {r.models.length} models · {r.keys} keys</span>
            </span>
            <Button variant="danger" className="px-2 py-1 text-xs" onClick={() => remove(r.name)}>
              {t('remove')}
            </Button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-3 flex flex-wrap gap-2">
        <Input aria-label={t('customName')} placeholder={t('customName')} maxLength={32} value={name} onChange={(e) => setName(e.target.value)} className="w-40" />
        <Input aria-label={t('customUrl')} placeholder={t('customUrl')} value={url} onChange={(e) => setUrl(e.target.value)} className="min-w-60 flex-1" />
        <Input aria-label={t('customModels')} placeholder={t('customModels')} value={models} onChange={(e) => setModels(e.target.value)} className="min-w-48 flex-1" />
        <Button type="submit" disabled={busy || name.trim() === '' || url.trim() === ''}>
          {t('customAdd')}
        </Button>
      </form>
      {info && <p role="status" className="mt-2 text-xs">{info}</p>}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
    </Card>
  );
}
