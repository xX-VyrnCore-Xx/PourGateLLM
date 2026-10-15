/**
 * Optional prompt compression (opt-in, `POURGATE_COMPRESSION=light|aggressive`): fewer input tokens means more
 * free quota. It only rewrites what a model never needs verbatim, never touches the last user message, system
 * prompts, tool-call structure or text inside fenced code blocks, and fails open (any problem sends the original).
 *
 * light:      collapse blank-line runs and trailing spaces, minify JSON-only messages, drop exact duplicate
 *             consecutive messages, shorten very long tool outputs (keep head and tail).
 * aggressive: light, plus replace the oldest conversation turns with a short marker once the history exceeds a budget.
 */
export type CompressionMode = 'off' | 'light' | 'aggressive';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export const parseCompression = (v: string | undefined): CompressionMode => (v === 'light' || v === 'aggressive' ? v : 'off');

export interface CompressionOptions {
  mode: CompressionMode;
  /** Tool outputs longer than this many characters are shortened (default 4000). */
  toolOutputChars?: number;
  /** Aggressive mode: keep at most this many characters of history before the final turns (default 24000). */
  historyChars?: number;
  /** Aggressive mode: always keep this many of the latest messages (default 6). */
  keepLast?: number;
}

const FENCE = /(```[\s\S]*?```)/g;

/** Collapses whitespace outside fenced code blocks. */
export function tidy(text: string): string {
  return text
    .split(FENCE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n')))
    .join('');
}

function minifyJson(text: string): string {
  const t = text.trim();
  if (t.length < 80 || !(t.startsWith('{') || t.startsWith('['))) return text;
  try {
    return JSON.stringify(JSON.parse(t));
  } catch {
    return text;
  }
}

export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} characters omitted …]\n${text.slice(text.length - tail)}`;
}

const textLength = (c: unknown): number =>
  typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n: number, p) => n + (isObj(p) && typeof p.text === 'string' ? p.text.length : 0), 0) : 0;

function mapText(content: unknown, fn: (t: string) => string): unknown {
  if (typeof content === 'string') return fn(content);
  if (Array.isArray(content)) return content.map((p) => (isObj(p) && p.type === 'text' && typeof p.text === 'string' ? { ...p, text: fn(p.text) } : p));
  return content;
}

export function compressMessages(messages: Json[], opts: CompressionOptions): { messages: Json[]; saved: number } {
  if (opts.mode === 'off' || messages.length === 0) return { messages, saved: 0 };
  const toolMax = opts.toolOutputChars ?? 4000;
  const before = messages.reduce((n, m) => n + textLength(m.content), 0);
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');

  let out: Json[] = messages.map((m, i) => {
    if (!isObj(m) || i === lastUser || m.role === 'system') return m;
    let c = mapText(m.content, tidy);
    if (m.role === 'tool' || m.role === 'function') c = mapText(c, (t) => shorten(minifyJson(t), toolMax));
    else c = mapText(c, minifyJson);
    return c === m.content ? m : { ...m, content: c };
  });

  // Exact duplicates of the previous message (a retry loop pasted twice) carry no information.
  out = out.filter((m, i) => {
    const prev = out[i - 1];
    return !(i > 0 && i !== lastUser && prev && !m.tool_calls && !prev.tool_calls && m.role === prev.role && m.role !== 'tool' && typeof m.content === 'string' && m.content === prev.content);
  });

  if (opts.mode === 'aggressive') {
    const budget = opts.historyChars ?? 24_000;
    const keepLast = Math.max(2, opts.keepLast ?? 6);
    const total = out.reduce((n, m) => n + textLength(m.content), 0);
    if (total > budget && out.length > keepLast + 1) {
      const system = out.filter((m) => m.role === 'system');
      let tail = out.slice(-keepLast);
      // Never start the kept tail with a tool result whose assistant tool call would be cut off.
      while (tail.length > 1 && tail[0]?.role === 'tool') tail = out.slice(out.length - tail.length - 1);
      const dropped = out.length - system.length - tail.length;
      if (dropped > 0) out = [...system, { role: 'user', content: `[${dropped} earlier messages were removed to save space]` }, ...tail];
    }
  }

  const after = out.reduce((n, m) => n + textLength(m.content), 0);
  return after < before ? { messages: out, saved: before - after } : { messages, saved: 0 };
}

/** Returns the payload with compressed messages (or the same object when nothing changed). Never throws. */
export function compressPayload(payload: Json, opts: CompressionOptions): { payload: Json; saved: number } {
  try {
    if (!Array.isArray(payload.messages)) return { payload, saved: 0 };
    const r = compressMessages(payload.messages as Json[], opts);
    return r.saved > 0 ? { payload: { ...payload, messages: r.messages }, saved: r.saved } : { payload, saved: 0 };
  } catch {
    return { payload, saved: 0 };
  }
}
