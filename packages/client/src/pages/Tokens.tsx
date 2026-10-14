import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '../components/ui/button';
import { Badge, Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { ApiError, api, type TokenRow } from '../lib/api';
import { useT } from '../lib/i18n';

const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

export function Tokens({ onUnauthorized }: { onUnauthorized: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', rpm: '', daily: '', expiresDays: '' });

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      setError(err instanceof ApiError ? err.message : t('error'));
    },
    [onUnauthorized, t],
  );

  const load = useCallback(() => api.tokens().then(setRows).catch(handle), [handle]);
  useEffect(() => void load(), [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.createToken({
        name: form.name,
        rpm: num(form.rpm),
        daily: num(form.daily),
        expiresDays: num(form.expiresDays),
      });
      setCreated(res.token);
      setCopied(false);
      setForm({ name: '', rpm: '', daily: '', expiresDays: '' });
      await load();
    } catch (err) {
      handle(err);
    }
  }

  const status = (r: TokenRow) =>
    r.revokedAt ? t('revoked') : r.expiresAt && r.expiresAt <= Date.now() ? t('expired') : t('active');

  return (
    <div className="space-y-6">
      <Card>
        <form onSubmit={create} className="grid gap-3 sm:grid-cols-5 sm:items-end">
          <label className="text-sm sm:col-span-2">
            {t('name')}
            <Input required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1" />
          </label>
          {(['rpm', 'daily', 'expiresDays'] as const).map((k) => (
            <label key={k} className="text-sm">
              {t(k)}
              <Input type="number" min={1} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className="mt-1" />
            </label>
          ))}
          <Button type="submit" disabled={!form.name.trim()} className="sm:col-span-5 sm:w-fit">
            {t('create')}
          </Button>
        </form>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}
      </Card>

      {created && (
        <Card className="border-accent">
          <p className="mb-2 text-sm font-medium">{t('newToken')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-neutral-100 px-2 py-1 text-sm dark:bg-neutral-800">{created}</code>
            <Button
              variant="outline"
              onClick={() => navigator.clipboard.writeText(created).then(() => setCopied(true))}
            >
              {copied ? t('copied') : t('copy')}
            </Button>
          </div>
        </Card>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted">{t('noTokens')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                {(['name', 'status', 'rpm', 'daily', 'usageToday'] as const).map((k) => (
                  <th key={k} className="py-2 pr-4 font-medium">
                    {t(k)}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="py-2 pr-4">
                    {r.name} <span className="text-muted">{r.prefix}…</span>
                  </td>
                  <td className="pr-4">
                    <Badge>{status(r)}</Badge>
                  </td>
                  <td className="pr-4">{r.rpmLimit ?? t('unlimited')}</td>
                  <td className="pr-4">{r.dailyRequestLimit ?? t('unlimited')}</td>
                  <td className="pr-4">
                    {r.usageToday.requests} req / {r.usageToday.tokens} tok
                  </td>
                  <td className="text-right">
                    {!r.revokedAt && (
                      <Button variant="danger" onClick={() => api.revokeToken(r.id).then(load).catch(handle)}>
                        {t('revoke')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
