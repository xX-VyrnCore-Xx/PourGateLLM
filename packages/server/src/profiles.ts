import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { ProviderEntry } from '@pourgate/shared';
import type { Candidate } from './router.js';

/**
 * Named fallback chains. A profile is an ordered list of models; asking for `auto:<name>` (or
 * `profile:<name>`) tries them in that order, skipping the ones that cannot serve the request or are
 * rate-limited, and failing over to the next. Example `profiles.yaml`:
 *
 *   coding:
 *     - llama-3.3-70b-versatile                       # this model on whichever provider serves it
 *     - { provider: openrouter, model: "nvidia/nemotron-3-super-120b-a12b:free" }
 */
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED = new Set(['small', 'medium', 'large']);

const itemSchema = z.union([z.string().min(1), z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict()]);
const fileSchema = z.record(z.string(), z.array(itemSchema).min(1).max(50));

export interface ChainItem {
  provider?: string;
  model: string;
}

export class Profiles {
  private readonly chains: Map<string, ChainItem[]>;

  constructor(chains: Record<string, ChainItem[]> = {}) {
    this.chains = new Map(Object.entries(chains));
  }

  names(): string[] {
    return [...this.chains.keys()].sort();
  }

  chain(name: string): ChainItem[] | undefined {
    return this.chains.get(name);
  }

  /** Creates or replaces a profile. Throws on an invalid name or chain. */
  set(name: string, chain: ChainItem[]): void {
    if (!NAME.test(name) || RESERVED.has(name)) throw new Error(`invalid profile name "${name}" (lowercase letters, digits, - and _; not small/medium/large)`);
    if (chain.length === 0 || chain.length > 50) throw new Error('a profile needs 1 to 50 models');
    if (!this.chains.has(name) && this.chains.size >= 50) throw new Error('at most 50 profiles');
    this.chains.set(name, chain.map((c) => (c.provider ? { provider: c.provider, model: c.model } : { model: c.model })));
  }

  delete(name: string): boolean {
    return this.chains.delete(name);
  }

  /** YAML in the same shape `parseProfiles` reads. */
  toYaml(): string {
    const obj: Record<string, unknown[]> = {};
    for (const n of this.names()) obj[n] = this.chains.get(n)!.map((c) => (c.provider ? { provider: c.provider, model: c.model } : c.model));
    return `# Written by the dashboard (Providers > Fallback profiles). You can edit it by hand, but comments are not kept when the dashboard saves.\n${stringify(obj, { lineWidth: 0 })}`;
  }

  /** Writes the profiles file atomically. */
  save(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, this.toYaml());
    renameSync(tmp, file);
  }

  /** Profile name when `requested` is `auto:<name>` or `profile:<name>` for a defined profile. */
  profileFor(requested: string): string | undefined {
    const m = requested.match(/^(?:auto|profile):([a-z0-9][a-z0-9_-]{0,31})$/);
    return m && this.chains.has(m[1]!) ? m[1] : undefined;
  }

  /** Registry candidates for a profile, in the profile's order (duplicates removed). */
  resolve(registry: ProviderEntry[], name: string): Candidate[] {
    const out: Candidate[] = [];
    const seen = new Set<string>();
    for (const item of this.chains.get(name) ?? []) {
      for (const provider of registry) {
        if (item.provider && provider.provider !== item.provider) continue;
        for (const model of provider.models) {
          const id = `${provider.provider}|${model.id}`;
          if (model.id !== item.model || !model.capabilities.includes('chat') || seen.has(id)) continue;
          seen.add(id);
          out.push({ provider, model });
        }
      }
    }
    return out;
  }
}

export function parseProfiles(text: string): Profiles {
  const raw = parse(text) ?? {};
  const parsed = fileSchema.parse(raw);
  const chains: Record<string, ChainItem[]> = {};
  for (const [name, items] of Object.entries(parsed)) {
    if (!NAME.test(name) || RESERVED.has(name)) throw new Error(`invalid profile name "${name}" (lowercase letters, digits, - and _; not small/medium/large)`);
    chains[name] = items.map((i) => (typeof i === 'string' ? { model: i } : i));
  }
  return new Profiles(chains);
}

/** Loads the profiles file; a missing file means no profiles. A broken file is an error, not silently ignored. */
export function loadProfiles(file: string): Profiles {
  if (!existsSync(file)) return new Profiles();
  try {
    return parseProfiles(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Remembers which model last served a conversation so follow-up turns stay on it (keeping style and
 * tool-call behaviour consistent). Entries expire after `ttlMs`; the store never grows beyond `max`.
 */
export class StickyStore {
  private readonly map = new Map<string, { target: string; at: number }>();
  constructor(private readonly ttlMs = 30 * 60_000, private readonly max = 10_000, private readonly now: () => number = Date.now) {}

  get(key: string): string | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return e.target;
  }

  set(key: string, target: string): void {
    this.map.delete(key); // re-insert so the oldest entry is always first
    this.map.set(key, { target, at: this.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}
