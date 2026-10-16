import { useCallback, useEffect, useState } from 'react';
import { FallbackProfiles } from '../components/FallbackProfiles';
import { CustomProviders } from '../components/CustomProviders';
import { BackupRestore } from '../components/BackupRestore';
import { ModelQuality } from '../components/ModelQuality';
import { ProviderStatus } from '../components/ProviderStatus';
import { ProviderKeys } from '../components/ProviderKeys';
import { Button } from '../components/ui/button';
import { Badge, Card } from '../components/ui/card';
import { ApiError, api, type ProviderRow, type RegistryStatus } from '../lib/api';
import { useT } from '../lib/i18n';

export function Providers({ onUnauthorized }: { onUnauthorized: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [reg, setReg] = useState<RegistryStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback(
    (err: unknown) => (err instanceof ApiError && err.status === 401 ? onUnauthorized() : setError(t('error'))),
    [onUnauthorized, t],
  );
  const load = useCallback(
    () => Promise.all([api.providers().then(setRows), api.registry().then(setReg)]).catch(fail),
    [fail],
  );
  useEffect(() => void load(), [load]);

  async function sync() {
    setSyncing(true);
    try {
      setReg(await api.syncRegistry());
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {error && <p role="alert" className="text-sm text-red-600 md:col-span-2">{error}</p>}
      <ProviderStatus onUnauthorized={onUnauthorized} />
      <ModelQuality onUnauthorized={onUnauthorized} />
      <Card className="md:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">{t('registry')}</h2>
            {reg?.url ? (
              <p className="mt-1 text-sm text-muted">
                <Badge>{reg.signed ? t('signed') : t('unsigned')}</Badge>{' '}
                {t('version')} {reg.version ?? '-'} · {t('lastSync')}:{' '}
                {reg.lastAttemptAt ? new Date(reg.lastAttemptAt).toLocaleString() : t('never')}
                {reg.lastResult !== 'never' && ` · ${reg.lastResult}${reg.detail ? ` (${reg.detail})` : ''}`}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted">{t('noRegistryUrl')}</p>
            )}
          </div>
          {reg?.url && (
            <Button variant="outline" onClick={sync} disabled={syncing}>
              {syncing ? t('syncing') : t('syncNow')}
            </Button>
          )}
        </div>
      </Card>
      <FallbackProfiles onUnauthorized={onUnauthorized} />
      <CustomProviders onChanged={load} onUnauthorized={onUnauthorized} />
      {rows.map((p) => (
        <Card key={p.provider}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold">{p.provider}</h2>
            {p.enabled ? (
              <Badge>
                {p.keys} {p.keys === 1 ? t('key') : t('keys')}
                {p.keysCooling > 0 && ` · ${p.keysCooling} ${t('cooling')}`}
              </Badge>
            ) : (
              <Badge className="bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200">{t('disabled')}</Badge>
            )}
          </div>
          {p.signupUrl && (
            <p className="mb-2 text-xs">
              <a href={p.signupUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-2 hover:underline">
                {p.enabled ? t('getMoreKeys') : t('getKey')} ↗
              </a>
            </p>
          )}
          {p.trainsOnPrompts && <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">{t('trainsOnPrompts')}</p>}
          <p className="mb-1 text-xs text-muted">{t('models')}</p>
          <ul className="space-y-1 text-sm">
            {p.models.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <code>{m.id}</code>
                  {m.tier && <Badge>{m.tier}</Badge>}
                  {m.latencyMs ? <span className="text-xs text-muted" title="Smoothed time until the first response bytes">~{m.latencyMs >= 1000 ? `${(m.latencyMs / 1000).toFixed(1)} s` : `${m.latencyMs} ms`}</span> : null}
                  {m.circuit !== 'closed' && <Badge className="bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200">{m.circuit === 'open' ? 'circuit open' : 'probing'}</Badge>}
                </span>
                <span className="text-xs text-muted">
                  {m.observed && (
                    <span title={m.observed.drift.join('\n') || undefined}>
                      {t('reported')} {m.observed.limitRequests ?? '-'} req / {m.observed.limitTokens ?? '-'} tok
                      {m.observed.drift.length > 0 && <span className="ml-1 text-amber-600 dark:text-amber-400">⚠ {t('drift')}</span>}
                      {' · '}
                    </span>
                  )}
                  {m.usageToday.requests > 0 && `${m.usageToday.requests} req / ${m.usageToday.tokens} tok · `}
                  {m.limits.rpm ? `${m.limits.rpm} rpm` : ''}
                  {m.verifiedAt ? '' : ` ${t('unverified')}`}
                </span>
              </li>
            ))}
          </ul>
          <ProviderKeys provider={p.provider} onChanged={load} onUnauthorized={onUnauthorized} />
        </Card>
      ))}
      <BackupRestore onUnauthorized={onUnauthorized} onRestored={load} />
    </div>
  );
}
