import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { ApiError, api } from '../lib/api';
import { useT } from '../lib/i18n';

export function Login({ onLogin }: { onLogin: () => void }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onLogin();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? t('tooMany') : t('invalidPassword'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <Card>
        <div className="mb-5 flex flex-col items-center gap-2">
          <img src="/logo.svg" alt="" className="h-14 w-14" />
          <h1 className="text-lg font-semibold tracking-tight">{t('appName')}</h1>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm">
            {t('password')}
            <Input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy || !password} className="w-full">
            {t('login')}
          </Button>
        </form>
      </Card>
    </main>
  );
}
