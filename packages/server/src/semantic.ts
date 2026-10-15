import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type Json = Record<string, unknown>;

export interface SemanticOptions {
  /** Cosine similarity needed to reuse an answer (0..1). */
  threshold: number;
  /** Most candidates compared per lookup. */
  maxScan?: number;
}

// Fields that do not change the answer (same list as the exact-match cache).
const IGNORED = new Set(['stream', 'stream_options', 'user', 'metadata']);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p === 'object' && (p as Json).type === 'text' && typeof (p as Json).text === 'string' ? ((p as Json).text as string) : ''))
    .filter(Boolean)
    .join('\n');
}

function lastUserIndex(payload: Json): number {
  const messages = Array.isArray(payload.messages) ? (payload.messages as Json[]) : [];
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') return i;
  return -1;
}

/** Text of the last user message: the part of a request that varies between paraphrases. */
export function lastUserText(payload: Json): string {
  const i = lastUserIndex(payload);
  return i < 0 ? '' : textOf((payload.messages as Json[])[i]!.content).trim();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Json;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Hash of everything in the request except the last user message: model, system prompt, earlier turns, tools and
 * sampling parameters. Only requests with the same context can share an answer, so a paraphrase never crosses
 * a different system prompt, tool set or conversation.
 */
export function contextHash(payload: Json): string {
  const i = lastUserIndex(payload);
  const rest: Json = {};
  for (const [k, v] of Object.entries(payload)) if (!IGNORED.has(k) && k !== 'messages') rest[k] = v;
  const messages = (Array.isArray(payload.messages) ? (payload.messages as Json[]) : []).map((m, idx) => (idx === i ? { ...m, content: '<<last-user>>' } : m));
  return createHash('sha256').update(canonical({ ...rest, messages })).digest('hex');
}

export function normalize(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** Vectors of cached prompts, scoped per client and per request context. Linear scan over a small, bounded set. */
export class SemanticIndex {
  constructor(
    private readonly db: DatabaseSync,
    readonly opts: SemanticOptions,
  ) {}

  add(key: string, scope: string, context: string, vector: ArrayLike<number>): void {
    const v = normalize(vector);
    this.db
      .prepare(
        `INSERT INTO semantic_index (key, scope, context, dim, vector) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET scope = excluded.scope, context = excluded.context, dim = excluded.dim, vector = excluded.vector`,
      )
      .run(key, scope, context, v.length, toBlob(v));
  }

  /** Best candidate at or above the threshold, among entries with the same scope and context. */
  find(scope: string, context: string, vector: ArrayLike<number>): { key: string; similarity: number } | undefined {
    const q = normalize(vector);
    const rows = this.db
      .prepare('SELECT key, dim, vector FROM semantic_index WHERE scope = ? AND context = ? AND dim = ? ORDER BY rowid DESC LIMIT ?')
      .all(scope, context, q.length, this.opts.maxScan ?? 500) as unknown as { key: string; vector: Uint8Array }[];
    let best: { key: string; similarity: number } | undefined;
    for (const r of rows) {
      const sim = dot(q, fromBlob(r.vector));
      if (sim >= this.opts.threshold && (!best || sim > best.similarity)) best = { key: r.key, similarity: sim };
    }
    return best;
  }

  remove(key: string): void {
    this.db.prepare('DELETE FROM semantic_index WHERE key = ?').run(key);
  }

  /** Drops vectors whose cached response has expired or been evicted. */
  prune(): void {
    this.db.prepare('DELETE FROM semantic_index WHERE key NOT IN (SELECT key FROM response_cache)').run();
  }
}
