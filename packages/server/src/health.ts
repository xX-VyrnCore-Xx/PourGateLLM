import type { ProviderEntry } from '@pourgate/shared';
import { KEYLESS, type KeyPool } from './keypool.js';
import { probeProvider, type Fetcher, type ProbeResult, type ProbeStatus } from './registry-verify.js';

const MAX_KEYS_TRIED = 3;
const RANK: Record<ProbeStatus, number> = { ok: 0, 'rate-limited': 1, 'model-unavailable': 2, 'server-error': 3, unreachable: 4, 'bad-key': 5, 'no-key': 6 };

export interface ProviderHealth extends ProbeResult {
  /** When this result was measured. */
  at: number;
  /** Since when the provider has had this status (or its ok/not-ok state changed last). */
  since: number;
}

export interface HealthEvent {
  provider: string;
  from: ProbeStatus | undefined;
  to: ProbeStatus;
  detail?: string;
}

/**
 * Real status of every provider, measured with the same tiny chat probe as `registry verify`. Runs on demand and,
 * when an interval is set, in the background; a change between working and not working fires `onChange` (the
 * gateway posts it to POURGATE_ALERT_WEBHOOK). Probing costs a few tokens of free quota per provider per run.
 */
export class HealthMonitor {
  private readonly results = new Map<string, ProviderHealth>();
  private running: Promise<ProviderHealth[]> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly opts: {
      registry: () => ProviderEntry[];
      pools: () => Map<string, KeyPool>;
      onChange?: (e: HealthEvent) => void;
      fetch?: Fetcher;
      now?: () => number;
      concurrency?: number;
    },
  ) {}

  get checking(): boolean {
    return this.running !== undefined;
  }

  snapshot(): ProviderHealth[] {
    return [...this.results.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  }

  /** Probes the providers that have a key (or need none). Concurrent calls share one run. */
  check(only?: string): Promise<ProviderHealth[]> {
    this.running ??= this.run(only).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => void this.check().catch(() => undefined), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async run(only?: string): Promise<ProviderHealth[]> {
    const now = this.opts.now ?? Date.now;
    const pools = this.opts.pools();
    const todo = this.opts.registry().filter((p) => !p.adapter && (!only || p.provider === only));
    const known = new Set(todo.map((p) => p.provider));
    for (const name of [...this.results.keys()]) if (!only && !known.has(name)) this.results.delete(name);

    const queue = [...todo];
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const keys = pools.get(p.provider)?.keys.slice(0, MAX_KEYS_TRIED) ?? [];
        let probe: ProbeResult = { provider: p.provider, status: 'no-key', detail: `set ${p.api_key_env} or add a key in the dashboard` };
        // One dead key must not make a provider look down while another key works: try a few, keep the best answer.
        for (const key of keys) {
          const r = await probeProvider(p, key === KEYLESS ? undefined : key, { fetch: this.opts.fetch, timeoutMs: 25_000 });
          if (probe.status === 'no-key' || RANK[r.status] < RANK[probe.status]) probe = r;
          if (r.status === 'ok') break;
        }
        this.record(probe, now());
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.opts.concurrency ?? 4) }, worker));
    return this.snapshot();
  }

  private record(probe: ProbeResult, at: number): void {
    const prev = this.results.get(probe.provider);
    this.results.set(probe.provider, { ...probe, at, since: prev?.status === probe.status ? prev.since : at });
    // Only a switch between working and not working alerts; "no key" is a configuration state, not an outage.
    if (!prev || prev.status === 'no-key' || probe.status === 'no-key') return;
    if ((prev.status === 'ok') !== (probe.status === 'ok')) this.opts.onChange?.({ provider: probe.provider, from: prev.status, to: probe.status, detail: probe.detail });
  }
}

/** Posts an alert as JSON; `text` and `content` make it readable in Slack and Discord incoming webhooks too. */
export async function postWebhook(url: string, e: HealthEvent, doFetch: typeof fetch = fetch): Promise<void> {
  const text = e.to === 'ok' ? `PourGateLLM: ${e.provider} is working again` : `PourGateLLM: ${e.provider} stopped working (${e.to}${e.detail ? `: ${e.detail}` : ''})`;
  await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text, ...e }), signal: AbortSignal.timeout(8000) });
}
