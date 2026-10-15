const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labelStr = (labels: Record<string, string>) =>
  Object.keys(labels).length === 0
    ? ''
    : `{${Object.entries(labels)
        .map(([k, v]) => `${k}="${esc(v)}"`)
        .join(',')}}`;

export interface Observation {
  provider: string | null;
  model: string | null;
  status: number;
  complexity: string | null;
  seconds: number;
  tokens: number | null;
}

/**
 * Tiny Prometheus text-format registry. Label values come from the registry or fixed sets
 * (never from user input) so cardinality stays bounded.
 */
export class Metrics {
  private readonly requests = new Map<string, { labels: Record<string, string>; n: number }>();
  private readonly tokens = new Map<string, { labels: Record<string, string>; n: number }>();
  private readonly cacheResults = new Map<string, { labels: Record<string, string>; n: number }>();
  private readonly hist = new Map<string, { labels: Record<string, string>; counts: number[]; sum: number; n: number }>();

  cache(result: 'hit' | 'semantic' | 'miss'): void {
    bump(this.cacheResults, { result }, 1);
  }

  observe(o: Observation): void {
    const provider = o.provider ?? 'none';
    const model = o.model ?? 'none';
    const reqLabels = { provider, model, status: `${Math.floor(o.status / 100)}xx`, complexity: o.complexity ?? 'none' };
    bump(this.requests, reqLabels, 1);
    if (o.tokens) bump(this.tokens, { provider, model }, o.tokens);
    const key = `${provider}|${model}`;
    let h = this.hist.get(key);
    if (!h) this.hist.set(key, (h = { labels: { provider, model }, counts: BUCKETS.map(() => 0), sum: 0, n: 0 }));
    BUCKETS.forEach((b, i) => {
      if (o.seconds <= b) h!.counts[i]!++;
    });
    h.sum += o.seconds;
    h.n++;
  }

  render(gauges: { name: string; help: string; samples: { labels: Record<string, string>; value: number }[] }[] = []): string {
    const out: string[] = [];
    out.push('# HELP pourgate_requests_total Proxied chat requests.', '# TYPE pourgate_requests_total counter');
    for (const { labels, n } of this.requests.values()) out.push(`pourgate_requests_total${labelStr(labels)} ${n}`);
    out.push('# HELP pourgate_cache_requests_total Cacheable requests by result.', '# TYPE pourgate_cache_requests_total counter');
    for (const { labels, n } of this.cacheResults.values()) out.push(`pourgate_cache_requests_total${labelStr(labels)} ${n}`);
    out.push('# HELP pourgate_tokens_total Tokens reported by providers (non-streaming).', '# TYPE pourgate_tokens_total counter');
    for (const { labels, n } of this.tokens.values()) out.push(`pourgate_tokens_total${labelStr(labels)} ${n}`);
    out.push('# HELP pourgate_request_duration_seconds Time to complete a proxied request.', '# TYPE pourgate_request_duration_seconds histogram');
    for (const h of this.hist.values()) {
      BUCKETS.forEach((b, i) => out.push(`pourgate_request_duration_seconds_bucket${labelStr({ ...h.labels, le: String(b) })} ${h.counts[i]}`));
      out.push(`pourgate_request_duration_seconds_bucket${labelStr({ ...h.labels, le: '+Inf' })} ${h.n}`);
      out.push(`pourgate_request_duration_seconds_sum${labelStr(h.labels)} ${h.sum}`);
      out.push(`pourgate_request_duration_seconds_count${labelStr(h.labels)} ${h.n}`);
    }
    for (const g of gauges) {
      out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
      for (const s of g.samples) out.push(`${g.name}${labelStr(s.labels)} ${s.value}`);
    }
    return `${out.join('\n')}\n`;
  }
}

function bump(map: Map<string, { labels: Record<string, string>; n: number }>, labels: Record<string, string>, by: number): void {
  const key = JSON.stringify(labels);
  const cur = map.get(key);
  if (cur) cur.n += by;
  else map.set(key, { labels, n: by });
}
