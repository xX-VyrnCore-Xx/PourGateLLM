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
    <div className="mx-auto max-w-5xl px-4 pb-10">
      <header className="sticky top-0 z-10 -mx-4 mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-neutral-50/80 px-4 py-3 backdrop-blur dark:bg-neutral-950/70">
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <img src="/logo.svg" alt="" className="h-7 w-7" />
          {t('appName')}
        </h1>
        <nav className="flex gap-1 rounded-xl border border-border bg-white/70 p-1 dark:bg-neutral-900/60" aria-label="Main">
          {(['tokens', 'providers', 'analytics'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              aria-current={tab === k ? 'page' : undefined}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                tab === k ? 'bg-gradient-to-br from-indigo-500 to-purple-500 text-white shadow-sm' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
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
