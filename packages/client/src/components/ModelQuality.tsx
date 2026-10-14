import { useCallback, useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { ApiError, api, type EvalInfo } from '../lib/api';
import { useT } from '../lib/i18n';

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function ModelQuality({ onUnauthorized }: { onUnauthorized: () => void }) {
  const t = useT();
  const [info, setInfo] = useState<EvalInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api
        .evals()
        .then(setInfo)
        .catch((err) => (err instanceof ApiError && err.status === 401 ? onUnauthorized() : setError(t('error')))),
    [onUnauthorized, t],
  );
  useEffect(() => void load(), [load]);

  // While a run is in progress keep refreshing so scores appear when it finishes.
  useEffect(() => {
    if (!info?.running) return;
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, [info?.running, load]);

  if (!info?.enabled) return error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null;

  async function run() {
    setError(null);
    try {
      await api.runEvals();
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      setError(err instanceof ApiError ? err.message : t('error'));
    }
  }

  const scores = [...(info.scores ?? [])].sort((a, b) => b.quality - a.quality);
  return (
    <Card className="md:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">{t('modelQuality')}</h2>
          <p className="mt-1 text-sm text-muted">
            {t('strategy')}: <code>{info.strategy}</code>
            {info.lastRun && ` · ${new Date(info.lastRun.finishedAt).toLocaleString()}`}
          </p>
        </div>
        <Button variant="outline" onClick={run} disabled={info.running}>
          {info.running ? t('evalRunning') : t('runEvals')}
        </Button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
      {scores.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t('noScores')}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                {(['model', 'quality', 'reliability', 'latencyP50', 'samples'] as const).map((k) => (
                  <th key={k} className="py-1 pr-4 font-medium">{t(k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scores.map((s) => (
                <tr key={`${s.provider}|${s.model}`} className="border-t border-border">
                  <td className="py-1 pr-4"><code>{s.model}</code> <span className="text-muted">{s.provider}</span></td>
                  <td className="pr-4">{pct(s.quality)}</td>
                  <td className="pr-4">{pct(s.reliability)}</td>
                  <td className="pr-4">{s.p50Ms === null ? '-' : `${s.p50Ms} ms`}</td>
                  <td className="pr-4">{s.samples}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
