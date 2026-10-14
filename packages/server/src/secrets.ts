import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const IV_LEN = 12;
const TAG_LEN = 16;

/** Accepts 64 hex chars or base64 of exactly 32 bytes. */
export function parseMasterKey(raw: string): Buffer {
  const v = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (key.length !== 32) throw new Error('POURGATE_MASTER_KEY must be 32 bytes (64 hex chars or base64)');
  return key;
}

/**
 * Master key from the environment when given, otherwise from a key file that is created on first use
 * (mode 0600). Keeping the key out of the data volume (env var) is the stronger setup.
 */
export function loadMasterKey(opts: { env?: string; keyfile: string }): Buffer {
  if (opts.env?.trim()) return parseMasterKey(opts.env);
  if (existsSync(opts.keyfile)) return parseMasterKey(readFileSync(opts.keyfile, 'utf8'));
  mkdirSync(dirname(opts.keyfile), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(opts.keyfile, `${key.toString('base64')}\n`, { mode: 0o600 });
  chmodSync(opts.keyfile, 0o600);
  return key;
}

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). `aad` binds the secret to its context. */
export function encryptSecret(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(blob: string, key: Buffer, aad: string): string {
  const raw = Buffer.from(blob, 'base64');
  if (raw.length < IV_LEN + TAG_LEN) throw new Error('ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_LEN));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(raw.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8');
}
