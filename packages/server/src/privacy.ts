import type { ProviderEntry } from '@pourgate/shared';

/** off: never mask · training: mask for providers that may train on prompts (flag true or unknown) · all: always mask. */
export type PiiMode = 'off' | 'training' | 'all';
/** any: no restriction · no-training: skip providers flagged as training on prompts · strict: only providers explicitly flagged as not training. */
export type Policy = 'any' | 'no-training' | 'strict';

export interface PrivacyConfig {
  pii: PiiMode;
  policy: Policy;
}

export const DEFAULT_PRIVACY: PrivacyConfig = { pii: 'off', policy: 'any' };

const PII_RANK: Record<PiiMode, number> = { off: 0, training: 1, all: 2 };
const POLICY_RANK: Record<Policy, number> = { any: 0, 'no-training': 1, strict: 2 };

export function parsePiiMode(v: string | undefined): PiiMode {
  const s = (v ?? 'off').trim().toLowerCase();
  if (s === 'off' || s === 'training' || s === 'all') return s;
  throw new Error(`POURGATE_PII_MODE must be off, training or all (got "${v}")`);
}

export function parsePolicy(v: string | undefined): Policy {
  const s = (v ?? 'any').trim().toLowerCase();
  if (s === 'any' || s === 'no-training' || s === 'strict') return s;
  throw new Error(`POURGATE_PRIVACY_POLICY must be any, no-training or strict (got "${v}")`);
}

/**
 * Lets a client make handling stricter for one request via `x-pourgate-privacy: redact, no-training|strict`.
 * It can never loosen what the gateway operator configured.
 */
export function tighten(base: PrivacyConfig, header: string | undefined): PrivacyConfig {
  if (!header) return base;
  let { pii, policy } = base;
  for (const raw of header.split(',')) {
    const t = raw.trim().toLowerCase();
    if (t === 'redact' && PII_RANK.all > PII_RANK[pii]) pii = 'all';
    if ((t === 'no-training' || t === 'strict') && POLICY_RANK[t] > POLICY_RANK[policy]) policy = t;
  }
  return { pii, policy };
}

export function providerAllowed(policy: Policy, p: Pick<ProviderEntry, 'trains_on_prompts'>): boolean {
  if (policy === 'any') return true;
  if (policy === 'no-training') return p.trains_on_prompts !== true;
  return p.trains_on_prompts === false;
}

export function needsRedaction(pii: PiiMode, p: Pick<ProviderEntry, 'trains_on_prompts'>): boolean {
  if (pii === 'off') return false;
  if (pii === 'all') return true;
  return p.trains_on_prompts !== false;
}

// ---------------------------------------------------------------------------
// Detectors

const luhn = (digits: string): boolean => {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
};

const ibanValid = (raw: string): boolean => {
  const iban = raw.replace(/\s/g, '');
  if (iban.length < 15 || iban.length > 34) return false;
  let rem = 0;
  for (const ch of iban.slice(4) + iban.slice(0, 4)) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
};

interface Detector {
  label: string;
  re: RegExp;
  valid?: (match: string) => boolean;
}

// Order matters: secrets first, then structured identifiers, phones last (loosest pattern).
const DETECTORS: Detector[] = [
  { label: 'SECRET', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  {
    label: 'SECRET',
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|pg-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
  },
  { label: 'SECRET', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { label: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  { label: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, valid: ibanValid },
  {
    label: 'CARD',
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    valid: (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits);
    },
  },
  { label: 'TAX_ID', re: /\b[A-Z]{6}\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z]\b/gi },
  { label: 'PHONE', re: /(?<![\w+])(?:\+|00)\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{2,4}\b/g },
  { label: 'PHONE', re: /(?<![\w+])3\d{2}[\s.-]?\d{3}[\s.-]?\d{3,4}\b/g },
];

export function redactText(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const d of DETECTORS) {
    out = out.replace(d.re, (m) => {
      if (d.valid && !d.valid(m)) return m;
      count++;
      return `[${d.label}]`;
    });
  }
  return { text: out, count };
}

type Json = Record<string, unknown>;

/** Returns a copy of the chat body with PII masked in message text; images and other fields are untouched. */
export function redactBody(body: Json): { body: Json; count: number } {
  let count = 0;
  const red = (s: string) => {
    const r = redactText(s);
    count += r.count;
    return r.text;
  };
  const redactContent = (content: unknown): unknown => {
    if (typeof content === 'string') return red(content);
    if (!Array.isArray(content)) return content;
    return content.map((part) =>
      part && typeof part === 'object' && (part as Json).type === 'text' && typeof (part as Json).text === 'string'
        ? { ...(part as Json), text: red((part as Json).text as string) }
        : part,
    );
  };
  if (!Array.isArray(body.messages)) return { body, count: 0 };
  const messages = (body.messages as unknown[]).map((m) => {
    if (!m || typeof m !== 'object') return m;
    const msg = { ...(m as Json) };
    if ('content' in msg) msg.content = redactContent(msg.content);
    if (Array.isArray(msg.tool_calls)) {
      msg.tool_calls = (msg.tool_calls as Json[]).map((tc) => {
        const fn = tc?.function as Json | undefined;
        return fn && typeof fn.arguments === 'string' ? { ...tc, function: { ...fn, arguments: red(fn.arguments) } } : tc;
      });
    }
    return msg;
  });
  return { body: { ...body, messages }, count };
}

/** Masks PII in a string (or array of strings) request field such as embeddings `input` or an image `prompt`. */
export function redactTextFields(body: Json, field: string): { body: Json; count: number } {
  let count = 0;
  const red = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    const r = redactText(v);
    count += r.count;
    return r.text;
  };
  const value = body[field];
  if (value === undefined) return { body, count: 0 };
  return { body: { ...body, [field]: Array.isArray(value) ? value.map(red) : red(value) }, count };
}

export const redactEmbeddingBody = (body: Json) => redactTextFields(body, 'input');
