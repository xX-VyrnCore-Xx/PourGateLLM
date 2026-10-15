import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge, Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { ApiError, api, type PlaygroundResult } from '../lib/api';
import { useT } from '../lib/i18n';
import { cn } from '../lib/utils';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  result?: PlaygroundResult;
  failed?: boolean;
}

const VIRTUAL = ['auto', 'auto:small', 'auto:medium', 'auto:large'];

export function Playground({ onUnauthorized }: { onUnauthorized: () => void }) {
  const t = useT();
  const [models, setModels] = useState<string[]>(VIRTUAL);
  const [model, setModel] = useState('auto');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .providers()
      .then((ps) => setModels([...VIRTUAL, ...ps.filter((p) => p.enabled).flatMap((p) => p.models.map((m) => m.id))]))
      .catch((err) => err instanceof ApiError && err.status === 401 && onUnauthorized());
  }, [onUnauthorized]);

  useEffect(() => end.current?.scrollIntoView?.({ block: 'end' }), [turns]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    const history: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(history);
    setPrompt('');
    setBusy(true);
    try {
      const result = await api.playground(
        model,
        history.filter((x) => !x.failed).map(({ role, content }) => ({ role, content })),
      );
      setTurns([...history, { role: 'assistant', content: result.content ?? result.error ?? t('error'), result, failed: !result.ok }]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      setTurns([...history, { role: 'assistant', content: err instanceof Error ? err.message : t('error'), failed: true }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Model</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded-lg border border-border bg-white/60 px-3 py-2 text-sm dark:bg-neutral-900/40"
          >
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <Button variant="outline" onClick={() => setTurns([])} disabled={turns.length === 0}>
          {t('clearChat')}
        </Button>
      </div>

      <Card className="min-h-64 space-y-3">
        {turns.length === 0 && <p className="text-sm text-muted">{t('playgroundHint')}</p>}
        {turns.map((turn, i) => (
          <div key={i} className={cn('flex flex-col gap-1', turn.role === 'user' ? 'items-end' : 'items-start')}>
            <div
              className={cn(
                'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm',
                turn.role === 'user'
                  ? 'bg-gradient-to-br from-indigo-500 to-purple-500 text-white'
                  : turn.failed
                    ? 'border border-red-300 text-red-700 dark:border-red-800 dark:text-red-400'
                    : 'bg-neutral-100 dark:bg-neutral-800',
              )}
            >
              {turn.content}
            </div>
            {turn.result?.route.model && (
              <div className="flex flex-wrap gap-1 text-xs text-muted">
                <span>{t('routedTo')}</span>
                <Badge>{turn.result.route.provider}/{turn.result.route.model}</Badge>
                {turn.result.route.tier && <Badge>{turn.result.route.tier}</Badge>}
                {turn.result.route.complexity && <Badge>{turn.result.route.complexity}</Badge>}
                {turn.result.route.cache && <Badge>cache {turn.result.route.cache}</Badge>}
                <span>{turn.result.elapsedMs} ms{turn.result.tokens ? ` · ${turn.result.tokens} tok` : ''}</span>
              </div>
            )}
          </div>
        ))}
        {busy && <p className="text-sm text-muted">…</p>}
        <div ref={end} />
      </Card>

      <form onSubmit={submit} className="flex gap-2">
        <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('promptPlaceholder')} aria-label={t('promptPlaceholder')} maxLength={8000} />
        <Button type="submit" disabled={busy || !prompt.trim()}>{t('send')}</Button>
      </form>
    </section>
  );
}
