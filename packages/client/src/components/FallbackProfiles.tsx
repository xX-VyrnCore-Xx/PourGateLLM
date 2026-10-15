import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card } from './ui/card';
import { ApiError, api, type ProfileRow } from '../lib/api';
import { useT } from '../lib/i18n';

const toText = (chain: ProfileRow['chain']) => chain.map((c) => (c.provider ? `${c.model} @${c.provider}` : c.model)).join('\n');
const fromText = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const at = l.lastIndexOf(' @');
      return at > 0 ? { model: l.slice(0, at).trim(), provider: l.slice(at + 2).trim() } : { model: l };
    });

/** Named fallback chains (auto:<name>) editable from the dashboard. */
export function FallbackProfiles({ onUnauthorized }: { onUnauthorized: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<ProfileRow[]>([]);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      setError(err instanceof ApiError ? err.message : t('error'));
    },
    [onUnauthorized, t],
  );
  const load = useCallback(() => api.profiles().then(setRows).catch(fail), [fail]);
  useEffect(() => void load(), [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.saveProfile(name.trim().toLowerCase(), fromText(text));
      setName('');
      setText('');
      await load();
    } catch (err) {
      fail(err);
    }
  }

  async function remove(n: string) {
    try {
      await api.deleteProfile(n);
      await load();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <Card className="md:col-span-2">
      <h2 className="font-semibold">{t('profilesTitle')}</h2>
      <p className="mt-1 text-sm text-muted">{t('profilesHint')}</p>
      <ul className="mt-2 space-y-2 text-sm">
        {rows.map((r) => (
          <li key={r.name} className="flex flex-wrap items-start justify-between gap-2">
            <span>
              <code>auto:{r.name}</code> <span className="text-muted">→ {r.chain.map((c) => c.model).join(' → ')}</span>
            </span>
            <span className="flex gap-1">
              <Button variant="outline" className="px-2 py-1 text-xs" onClick={() => { setName(r.name); setText(toText(r.chain)); }}>
                {t('profileEdit')}
              </Button>
              <Button variant="danger" className="px-2 py-1 text-xs" onClick={() => remove(r.name)}>
                {t('remove')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <form onSubmit={save} className="mt-3 space-y-2">
        <Input aria-label={t('profileName')} placeholder={t('profileName')} maxLength={32} value={name} onChange={(e) => setName(e.target.value)} className="w-64" />
        <textarea
          aria-label={t('profileModels')}
          placeholder={t('profileModels')}
          spellCheck={false}
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full rounded-lg border border-border bg-transparent p-2 font-mono text-xs"
        />
        <Button type="submit" disabled={name.trim() === '' || text.trim() === ''}>
          {t('profileSave')}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
    </Card>
  );
}
