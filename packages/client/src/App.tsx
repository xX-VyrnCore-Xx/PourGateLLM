import { useEffect, useState } from 'react';
import { Button } from './components/ui/button';
import { api } from './lib/api';
import { useT } from './lib/i18n';
import { cn } from './lib/utils';
import { Analytics } from './pages/Analytics';
import { Login } from './pages/Login';
import { Providers } from './pages/Providers';
import { Tokens } from './pages/Tokens';

type Tab = 'tokens' | 'providers' | 'analytics';

export function App() {
  const t = useT();
  const [auth, setAuth] = useState<'loading' | 'in' | 'out'>('loading');
  const [tab, setTab] = useState<Tab>('tokens');

  useEffect(() => {
    api
      .session()
      .then(() => setAuth('in'))
      .catch(() => setAuth('out'));
  }, []);

  if (auth === 'loading') return null;
  if (auth === 'out') return <Login onLogin={() => setAuth('in')} />;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('appName')}</h1>
        <nav className="flex gap-1" aria-label="Main">
          {(['tokens', 'providers', 'analytics'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              aria-current={tab === k ? 'page' : undefined}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm',
                tab === k ? 'bg-accent text-white' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
              )}
            >
              {t(k)}
            </button>
          ))}
        </nav>
        <Button
          variant="outline"
          onClick={() => api.logout().finally(() => setAuth('out'))}
        >
          {t('logout')}
        </Button>
      </header>
      {tab === 'tokens' && <Tokens onUnauthorized={() => setAuth('out')} />}
      {tab === 'providers' && <Providers onUnauthorized={() => setAuth('out')} />}
      {tab === 'analytics' && <Analytics onUnauthorized={() => setAuth('out')} />}
    </div>
  );
}
