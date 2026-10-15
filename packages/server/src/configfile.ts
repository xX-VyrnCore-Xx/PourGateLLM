/** Helpers for the KEY=VALUE config file (config.env / .env). Comments and unknown lines are preserved. */

const LINE = /^\s*(#\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m || m[1]) continue; // skip comments
    out[m[2]!] = m[3]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * Sets NAME=value. An existing active line is replaced, a commented-out `# NAME=` line is activated,
 * otherwise the setting is appended. Everything else in the file stays as it is.
 */
export function setEnvValue(text: string, name: string, value: string): string {
  const lines = text.split(/\r?\n/);
  let active = -1;
  let commented = -1;
  lines.forEach((line, i) => {
    const m = LINE.exec(line);
    if (!m || m[2] !== name) return;
    if (m[1]) commented = commented < 0 ? i : commented;
    else active = i;
  });
  const target = active >= 0 ? active : commented;
  if (target >= 0) lines[target] = `${name}=${value}`;
  else {
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${name}=${value}`, '');
  }
  return lines.join('\n');
}

export function splitKeys(value: string | undefined): string[] {
  return (value ?? '').split(',').map((k) => k.trim()).filter(Boolean);
}

/** Adds a key to a comma-separated list value; returns the same list if it is already there. */
export function addKeyToList(value: string | undefined, key: string): string {
  const keys = splitKeys(value);
  if (!keys.includes(key)) keys.push(key);
  return keys.join(',');
}

export function validateApiKey(key: string): string | undefined {
  if (key.length < 8 || key.length > 500) return 'a key is normally 8-500 characters long';
  if (/[\s,]/.test(key)) return 'a key cannot contain spaces or commas';
  return undefined;
}
