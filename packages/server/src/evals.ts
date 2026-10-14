import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ProviderEntry } from '@pourgate/shared';
import type { KeyPool } from './keypool.js';

// ---------------------------------------------------------------------------
// Suite

const checkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('equals'), value: z.string(), caseSensitive: z.boolean().optional() }),
  z.object({ type: z.literal('includes'), value: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('includesAll'), value: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('regex'), value: z.string() }),
  z.object({ type: z.literal('json'), value: z.record(z.unknown()) }),
]);

const taskSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  prompt: z.string().min(1),
  check: checkSchema,
});

const suiteSchema = z.object({ version: z.number().int(), tasks: z.array(taskSchema).min(1) });

export type EvalTask = z.infer<typeof taskSchema>;

export function loadSuite(path: string): EvalTask[] {
  const parsed = suiteSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const ids = new Set<string>();
  for (const t of parsed.tasks) {
    if (ids.has(t.id)) throw new Error(`Duplicate eval task id: ${t.id}`);
    ids.add(t.id);
    if (t.check.type === 'regex') new RegExp(t.check.value, 'i'); // fail fast on a bad pattern
  }
  return parsed.tasks;
}

const normalize = (s: string) => s.trim().replace(/^["'`]+|["'`.!]+$/g, '').trim();

function parseJsonLoose(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1]! : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? body.slice(start, end + 1) : body);
}

/** True when `content` satisfies the task's deterministic check. */
export function checkAnswer(task: EvalTask, content: string): boolean {
  const c = task.check;
  const text = content.trim();
  switch (c.type) {
    case 'equals':
      return c.caseSensitive ? normalize(text) === c.value : normalize(text).toLowerCase() === c.value.toLowerCase();
    case 'includes': {
      const low = text.toLowerCase();
      return c.value.some((v) => low.includes(v.toLowerCase()));
    }
    case 'includesAll': {
      const low = text.toLowerCase();
      return c.value.every((v) => low.includes(v.toLowerCase()));
    }
    case 'regex':
      return new RegExp(c.value, 'i').test(text);
    case 'json':
      try {
        const got = parseJsonLoose(text) as Record<string, unknown>;
        return Object.entries(c.value).every(([k, v]) => JSON.stringify(got?.[k]) === JSON.stringify(v));
      } catch {
        return false;
      }
  }
}

// ---------------------------------------------------------------------------
// Storage and scoring

export interface EvalResult {
  ts: number;
  provider: string;
  model: string;
  taskId: string;
  passed: boolean;
  latencyMs: number;
  error: string | null;
}

export interface ModelScore {
  provider: string;
  model: string;
  samples: number;
  /** Share of answered tasks that passed (0..1). */
  quality: number;
  /** Share of attempts that produced an answer at all (0..1). */
  reliability: number;
  p50Ms: number | null;
  lastRun: number;
}

export type Strategy = 'spread' | 'balanced' | 'quality' | 'speed';

export function parseStrategy(v: string | undefined): Strategy {
  const s = (v ?? 'spread').trim().toLowerCase();
  if (s === 'spread' || s === 'balanced' || s === 'quality' || s === 'speed') return s;
  throw new Error(`POURGATE_ROUTING_STRATEGY must be spread, balanced, quality or speed (got "${v}")`);
}

/** Minimum samples before a score is trusted; models below it count as neutral so they still get tried. */
export const MIN_SAMPLES = 3;
const NEUTRAL = 0.5;
const SPEED_CEILING_MS = 10_000;

/** Higher is better. */
export function rankScore(strategy: Strategy, s: ModelScore | undefined): number {
  if (strategy === 'spread' || !s || s.samples < MIN_SAMPLES) return NEUTRAL;
  const speed = s.p50Ms === null ? NEUTRAL : 1 - Math.min(s.p50Ms, SPEED_CEILING_MS) / SPEED_CEILING_MS;
  switch (strategy) {
    case 'quality':
      return s.quality + 0.001 * s.reliability;
    case 'speed':
      return speed * s.reliability;
    case 'balanced':
      return 0.6 * s.quality + 0.3 * s.reliability + 0.1 * speed;
  }
}

const median = (v: number[]): number | null => {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
};

