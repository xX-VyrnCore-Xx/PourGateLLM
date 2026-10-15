import { useEffect, useState } from 'react';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { ApiError, api, type Analytics as Data } from '../lib/api';
import { useT, type Key } from '../lib/i18n';
import { cn } from '../lib/utils';

const RANGES: { id: string; label: Key }[] = [
  { id: '24h', label: 'last24h' },
  { id: '7d', label: 'last7d' },
  { id: '30d', label: 'last30d' },
];

const ms = (v: number | null) => (v === null ? '-' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
const pct = (v: number) => `${(v * 100).toFixed(v > 0 && v < 0.01 ? 2 : 1)}%`;

function Chart({ series }: { series: Data['series'] }) {
  const max = Math.max(1, ...series.map((p) => p.requests));
  const w = 100 / series.length;
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-32 w-full" role="img" aria-label="requests over time">
      {series.map((p, i) => {
        const h = (p.requests / max) * 30;
        const eh = (p.errors / max) * 30;
        return (
          <g key={p.t}>
            <title>{`${new Date(p.t).toLocaleString()}: ${p.requests} req, ${p.errors} errors`}</title>
            <rect x={i * w + w * 0.1} y={31 - h} width={w * 0.8} height={h} className="fill-accent" />
            {eh > 0 && <rect x={i * w + w * 0.1} y={31 - eh} width={w * 0.8} height={eh} className="fill-red-500" />}
          </g>
        );
      })}
      <line x1="0" y1="31.2" x2="100" y2="31.2" className="stroke-border" strokeWidth="0.3" />
    </svg>
  );
}

export function Analytics({ onUnauthorized }: { onUnauthorized: () => void }) {
  const t = useT();
  const [range, setRange] = useState('24h');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cache, setCache] = useState<{ enabled: boolean; entries?: number; hits?: number; bytes?: number; served?: Record<string, number> } | null>(null);

  const loadCache = () => api.cache().then(setCache).catch(() => setCache(null));
  useEffect(() => void loadCache(), []);

  useEffect(() => {
    setError(null);
    api
      .analytics(range)
      .then(setData)
      .catch((err) => (err instanceof ApiError && err.status === 401 ? onUnauthorized() : setError(t('error'))));
  }, [range, onUnauthorized, t]);

  const kpis: [Key, string][] = data
    ? [
        ['requests', String(data.summary.requests)],
        ['errorRate', pct(data.summary.errorRate)],
        ['tokensUsed', data.summary.tokens.toLocaleString()],
        ...(data.summary.cacheHits > 0 ? ([['cacheHits', String(data.summary.cacheHits)]] as [Key, string][]) : []),
        ['latencyP50', ms(data.summary.p50Ms)],
        ['latencyP95', ms(data.summary.p95Ms)],
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              aria-pressed={range === r.id}
              className={cn('rounded-md px-3 py-1.5 text-sm', range === r.id ? 'bg-accent text-white' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800')}
            >
              {t(r.label)}
            </button>
          ))}
        </div>
        <a className="text-sm text-accent underline" href={`/admin/api/requests.jsonl?range=${range}`} download>
          {t('exportJsonl')}
        </a>
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {cache?.enabled && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            <span className="font-medium">{t('responseCache')}</span>{' '}
            <span className="text-muted">
              {cache.entries} {t('cacheEntries')} · {cache.hits} {t('cacheStoredHits')} · {((cache.bytes ?? 0) / 1024).toFixed(1)} KB
            </span>
            {cache.served && (
              <span className="mt-1 block text-xs text-muted">
                {Object.entries(cache.served)
                  .map(([k, n]) => `${k} ${n}`)
                  .join(' · ')}
              </span>
            )}
          </p>
          <Button variant="outline" onClick={() => api.clearCache().then(loadCache)}>
            {t('clearCache')}
          </Button>
        </Card>
      )}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            {kpis.map(([k, v]) => (
              <Card key={k}>
                <p className="text-xs text-muted">{t(k)}</p>
                <p className="mt-1 text-xl font-semibold">{v}</p>
              </Card>
            ))}
          </div>
          {data.summary.requests === 0 ? (
            <p className="text-sm text-muted">{t('noData')}</p>
          ) : (
            <>
              <Card>
                <p className="mb-2 text-xs text-muted">{t('requestsOverTime')}</p>
                <Chart series={data.series} />
              </Card>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-muted">
                    <tr>
                      {(['model', 'requests', 'errors', 'tokensUsed', 'latencyP50', 'latencyP95'] as Key[]).map((k) => (
                        <th key={k} className="py-2 pr-4 font-medium">{t(k)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.byModel.map((m) => (
                      <tr key={`${m.provider}|${m.model}`} className="border-t border-border">
                        <td className="py-2 pr-4">
                          {m.model === '-' ? <span className="text-muted">{t('unrouted')}</span> : <><code>{m.model}</code> <span className="text-muted">{m.provider}</span></>}
                        </td>
                        <td className="pr-4">{m.requests}</td>
                        <td className="pr-4">{m.errors}</td>
                        <td className="pr-4">{m.tokens.toLocaleString()}</td>
                        <td className="pr-4">{ms(m.p50Ms)}</td>
                        <td className="pr-4">{ms(m.p95Ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
