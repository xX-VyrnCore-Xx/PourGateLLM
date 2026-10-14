import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { providerSchema, type ProviderEntry } from '@pourgate/shared';

export function loadRegistry(dir: string): ProviderEntry[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  return files.map((file) => {
    const result = providerSchema.safeParse(parse(readFileSync(join(dir, file), 'utf8')));
    if (!result.success) {
      throw new Error(`Invalid registry file ${file}: ${result.error.message}`);
    }
    return result.data;
  });
}
