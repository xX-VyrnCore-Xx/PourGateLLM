import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Json = Record<string, unknown>;

/** What a plugin sees of a request: the (OpenAI-format) body and non-secret metadata. */
export type EndpointKind = 'chat' | 'embeddings' | 'transcription' | 'speech' | 'images';

export interface RequestContext {
  /** For `transcription` the body holds the text fields only (the audio is never exposed) and rewrites are ignored; rejecting still works. */
  endpoint: EndpointKind;
  body: Json;
  /** Client token id, or null for static env tokens. */
  clientId: number | null;
  /** Request headers without credentials (authorization, x-api-key, cookie). */
  headers: Record<string, string>;
}

export type RequestResult = void | { body?: Json } | { reject: { status?: number; message: string } };

/** Metadata about a finished request. Never contains prompts or completions. */
export interface ResponseInfo {
  endpoint: EndpointKind;
  requested: string;
  provider: string | null;
  model: string | null;
  status: number;
  totalMs: number;
  tokens: number | null;
  cache: 'hit' | 'semantic' | 'miss' | null;
  clientId: number | null;
  error: string | null;
}

export interface AdapterRequestInput {
  body: Json;
  model: string;
  baseUrl: string;
  apiKey: string;
  stream: boolean;
}

/** Lets the gateway talk to providers whose API is not OpenAI-compatible. */
export interface ProviderAdapter {
  /** Build the upstream request for a chat call. `body` is OpenAI chat-completions format. */
  buildRequest(input: AdapterRequestInput): { url: string; init: RequestInit };
  /**
   * Turn a successful upstream response into an OpenAI chat-completions response
   * (a JSON body, or an SSE stream when `stream` is true). Error statuses never reach this.
   */
  parseResponse(res: Response, ctx: { model: string; stream: boolean }): Response | Promise<Response>;
}

export interface Plugin {
  name: string;
  init?(ctx: { log: (msg: string) => void }): void | Promise<void>;
  onRequest?(req: RequestContext): RequestResult | Promise<RequestResult>;
  onResponse?(info: ResponseInfo): void | Promise<void>;
  adapters?: Record<string, ProviderAdapter>;
}

export const HOOK_TIMEOUT_MS = 5000;

async function withTimeout<T>(p: T | Promise<T>, label: string, ms = HOOK_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(p),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class PluginError extends Error {
  constructor(
    message: string,
    readonly plugin: string,
  ) {
    super(message);
  }
}

export class RejectedByPlugin extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly plugin: string,
  ) {
    super(message);
  }
}

function validate(mod: unknown, file: string): Plugin {
  const p = ((mod as { default?: unknown })?.default ?? mod) as Partial<Plugin> | undefined;
  if (!p || typeof p !== 'object') throw new Error(`${file}: must export a plugin object (default export)`);
  if (typeof p.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(p.name)) throw new Error(`${file}: "name" must match [a-z0-9-]+`);
  for (const hook of ['init', 'onRequest', 'onResponse'] as const) {
    if (p[hook] !== undefined && typeof p[hook] !== 'function') throw new Error(`${file}: "${hook}" must be a function`);
  }
  if (p.adapters !== undefined) {
    if (typeof p.adapters !== 'object' || p.adapters === null) throw new Error(`${file}: "adapters" must be an object`);
    for (const [name, a] of Object.entries(p.adapters)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`${file}: adapter name "${name}" must match [a-z0-9-]+`);
      if (typeof a?.buildRequest !== 'function' || typeof a?.parseResponse !== 'function') {
        throw new Error(`${file}: adapter "${name}" needs buildRequest() and parseResponse()`);
      }
    }
  }
  return p as Plugin;
}

/**
 * Loads trusted plugin modules (`*.mjs` / `*.js`) from a directory. Plugins run in-process with the gateway's
 * privileges, so only install code you would run yourself.
 */
export class PluginHost {
  readonly adapters = new Map<string, ProviderAdapter>();

  constructor(
    readonly plugins: Plugin[] = [],
    private readonly log: (msg: string) => void = console.log,
  ) {
    for (const p of plugins) {
      for (const [name, a] of Object.entries(p.adapters ?? {})) {
        if (this.adapters.has(name)) throw new Error(`adapter "${name}" is defined by more than one plugin`);
        this.adapters.set(name, a);
      }
    }
  }

  static async load(dir: string, log: (msg: string) => void = console.log): Promise<PluginHost> {
    const root = resolve(dir);
    if (!existsSync(root)) return new PluginHost([], log);
    const files = readdirSync(root).filter((f) => /\.(mjs|js)$/.test(f)).sort();
    const plugins: Plugin[] = [];
    for (const file of files) {
      const mod = await import(pathToFileURL(join(root, file)).href);
      const plugin = validate(mod, file);
      if (plugins.some((p) => p.name === plugin.name)) throw new Error(`${file}: duplicate plugin name "${plugin.name}"`);
      await plugin.init?.({ log: (m) => log(`[plugin:${plugin.name}] ${m}`) });
      plugins.push(plugin);
    }
    return new PluginHost(plugins, log);
  }

  get names(): string[] {
    return this.plugins.map((p) => p.name);
  }

  get hasHooks(): boolean {
    return this.plugins.some((p) => p.onRequest || p.onResponse);
  }

  /**
   * Runs `onRequest` hooks in load order. A hook may replace the body or reject the request. A hook that throws or
   * times out fails the request closed (the privacy-minded default for plugins such as redactors).
   */
  async runOnRequest(ctx: RequestContext): Promise<Json> {
    let body = ctx.body;
    for (const p of this.plugins) {
      if (!p.onRequest) continue;
      let result: RequestResult;
      try {
        result = await withTimeout(p.onRequest({ ...ctx, body }), `plugin ${p.name} onRequest`);
      } catch (err) {
        throw new PluginError(err instanceof Error ? err.message : 'hook failed', p.name);
      }
      if (result && 'reject' in result) throw new RejectedByPlugin(result.reject.status ?? 400, result.reject.message, p.name);
      if (result && 'body' in result && result.body) body = result.body;
    }
    return body;
  }

  /** Fire-and-forget: observers can neither slow down nor break a request. */
  runOnResponse(info: ResponseInfo): void {
    for (const p of this.plugins) {
      if (!p.onResponse) continue;
      void withTimeout((async () => p.onResponse!(info))(), `plugin ${p.name} onResponse`).catch((err) =>
        this.log(`[plugin:${p.name}] onResponse failed: ${err instanceof Error ? err.message : err}`),
      );
    }
  }
}
