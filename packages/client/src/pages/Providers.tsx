import { useEffect, useState } from 'react';
import { Badge, Card } from '../components/ui/card';
import { ApiError, api, type ProviderRow } from '../lib/api';
import { useT } from '../lib/i18n';

export function Providers({ onUnauthorized }: { onUnauthorized: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .providers()
      .then(setRows)
      .catch((err) => (err instanceof ApiError && err.status === 401 ? onUnauthorized() : setError(t('error'))));
  }, [onUnauthorized, t]);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {rows.map((p) => (
        <Card key={p.provider}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold">{p.provider}</h2>
            {p.enabled ? (
              <Badge>
                {p.keys} {t('keys')}
                {p.keysCooling > 0 && ` · ${p.keysCooling} ${t('cooling')}`}
              </Badge>
            ) : (
              <Badge className="bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200">{t('disabled')}</Badge>
            )}
          </div>
          {p.trainsOnPrompts && <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">{t('trainsOnPrompts')}</p>}
          <p className="mb-1 text-xs text-muted">{t('models')}</p>
          <ul className="space-y-1 text-sm">
            {p.models.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2">
                <code>{m.id}</code>
                <span className="text-xs text-muted">
                  {m.limits.rpm ? `${m.limits.rpm} rpm` : ''}
                  {m.verifiedAt ? '' : ` ${t('unverified')}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
