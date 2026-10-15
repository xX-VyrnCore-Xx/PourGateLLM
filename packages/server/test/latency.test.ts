import { describe, expect, it } from 'vitest';
import type { Candidate } from '../src/router.js';
import { analyzePrompt } from '../src/complexity.js';
import { LatencyTracker } from '../src/latency.js';
import { rankCandidates } from '../src/router.js';

describe('latency tracker', () => {
  it('smooths samples and groups them into coarse buckets', () => {
    const t = new LatencyTracker();
    expect(t.bucket('x|m')).toBe(0); // unmeasured
    t.record('x|m', 200);
    expect(t.bucket('x|m')).toBe(0); // under the floor
    t.record('fast|m', 300);
    t.record('slow|m', 1800);
    expect(t.bucket('slow|m')).toBeGreaterThan(t.bucket('fast|m'));
    // One outlier does not move a target by more than the smoothing allows.
    t.record('fast|m', 3000);
    expect(t.average('fast|m')).toBeCloseTo(300 + 0.3 * 2700, 5);
  });

  it('ignores junk and forgets stale measurements so slow targets are probed again', () => {
    let now = 0;
    const t = new LatencyTracker({ now: () => now, staleMs: 1000 });
    t.record('a|m', Number.NaN);
    t.record('a|m', -5);
    expect(t.average('a|m')).toBeUndefined();
    t.record('a|m', 60_000);
    expect(t.bucket('a|m')).toBeGreaterThan(3);
    now = 1500;
    expect(t.average('a|m')).toBeUndefined();
    expect(t.bucket('a|m')).toBe(0);
    expect(t.snapshot()).toEqual([]);
  });
});

describe('latency in routing order', () => {
  const cand = (provider: string): Candidate =>
    ({
      provider: { provider, base_url: `https://${provider}.test/v1`, api_key_env: 'X', auth: 'bearer', models: [] },
      model: { id: 'same', capabilities: ['chat'], tier: 'medium', limits: {}, quirks: [] },
    }) as unknown as Candidate;
  const analysis = analyzePrompt({ messages: [{ role: 'user', content: 'hi' }] });
  const names = (list: Candidate[]) => list.map((c) => c.provider.provider);

  it('puts the faster target first among equals, but never beats a better tier or less usage within a bucket', () => {
    const list = [cand('slow'), cand('fast')];
    const bucket = (c: Candidate) => (c.provider.provider === 'slow' ? 3 : 0);
    expect(names(rankCandidates(list, 'medium', analysis, () => 0, undefined, bucket))).toEqual(['fast', 'slow']);
    // Same bucket: usage decides again.
    const usage = (c: Candidate) => (c.provider.provider === 'fast' ? 10 : 1);
    expect(names(rankCandidates(list, 'medium', analysis, usage, undefined, () => 0))).toEqual(['slow', 'fast']);
  });
});
