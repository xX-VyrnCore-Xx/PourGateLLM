import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { z } from 'zod';
import type { CustomProviders } from './customproviders.js';
import type { KeyStore } from './keys.js';
import type { Profiles } from './profiles.js';
import type { TokenStore } from './tokens.js';

/**
 * Portable, passphrase-encrypted backup of everything configured by hand: stored provider keys, client tokens
 * (as hashes, so they keep working without ever being readable), custom endpoints and fallback profiles. Restoring
 * merges: it never deletes or overwrites what is already there. Request logs, caches and usage counters are not
 * included. The passphrase is the only secret protecting the file (scrypt + AES-256-GCM).
 */
const payloadSchema = z.object({
  createdAt: z.number(),
  keys: z.array(z.object({ provider: z.string().max(64), label: z.string().max(100), key: z.string().max(500), enabled: z.boolean(), weight: z.number().int().min(1).max(10) })).max(20_000),
  tokens: z
    .array(
      z.object({
        name: z.string().max(200),
        tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
        prefix: z.string().max(16),
        rpmLimit: z.number().int().nullable(),
        dailyRequestLimit: z.number().int().nullable(),
        createdAt: z.number(),
        expiresAt: z.number().nullable(),
        revokedAt: z.number().nullable(),
      }),
    )
    .max(10_000),
  customProviders: z.array(z.object({ name: z.string(), baseUrl: z.string(), signupUrl: z.string().nullable(), models: z.array(z.string()).max(200), tools: z.boolean() })).max(100),
  profiles: z.record(z.string(), z.array(z.object({ provider: z.string().optional(), model: z.string() })).max(50)),
});
export type BackupPayload = z.infer<typeof payloadSchema>;

export interface BackupEnvelope {
  format: 'pourgate-backup';
  v: 1;
  kdf: { alg: 'scrypt'; salt: string; N: number; r: number; p: number };
  iv: string;
  tag: string;
  data: string;
}

export class BackupError extends Error {}

const N = 2 ** 15;
const R = 8;
const P = 1;
const AAD = Buffer.from('pourgate-backup-v1');
export const MIN_PASSPHRASE = 8;

const derive = (pass: string, salt: Buffer, n: number, r: number, p: number) => scryptSync(pass, salt, 32, { N: n, r, p, maxmem: 256 * n * r });

export function encryptBackup(payload: BackupPayload, passphrase: string): BackupEnvelope {
  if (passphrase.length < MIN_PASSPHRASE) throw new BackupError(`the passphrase needs at least ${MIN_PASSPHRASE} characters`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(passphrase, salt, N, R, P), iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { format: 'pourgate-backup', v: 1, kdf: { alg: 'scrypt', salt: salt.toString('base64'), N, r: R, p: P }, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decryptBackup(envelope: unknown, passphrase: string): BackupPayload {
  const e = envelope as Partial<BackupEnvelope> | null;
  if (!e || e.format !== 'pourgate-backup' || e.v !== 1 || !e.kdf || e.kdf.alg !== 'scrypt' || typeof e.kdf.salt !== 'string' || typeof e.iv !== 'string' || typeof e.tag !== 'string' || typeof e.data !== 'string') {
    throw new BackupError('this is not a PourGateLLM backup file');
  }
  const { N: n, r, p } = e.kdf;
  // Refuse absurd work factors from a hostile file before spending memory on them.
  if (!(Number.isInteger(n) && n >= 2 ** 14 && n <= 2 ** 17 && (n & (n - 1)) === 0 && Number.isInteger(r) && r >= 1 && r <= 16 && Number.isInteger(p) && p >= 1 && p <= 4)) throw new BackupError('unsupported backup parameters');
  let plain: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', derive(passphrase, Buffer.from(e.kdf.salt, 'base64'), n, r, p), Buffer.from(e.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(e.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new BackupError('wrong passphrase, or the file is damaged');
  }
  const parsed = payloadSchema.safeParse(JSON.parse(plain));
  if (!parsed.success) throw new BackupError('the backup content is not valid');
  return parsed.data;
}

export interface BackupSources {
  keyStore?: KeyStore;
  tokens: TokenStore;
  custom?: CustomProviders;
  profiles?: Profiles;
  now?: () => number;
}

export function collectBackup(src: BackupSources): BackupPayload {
  const keys = (src.keyStore?.list() ?? []).flatMap((rec) => {
    const secret = src.keyStore!.secretById(rec.id);
    return secret ? [{ provider: rec.provider, label: rec.label, key: secret.key, enabled: rec.enabled, weight: rec.weight }] : [];
  });
  return {
    createdAt: (src.now ?? Date.now)(),
    keys,
    tokens: src.tokens.exportRows(),
    customProviders: (src.custom?.list() ?? []).map((c) => ({ name: c.name, baseUrl: c.baseUrl, signupUrl: c.signupUrl, models: c.models, tools: c.tools })),
    profiles: Object.fromEntries((src.profiles?.names() ?? []).map((n) => [n, src.profiles!.chain(n)!])),
  };
}

export interface RestoreCounts {
  added: number;
  skipped: number;
}
export interface RestoreResult {
  keys: RestoreCounts;
  tokens: RestoreCounts;
  customProviders: RestoreCounts;
  profiles: RestoreCounts;
}

/** Merges a backup into the running configuration. `taken` are provider names a custom endpoint may not reuse. */
export function restoreBackup(payload: BackupPayload, src: BackupSources & { taken?: ReadonlySet<string> }): RestoreResult {
  const out: RestoreResult = { keys: { added: 0, skipped: 0 }, tokens: { added: 0, skipped: 0 }, customProviders: { added: 0, skipped: 0 }, profiles: { added: 0, skipped: 0 } };
  const tally = (c: RestoreCounts, ok: boolean) => (ok ? c.added++ : c.skipped++);

  for (const c of payload.customProviders) {
    try {
      src.custom!.add({ name: c.name, baseUrl: c.baseUrl, models: c.models, signupUrl: c.signupUrl ?? undefined, tools: c.tools }, src.taken ?? new Set());
      tally(out.customProviders, true);
    } catch {
      tally(out.customProviders, false); // already there, or no longer valid
    }
  }
  for (const k of payload.keys) {
    try {
      const rec = src.keyStore!.add(k.provider, k.key, k.label, k.weight);
      if (!k.enabled) src.keyStore!.update(rec.id, { enabled: false });
      tally(out.keys, true);
    } catch {
      tally(out.keys, false); // duplicate or invalid
    }
  }
  for (const t of payload.tokens) tally(out.tokens, src.tokens.importRow(t));
  for (const [name, chain] of Object.entries(payload.profiles)) {
    if (!src.profiles || src.profiles.chain(name)) {
      tally(out.profiles, false);
      continue;
    }
    try {
      src.profiles.set(name, chain);
      tally(out.profiles, true);
    } catch {
      tally(out.profiles, false);
    }
  }
  return out;
}
