import { useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useT } from '../lib/i18n';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';

/** Encrypted export/import of keys, tokens, custom endpoints and profiles, to move to another machine. */
export function BackupRestore({ onUnauthorized, onRestored }: { onUnauthorized: () => void; onRestored: () => void }) {
  const t = useT();
  const [pass, setPass] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized();
    setError(err instanceof ApiError ? err.message : t('error'));
  };

  async function download() {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const text = await api.backup(pass);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'pourgate-backup.json';
      a.click();
      URL.revokeObjectURL(url);
      setInfo(t('backupDone'));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function restore(f: File | undefined) {
    if (!f) return;
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await f.text());
      } catch {
        throw new ApiError(400, t('backupBadFile'));
      }
      const r = await api.restore(pass, parsed);
      setInfo(
        `${t('backupRestored')}: ${r.keys.added} / ${r.tokens.added} / ${r.customProviders.added} / ${r.profiles.added} (${t('backupSkipped')}: ${r.keys.skipped + r.tokens.skipped + r.customProviders.skipped + r.profiles.skipped})`,
      );
      onRestored();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  }

  return (
    <Card className="md:col-span-2">
      <h2 className="font-semibold">{t('backupTitle')}</h2>
      <p className="mt-1 text-xs text-muted">{t('backupHint')}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input type="password" autoComplete="new-password" placeholder={t('backupPass')} value={pass} onChange={(e) => setPass(e.target.value)} className="max-w-xs" aria-label={t('backupPass')} />
        <Button onClick={download} disabled={busy || pass.length < 8}>
          {t('backupDownload')}
        </Button>
        <Button variant="outline" onClick={() => file.current?.click()} disabled={busy || pass.length < 8}>
          {t('backupRestore')}
        </Button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => void restore(e.target.files?.[0])} />
      </div>
      {info && <p role="status" className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">{info}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
    </Card>
  );
}
