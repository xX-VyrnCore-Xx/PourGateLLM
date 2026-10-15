import { useEffect, useState } from 'react';
import { Button } from '../components/ui/button';
import { Badge, Card } from '../components/ui/card';
import { ApiError, api, type Analytics, type ProviderRow, type TokenRow } from '../lib/api';
import { useT } from '../lib/i18n';
import { cn } from '../lib/utils';

type Snippet = 'curl' | 'python' | 'node';

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="outline"
      className="px-2 py-1 text-xs"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? t('copied') : t('copyCode')}
    </Button>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold tabular-nums', tone === 'good' && 'text-emerald-600 dark:text-emerald-400', tone === 'bad' && 'text-red-600 dark:text-red-400')}>{value}</p>
    </Card>
  );
}

function Step({ done, title, hint, n }: { done: boolean; title: string; hint: string; n: number }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
          done ? 'bg-emerald-500 text-white' : 'border border-border text-muted',
        )}
      >
        {done ? '✓' : n}
      </span>
      <div>
        <p className={cn('text-sm font-medium', done && 'text-muted line-through decoration-1')}>{title}</p>
        {!done && <p className="text-xs text-muted">{hint}</p>}
      </div>
    </li>
  );
}

export function Overview({ onUnauthorized, goTo }: { onUnauthorized: () => void; goTo: (tab: 'providers' | 'tokens' | 'playground') => void }) {
  const t = useT();
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [stats, setStats] = useState<Analytics | null>(null);
  const [snippet, setSnippet] = useState<Snippet>('curl');

  useEffect(() => {
    const fail = (err: unknown) => err instanceof ApiError && err.status === 401 && onUnauthorized();
    api.providers().then(setProviders).catch(fail);
    api.tokens().then(setTokens).catch(fail);
    api.analytics('24h').then(setStats).catch(() => setStats(null)); // the request log may be off
  }, [onUnauthorized]);

  const baseUrl = `${window.location.origin}/v1`;
  const snippets: Record<Snippet, string> = {
    curl: `curl ${baseUrl}/chat/completions \\\n  -H "Authorization: Bearer YOUR_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'`,
    python: `from openai import OpenAI\n\nclient = OpenAI(base_url="${baseUrl}", api_key="YOUR_TOKEN")\nreply = client.chat.completions.create(\n    model="auto",\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(reply.choices[0].message.content)`,
    node: `import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "${baseUrl}", apiKey: "YOUR_TOKEN" });\nconst reply = await client.chat.completions.create({\n  model: "auto",\n  messages: [{ role: "user", content: "Hello!" }],\n});\nconsole.log(reply.choices[0].message.content);`,
  };

  const online = providers?.filter((p) => p.enabled).length ?? 0;
  const keys = providers?.reduce((n, p) => n + p.keys, 0) ?? 0;
  const hasToken = (tokens ?? []).some((x) => !x.revokedAt);
  const hasRequests = (stats?.summary.requests ?? 0) > 0;
  const steps = [
    { done: online > 0, title: t('stepAddKey'), hint: t('stepAddKeyHint'), go: 'providers' as const },
    { done: hasToken, title: t('stepToken'), hint: t('stepTokenHint'), go: 'tokens' as const },
    { done: hasRequests, title: t('stepRequest'), hint: t('stepRequestHint'), go: 'playground' as const },
  ];
  const allDone = steps.every((s) => s.done);
  const next = steps.find((s) => !s.done);

  return (
    <section className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t('statProviders')} value={providers ? `${online}/${providers.length}` : '…'} tone={online > 0 ? 'good' : undefined} />
        <Stat label={t('statKeys')} value={providers ? String(keys) : '…'} />
        <Stat label={t('statRequests')} value={stats ? stats.summary.requests.toLocaleString() : '–'} />
        <Stat label={t('statErrors')} value={stats ? `${(stats.summary.errorRate * 100).toFixed(1)}%` : '–'} tone={stats && stats.summary.errorRate > 0.05 ? 'bad' : undefined} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t('gettingStarted')}</h2>
            {allDone && <Badge>{t('allSet')}</Badge>}
          </div>
          <ol className="space-y-3">
            {steps.map((s, i) => (
              <Step key={s.title} n={i + 1} done={s.done} title={s.title} hint={s.hint} />
            ))}
          </ol>
          {next && (
            <Button className="mt-4" onClick={() => goTo(next.go)}>
              {next.title}
            </Button>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">{t('providersHealth')}</h2>
          <ul className="space-y-2 text-sm">
            {providers?.map((p) => (
              <li key={p.provider} className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span aria-hidden className={cn('h-2 w-2 rounded-full', p.enabled ? 'bg-emerald-500' : 'bg-neutral-400')} />
                  <span className="font-medium">{p.provider}</span>
                  {p.enabled ? (
                    <span className="text-xs text-muted">
                      {p.keys} {p.keys === 1 ? t('key') : t('keys')}
                      {p.keysCooling > 0 && ` · ${p.keysCooling} ${t('cooling')}`}
                    </span>
                  ) : (
                    <span className="text-xs text-muted">{t('noKeyYet')}</span>
                  )}
                </span>
                {!p.enabled && p.signupUrl && (
                  <a href={p.signupUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-accent underline-offset-2 hover:underline">
                    {t('getKey')} ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('connect')}</h2>
          <div className="flex gap-1" role="tablist" aria-label="snippet">
            {(['curl', 'python', 'node'] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={snippet === k}
                onClick={() => setSnippet(k)}
                className={cn('rounded-lg px-2.5 py-1 text-xs font-medium', snippet === k ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-neutral-100 dark:hover:bg-neutral-800')}
              >
                {k === 'node' ? 'Node.js' : k === 'python' ? 'Python' : 'curl'}
              </button>
            ))}
          </div>
        </div>
        <p className="mb-3 text-xs text-muted">{t('connectHint')}</p>
        <div className="mb-2 flex items-center gap-2 text-xs">
          <span className="text-muted">{t('baseUrl')}</span>
          <code className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">{baseUrl}</code>
          <CopyButton text={baseUrl} />
        </div>
        <div className="relative">
          <pre className="overflow-x-auto rounded-lg bg-neutral-100 p-3 text-xs leading-relaxed dark:bg-neutral-900">
            <code>{snippets[snippet]}</code>
          </pre>
          <div className="absolute right-2 top-2">
            <CopyButton text={snippets[snippet]} />
          </div>
        </div>
      </Card>
    </section>
  );
}
