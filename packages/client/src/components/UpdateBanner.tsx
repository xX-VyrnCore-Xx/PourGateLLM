import { useEffect, useState } from 'react';
import { api, type UpdateInfo } from '../lib/api';
import { useT } from '../lib/i18n';
import { Button } from './ui/button';

const KEY = 'pourgate.update.dismissed';
const read = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

/** A slim notice when a newer release exists. It links to the release page; nothing is installed automatically. */
export function UpdateBanner() {
  const t = useT();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(read());
  useEffect(() => {
    api.update().then(setInfo).catch(() => undefined);
  }, []);
  if (!info?.newer || !info.latest || dismissed === info.latest) return null;
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-300 bg-indigo-50 px-4 py-2 text-sm dark:border-indigo-800 dark:bg-indigo-950/50">
      <span>
        <strong>{t('updateAvailable')}: {info.latest}</strong> <span className="text-muted">({t('updateCurrent')} {info.current})</span>
      </span>
      <span className="flex items-center gap-2">
        {info.url && (
          <a href={info.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline-offset-2 hover:underline">
            {t('updateOpen')} ↗
          </a>
        )}
        <Button
          variant="outline"
          className="px-2 py-1 text-xs"
          onClick={() => {
            try {
              localStorage.setItem(KEY, info.latest!);
            } catch {
              // not persisted, still hidden for this visit
            }
            setDismissed(info.latest!);
          }}
        >
          {t('updateDismiss')}
        </Button>
      </span>
    </div>
  );
}