export class EvalStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  insert(rows: EvalResult[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO eval_results (ts, provider, model, task_id, passed, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of rows) stmt.run(r.ts, r.provider, r.model, r.taskId, r.passed ? 1 : 0, Math.round(r.latencyMs), r.error);
  }

  /** Scores over the last `days` days (default 14). */
  scores(days = 14): ModelScore[] {
    const rows = this.db
      .prepare('SELECT ts, provider, model, passed, latency_ms, error FROM eval_results WHERE ts >= ? ORDER BY ts')
      .all(this.now() - days * 86_400_000) as unknown as { ts: number; provider: string; model: string; passed: number; latency_ms: number; error: string | null }[];
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${r.provider}|${r.model}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }
    return [...groups.values()].map((g) => {
      const answered = g.filter((r) => r.error === null);
      const passed = answered.filter((r) => r.passed === 1);
      return {
        provider: g[0]!.provider,
        model: g[0]!.model,
        samples: g.length,
        quality: answered.length ? passed.length / answered.length : 0,
        reliability: g.length ? answered.length / g.length : 0,
        p50Ms: median(passed.map((r) => r.latency_ms)),
        lastRun: g[g.length - 1]!.ts,
      };
    });
  }

  prune(olderThanMs: number): void {
    this.db.prepare('DELETE FROM eval_results WHERE ts < ?').run(olderThanMs);
  }
}

// ---------------------------------------------------------------------------
// Runner

export interface RunOptions {
  /** Tasks per model for this run (rotating through the suite). */
  tasksPerModel: number;
  /** Restrict to these model ids. */
  models?: string[];
}

export interface RunSummary {
  startedAt: number;
  finishedAt: number;
  models: number;
  attempts: number;
  skipped: string[];
}

export interface EvalRunnerDeps {
  suite: EvalTask[];
  store: EvalStore;
  registry: () => ProviderEntry[];
  pools: () => Map<string, KeyPool>;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Runs a few deterministic tasks against each configured model. Calls go through the normal key pool,
 * so they respect (and consume) the same limits as real traffic.
 */
export class EvalRunner {
  running = false;
  lastRun: RunSummary | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: EvalRunnerDeps) {}

  private pick(n: number): EvalTask[] {
    const { suite } = this.deps;
    const now = (this.deps.now ?? Date.now)();
    const offset = (Math.floor(now / 3_600_000) * n) % suite.length;
    return Array.from({ length: Math.min(n, suite.length) }, (_, i) => suite[(offset + i) % suite.length]!);
  }

  async run(opts: RunOptions): Promise<RunSummary> {
    if (this.running) throw new Error('an eval run is already in progress');
    this.running = true;
    const doFetch = this.deps.fetch ?? fetch;
    const now = this.deps.now ?? Date.now;
    const startedAt = now();
    const skipped: string[] = [];
    let attempts = 0;
    let models = 0;
    try {
      const pools = this.deps.pools();
      for (const provider of this.deps.registry()) {
        const pool = pools.get(provider.provider);
        for (const model of provider.models) {
          if (!model.capabilities.includes('chat')) continue;
          if (opts.models && !opts.models.includes(model.id)) continue;
          if (!pool) {
            skipped.push(`${model.id}: no API key`);
            continue;
          }
          models++;
          const rows: EvalResult[] = [];
          for (const task of this.pick(opts.tasksPerModel)) {
            const key = pool.acquire({ model: model.id, ...model.limits });
            if (!key) {
              skipped.push(`${model.id}: no key with budget`);
              break;
            }
            attempts++;
            const t0 = performance.now();
            let passed = false;
            let error: string | null = null;
            try {
              const res = await doFetch(`${provider.base_url.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: JSON.stringify({ model: model.id, temperature: 0, max_tokens: 400, messages: [{ role: 'user', content: task.prompt }] }),
                signal: AbortSignal.timeout(60_000),
              });
              if (res.status === 429) pool.cooldown(key, Math.min((Number(res.headers.get('retry-after')) || 60) * 1000, 86_400_000));
              else if (res.status >= 500) pool.cooldown(key, 10_000);
              if (!res.ok) {
                error = `http_${res.status}`;
                await res.body?.cancel();
              } else {
                const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[]; usage?: { total_tokens?: number } };
                const content = json.choices?.[0]?.message?.content;
                if (typeof json.usage?.total_tokens === 'number') pool.recordTokens(key, model.id, json.usage.total_tokens);
                if (typeof content !== 'string' || content.trim() === '') error = 'empty_answer';
                else passed = checkAnswer(task, content);
              }
            } catch (err) {
              error = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network_error';
            }
            rows.push({ ts: now(), provider: provider.provider, model: model.id, taskId: task.id, passed, latencyMs: performance.now() - t0, error });
          }
          if (rows.length) this.deps.store.insert(rows);
        }
      }
      this.lastRun = { startedAt, finishedAt: now(), models, attempts, skipped };
      return this.lastRun;
    } finally {
      this.running = false;
    }
  }

  start(intervalMs: number, opts: RunOptions, delayMs = 60_000): void {
    const tick = () => void this.run(opts).catch((err) => console.error('[evals]', err instanceof Error ? err.message : err));
    setTimeout(tick, delayMs).unref();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
