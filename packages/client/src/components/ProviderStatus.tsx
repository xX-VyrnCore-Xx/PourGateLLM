import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type HealthInfo, type HealthRow } from '../lib/api';
import { t as translate, useT, type Key } from '../lib/i18n';
import { Button } from './ui/button';
import { Badge, Card } from './ui/card';

const TONE: Record<HealthRow['status'], string> = {
  ok: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  'rate-limited': 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  'no-key': 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  'bad-key': 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  'model-unavailable': 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  'server-error': 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  unreachable: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
};
const labelFor = (s: HealthRow['status']) => translate(`st_${s.replace(/-/g, '_')}` as Key);

/** What each provider really answers right now, measured with a tiny request (on demand). */
export function ProviderStatus({ onUnauthorized }: { onUnauthorized: () => void }) {
  const t = useT();
  const [info, setInfo] = useState<HealthInfo | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      setError(err instanceof ApiError ? err.message : t('error'));
    },
    [onUnauthorized, t],
  );
  useEffect(() => {
    api.health().then(setInfo).catch(fail);
  }, [fail]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setInfo(await api.runHealth());
    } catch (err) {
      fail(err);
    } finally {
      setRunning(false);
    }
  }

  if (info && !info.enabled) return null;
  return (
    <Card className="md:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{t('statusTitle')}</h2>
          <p className="mt-1 text-xs text-muted">{t('statusHint')}</p>
        </div>
        <Button variant="outline" onClick={run} disabled={running || info?.checking}>
          {running || info?.checking ? t('statusRunning') : t('statusRun')}
        </Button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
      {info && info.results.length === 0 && <p className="mt-3 text-sm text-muted">{t('statusNever')}</p>}
      {info && info.results.length > 0 && (
        <ul className="mt-3 divide-y divide-border text-sm">
          {info.results.map((r) => (
            <li key={r.provider} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span className="flex items-center gap-2">
                <strong>{r.provider}</strong>
                <Badge className={TONE[r.status]}>{labelFor(r.status)}</Badge>
              </span>
              <span className="text-xs text-muted" title={r.detail}>
                {[
                  r.model,
                  r.ms !== undefined ? (r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)} s` : `${r.ms} ms`) : undefined,
                  r.status !== 'ok' && r.status !== 'no-key' && r.detail ? r.detail.slice(0, 60) : undefined,
                  `${t('statusSince')} ${new Date(r.since).toLocaleString()}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
