import { useEffect, useState } from 'react';
import { Card } from '../components/ui/card';
import { ApiError, api, type AuditRow } from '../lib/api';
import { useT } from '../lib/i18n';
import { cn } from '../lib/utils';

const tone = (action: string) =>
  action === 'login_failed' || action === 'login_rate_limited'
    ? 'text-red-600 dark:text-red-400'
    : action.endsWith('revoke') || action.endsWith('remove') || action === 'cache_clear'
      ? 'text-amber-600 dark:text-amber-400'
      : '';

export function Audit({ onUnauthorized }: { onUnauthorized: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .audit()
      .then(setRows)
      .catch((err) => (err instanceof ApiError && err.status === 401 ? onUnauthorized() : setError(t('error'))));
  }, [onUnauthorized, t]);

  if (error) return <p role="alert" className="text-sm text-red-600">{error}</p>;
  if (!rows) return null;
  if (rows.length === 0) return <p className="text-sm text-muted">{t('auditEmpty')}</p>;

  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-muted">
          <tr>
            {(['when', 'action', 'target', 'detail'] as const).map((k) => (
              <th key={k} className="px-4 py-2 font-medium">{t(k)}</th>
            ))}
            <th className="px-4 py-2 font-medium">IP</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-border last:border-0">
              <td className="whitespace-nowrap px-4 py-2 text-muted">{new Date(r.ts).toLocaleString()}</td>
              <td className={cn('px-4 py-2 font-mono text-xs', tone(r.action))}>{r.action}</td>
              <td className="px-4 py-2">{r.target ?? '-'}</td>
              <td className="px-4 py-2">{r.detail ?? '-'}</td>
              <td className="px-4 py-2 font-mono text-xs text-muted">{r.ip ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
