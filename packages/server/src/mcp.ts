/**
 * Minimal Model Context Protocol server (Streamable HTTP, stateless, JSON replies) so ChatGPT, Claude and other
 * MCP clients can use the gateway as a tool: ask a free model, list models, see provider health.
 * Every tool call goes through the normal pipeline with the caller's own token, so limits, quotas and audit apply.
 */
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpBackend {
  /** Runs a chat completion as the caller; resolves to the parsed OpenAI response or an error message. */
  chat(body: Json): Promise<{ ok: true; text: string; provider: string | null; model: string | null } | { ok: false; error: string }>;
  models(): string[];
  providers(): { provider: string; enabled: boolean; models: number; keyless: boolean }[];
  version: string;
}

const TOOLS = [
  {
    name: 'chat',
    description: 'Ask a free LLM through the gateway. Use model "auto" (picks by prompt difficulty), "fusion" (several models merged), "auto:<profile>" or an exact model id.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The question or instruction.' },
        system: { type: 'string', description: 'Optional system prompt.' },
        model: { type: 'string', description: 'Model id or virtual model. Default: auto.' },
        max_tokens: { type: 'integer', minimum: 1, maximum: 8192 },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
      },
      required: ['prompt'],
    },
  },
  { name: 'list_models', description: 'List the model ids this gateway can serve, including virtual ones (auto, fusion, profiles).', inputSchema: { type: 'object', properties: {} } },
  { name: 'provider_status', description: 'Show which providers are enabled (have a key or need none) and how many models each offers.', inputSchema: { type: 'object', properties: {} } },
];

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const result = (id: unknown, r: unknown) => ({ jsonrpc: '2.0', id, result: r });
const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(name: string, args: Json, backend: McpBackend): Promise<unknown> {
  if (name === 'list_models') return text(backend.models().join('\n'));
  if (name === 'provider_status') {
    return text(backend.providers().map((p) => `${p.provider}: ${p.enabled ? 'enabled' : 'no key'}${p.keyless ? ' (keyless)' : ''}, ${p.models} models`).join('\n'));
  }
  if (name === 'chat') {
    if (typeof args.prompt !== 'string' || args.prompt.trim() === '') return text("'prompt' is required", true);
    const messages: Json[] = [];
    if (typeof args.system === 'string' && args.system) messages.push({ role: 'system', content: args.system });
    messages.push({ role: 'user', content: args.prompt });
    const body: Json = { model: typeof args.model === 'string' && args.model ? args.model : 'auto', messages };
    if (typeof args.max_tokens === 'number') body.max_tokens = args.max_tokens;
    if (typeof args.temperature === 'number') body.temperature = args.temperature;
    const r = await backend.chat(body);
    return r.ok ? text(`${r.text}${r.model ? `\n\n[answered by ${r.provider ?? '?'} / ${r.model}]` : ''}`) : text(r.error, true);
  }
  return undefined;
}

/** Handles one JSON-RPC message. Returns `undefined` for notifications (nothing to send back). */
export async function handleMessage(msg: unknown, backend: McpBackend): Promise<Json | undefined> {
  if (!isObj(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(isObj(msg) ? msg.id : null, -32600, 'Invalid request');
  const hasId = msg.id !== undefined && msg.id !== null;
  const params = isObj(msg.params) ? msg.params : {};
  if (!hasId) return undefined; // notifications/initialized, notifications/cancelled, ...
  switch (msg.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return result(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'pourgatellm', version: backend.version },
        instructions: 'PourGateLLM gateway: use the chat tool to ask free LLMs; model "auto" picks one by difficulty.',
      });
    }
    case 'ping':
      return result(msg.id, {});
    case 'tools/list':
      return result(msg.id, { tools: TOOLS });
    case 'tools/call': {
      if (typeof params.name !== 'string') return rpcError(msg.id, -32602, "'name' is required");
      const args = isObj(params.arguments) ? params.arguments : {};
      try {
        const out = await callTool(params.name, args, backend);
        return out === undefined ? rpcError(msg.id, -32602, `Unknown tool: ${params.name}`) : result(msg.id, out);
      } catch (e) {
        return result(msg.id, text(`Tool failed: ${e instanceof Error ? e.message : 'error'}`, true));
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

/** Handles a POST body (single message or batch). `status` is 202 when there is nothing to reply with. */
export async function handleBody(body: unknown, backend: McpBackend): Promise<{ status: number; json?: unknown }> {
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > 20) return { status: 400, json: rpcError(null, -32600, 'Batch must have 1-20 messages') };
    const out = (await Promise.all(body.map((m) => handleMessage(m, backend)))).filter((r): r is Json => r !== undefined);
    return out.length ? { status: 200, json: out } : { status: 202 };
  }
  const r = await handleMessage(body, backend);
  return r ? { status: 200, json: r } : { status: 202 };
}
