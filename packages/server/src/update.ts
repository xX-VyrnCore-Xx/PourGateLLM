/**
 * "Is there a newer release?" Asks GitHub for the latest release at most every few hours and compares it with the
 * running version. It only reports: nothing is downloaded or installed. Turn it off with POURGATE_UPDATE_CHECK=off.
 */
export interface UpdateStatus {
  enabled: boolean;
  current: string;
  latest?: string;
  newer: boolean;
  url?: string;
  checkedAt?: number;
  error?: string;
}

type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/;

/** Negative when `a` is older than `b`; null when either is not a version. A pre-release is older than its release. */
export function compareVersions(a: string, b: string): number | null {
  const x = SEMVER.exec(a.trim());
  const y = SEMVER.exec(b.trim());
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d;
  }
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  return x[4] < y[4] ? -1 : 1;
}

export class UpdateChecker {
  private cached: UpdateStatus | undefined;
  private inflight: Promise<UpdateStatus> | undefined;

  constructor(
    private readonly opts: { current: string; repo?: string; enabled?: boolean; fetch?: Fetcher; ttlMs?: number; now?: () => number },
  ) {}

  private get repo() {
    return this.opts.repo ?? 'xX-VyrnCore-Xx/PourGateLLM';
  }

  /** Development builds have no version to compare, so they never check. */
  get enabled(): boolean {
    return (this.opts.enabled ?? true) && SEMVER.test(this.opts.current);
  }

  async status(force = false): Promise<UpdateStatus> {
    const base: UpdateStatus = { enabled: this.enabled, current: this.opts.current, newer: false };
    if (!this.enabled) return base;
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.ttlMs ?? 6 * 3_600_000;
    if (!force && this.cached?.checkedAt !== undefined && now - this.cached.checkedAt < ttl) return this.cached;
    this.inflight ??= this.fetchLatest(base, now).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchLatest(base: UpdateStatus, now: number): Promise<UpdateStatus> {
    const doFetch = this.opts.fetch ?? (fetch as unknown as Fetcher);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await doFetch(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'PourGateLLM-update-check' },
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
      const body = JSON.parse(await res.text()) as { tag_name?: unknown; html_url?: unknown };
      const latest = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : undefined;
      if (!latest || !SEMVER.test(latest)) throw new Error('the latest release has no version tag');
      const url = typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/') ? body.html_url : `https://github.com/${this.repo}/releases/latest`;
      this.cached = { ...base, latest, url, newer: (compareVersions(this.opts.current, latest) ?? 0) < 0, checkedAt: now };
    } catch (e) {
      // Keep the last good answer; remember the failure time so a down network is not retried on every call.
      this.cached = { ...(this.cached ?? base), error: e instanceof Error ? e.message : String(e), checkedAt: now };
    } finally {
      clearTimeout(timer);
    }
    return this.cached!;
  }
}
