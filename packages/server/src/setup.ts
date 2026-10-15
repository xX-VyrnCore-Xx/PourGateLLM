import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ProviderEntry } from '@pourgate/shared';
import { addKeyToList, parseEnv, setEnvValue, splitKeys, validateApiKey } from './configfile.js';

export interface SetupIO {
  /** Ask a question; resolves to the trimmed answer (empty string for just Enter). */
  ask(question: string): Promise<string>;
  /** Ask for a secret without echoing it. */
  askSecret(question: string): Promise<string>;
  print(line: string): void;
}

export interface SetupResult {
  added: { provider: string; envName: string }[];
  passwordChanged: boolean;
}

/**
 * Interactive provider-key setup: for each provider offers to paste a key (hidden input), appends it to the
 * provider's `*_API_KEYS` list in the config file and leaves everything else untouched.
 */
export async function runSetupWizard(opts: { configFile: string; registry: ProviderEntry[]; io: SetupIO }): Promise<SetupResult> {
  const { io } = opts;
  let text = existsSync(opts.configFile) ? readFileSync(opts.configFile, 'utf8') : '';
  const result: SetupResult = { added: [], passwordChanged: false };

  io.print('Add API keys for the providers you use. Press Enter to skip a provider; keys are not shown while you type.\n');
  for (const p of opts.registry) {
    const current = splitKeys(parseEnv(text)[p.api_key_env]);
    io.print(`${p.provider}${current.length ? `  (${current.length} key${current.length > 1 ? 's' : ''} configured)` : ''}${p.signup_url ? `  - get a key at ${p.signup_url}` : ''}`);
    for (;;) {
      const key = await io.askSecret(current.length || result.added.some((a) => a.provider === p.provider) ? '  another key (Enter to continue): ' : '  API key (Enter to skip): ');
      if (!key) break;
      const problem = validateApiKey(key);
      if (problem) {
        io.print(`  ! ${problem}`);
        continue;
      }
      text = setEnvValue(text, p.api_key_env, addKeyToList(parseEnv(text)[p.api_key_env], key));
      result.added.push({ provider: p.provider, envName: p.api_key_env });
      io.print('  + added');
    }
  }

  const pw = parseEnv(text).POURGATE_ADMIN_PASSWORD;
  if (!pw || pw.length < 12) {
    const next = await io.askSecret('Dashboard password is missing or short. New password (min 12 characters, Enter to keep): ');
    if (next && next.length >= 12) {
      text = setEnvValue(text, 'POURGATE_ADMIN_PASSWORD', next);
      result.passwordChanged = true;
    } else if (next) io.print('  ! too short, kept the old one');
  }

  saveConfig(opts.configFile, text);
  return result;
}

/** Non-interactive variant: `--provider groq --key gsk_...` (repeatable pairs). */
export function addKeysNonInteractive(configFile: string, registry: ProviderEntry[], pairs: { provider: string; key: string }[]): { provider: string; envName: string }[] {
  let text = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '';
  const out: { provider: string; envName: string }[] = [];
  for (const { provider, key } of pairs) {
    const entry = registry.find((p) => p.provider === provider);
    if (!entry) throw new Error(`unknown provider "${provider}" (known: ${registry.map((p) => p.provider).join(', ')})`);
    const problem = validateApiKey(key);
    if (problem) throw new Error(`${provider}: ${problem}`);
    text = setEnvValue(text, entry.api_key_env, addKeyToList(parseEnv(text)[entry.api_key_env], key));
    out.push({ provider, envName: entry.api_key_env });
  }
  saveConfig(configFile, text);
  return out;
}

/** The config file holds API keys: always owner-only (no-op on Windows, where the profile folder is already private). */
function saveConfig(file: string, text: string): void {
  writeFileSync(file, text, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}
