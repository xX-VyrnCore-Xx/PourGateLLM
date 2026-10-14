import { randomBytes } from 'node:crypto';

export type AttrValue = string | number | boolean;

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** 2 = server, 3 = client (OTLP SpanKind). */
  kind: 2 | 3;
  startMs: number;
  endMs: number;
  attributes: Record<string, AttrValue | null | undefined>;
  error?: string;
}

export interface TracerOptions {
  /** OTLP/HTTP base endpoint (`.../v1/traces` is appended unless already present). */
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  fetch?: typeof fetch;
  flushIntervalMs?: number;
  maxBatch?: number;
  maxQueue?: number;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** Parses a W3C `traceparent` header; returns undefined for anything malformed or all-zero. */
export function parseTraceparent(header: string | undefined): { traceId: string; spanId: string } | undefined {
  const m = header?.trim().toLowerCase().match(TRACEPARENT);
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return undefined;
  return { traceId: m[1]!, spanId: m[2]! };
}

export const newTraceId = () => randomBytes(16).toString('hex');
export const newSpanId = () => randomBytes(8).toString('hex');

export function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

const nano = (ms: number) => String(BigInt(Math.round(ms * 1000)) * 1000n);

function attr(key: string, v: AttrValue) {
  if (typeof v === 'string') return { key, value: { stringValue: v } };
  if (typeof v === 'boolean') return { key, value: { boolValue: v } };
  return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
}

/**
 * Minimal OTLP/HTTP JSON trace exporter: batches finished spans and posts them in the background.
 * Export failures never affect requests; when the queue is full the oldest spans are dropped.
 */
export class Tracer {
  private queue: SpanData[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly url: string;
  private readonly doFetch: typeof fetch;
  private lastWarn = 0;
  dropped = 0;

  constructor(private readonly opts: TracerOptions) {
    const base = opts.endpoint.replace(/\/+$/, '');
    this.url = base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
    this.doFetch = opts.fetch ?? fetch;
    this.timer = setInterval(() => void this.flush(), opts.flushIntervalMs ?? 5000);
    this.timer.unref();
  }

  record(span: SpanData): void {
    this.queue.push(span);
    const max = this.opts.maxQueue ?? 2000;
    if (this.queue.length > max) {
      this.dropped += this.queue.length - max;
      this.queue = this.queue.slice(-max);
    }
    if (this.queue.length >= (this.opts.maxBatch ?? 100)) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.opts.maxBatch ?? 100);
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [attr('service.name', this.opts.serviceName ?? 'pourgatellm')] },
          scopeSpans: [
            {
              scope: { name: 'pourgatellm' },
              spans: batch.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: s.name,
                kind: s.kind,
                startTimeUnixNano: nano(s.startMs),
                endTimeUnixNano: nano(s.endMs),
                attributes: Object.entries(s.attributes)
                  .filter((e): e is [string, AttrValue] => e[1] !== null && e[1] !== undefined)
                  .map(([k, v]) => attr(k, v)),
                status: s.error ? { code: 2, message: s.error } : { code: 1 },
              })),
            },
          ],
        },
      ],
    };
    try {
      const res = await this.doFetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.opts.headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel();
      if (!res.ok) this.warn(`collector answered ${res.status}`);
    } catch (err) {
      this.warn(err instanceof Error ? err.message : 'export failed');
    }
  }

  private warn(msg: string): void {
    const now = Date.now();
    if (now - this.lastWarn > 60_000) {
      this.lastWarn = now;
      console.warn(`[otel] trace export failed: ${msg}`);
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
