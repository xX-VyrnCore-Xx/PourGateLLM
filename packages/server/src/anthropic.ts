import { randomBytes } from 'node:crypto';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const rid = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;

// ---------------------------------------------------------------------------
// Request: Anthropic Messages -> OpenAI chat completions

/** Maps Anthropic model names to gateway virtual models (haiku → small, sonnet → medium, opus → large). */
export function mapModel(model: string): string {
  if (!/^claude/i.test(model)) return model;
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'auto:small';
  if (m.includes('sonnet')) return 'auto:medium';
  if (m.includes('opus')) return 'auto:large';
  return 'auto';
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

export class AnthropicRequestError extends Error {}

/** First problem found with an Anthropic request, or null. */
export function validateRequest(body: Json): string | null {
  if (typeof body.model !== 'string' || body.model === '') return "'model' is required";
  if (!Array.isArray(body.messages) || body.messages.length === 0) return "'messages' must be a non-empty array";
  if (typeof body.max_tokens !== 'number' || !Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
    return "'max_tokens' is required and must be a positive integer";
  }
  for (const m of body.messages) {
    if (!isObj(m) || (m.role !== 'user' && m.role !== 'assistant')) return "each message needs a role of 'user' or 'assistant'";
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) return 'message content must be a string or an array of blocks';
  }
  return null;
}

function toOpenAIMessages(body: Json): Json[] {
  const out: Json[] = [];
  const system = textOf(body.system);
  if (system) out.push({ role: 'system', content: system });

  for (const m of body.messages as Json[]) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as unknown[]);
    if (m.role === 'assistant') {
      const text = textOf(blocks);
      const toolCalls = blocks
        .filter((b): b is Json => isObj(b) && b.type === 'tool_use')
        .map((b) => ({
          id: String(b.id ?? rid('call')),
          type: 'function',
          function: { name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg: Json = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (text || toolCalls.length) out.push(msg);
      continue;
    }
    // user turn: tool results become `tool` messages (they must precede the user's own text), the rest a user message
    const parts: Json[] = [];
    for (const b of blocks) {
      if (!isObj(b)) continue;
      if (b.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content : textOf(b.content);
        out.push({ role: 'tool', tool_call_id: String(b.tool_use_id ?? ''), content: b.is_error ? `Error: ${content}` : content });
      } else if (b.type === 'text' && typeof b.text === 'string') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image' && isObj(b.source)) {
        const src = b.source;
        const url = src.type === 'base64' ? `data:${String(src.media_type)};base64,${String(src.data)}` : typeof src.url === 'string' ? src.url : null;
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    if (parts.length === 1 && parts[0]!.type === 'text') out.push({ role: 'user', content: parts[0]!.text });
    else if (parts.length) out.push({ role: 'user', content: parts });
  }
  return out;
}

export function toOpenAIRequest(body: Json): Json {
  const req: Json = {
    model: mapModel(body.model as string),
    messages: toOpenAIMessages(body),
    max_tokens: body.max_tokens,
  };
  if (typeof body.temperature === 'number') req.temperature = body.temperature;
  if (typeof body.top_p === 'number') req.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) req.stop = body.stop_sequences;
  if (body.stream === true) req.stream = true;
  if (Array.isArray(body.tools) && body.tools.length) {
    req.tools = (body.tools as Json[])
      .filter((t) => isObj(t) && typeof t.name === 'string')
      .map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } } }));
  }
  const tc = body.tool_choice;
  if (isObj(tc)) {
    if (tc.type === 'auto') req.tool_choice = 'auto';
    else if (tc.type === 'any') req.tool_choice = 'required';
    else if (tc.type === 'none') req.tool_choice = 'none';
    else if (tc.type === 'tool' && typeof tc.name === 'string') req.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  return req;
}

/** Rough prompt size in tokens (chars / 4), used for count_tokens and the stream's initial usage. */
export function estimateInputTokens(body: Json): number {
  let chars = textOf(body.system).length;
  for (const m of Array.isArray(body.messages) ? (body.messages as Json[]) : []) {
    chars += typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content ?? '').length;
  }
  if (Array.isArray(body.tools)) chars += JSON.stringify(body.tools).length;
  return Math.max(1, Math.ceil(chars / 4));
}

// ---------------------------------------------------------------------------
// Response: OpenAI -> Anthropic

const STOP_REASONS: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };
const stopReason = (r: unknown) => (typeof r === 'string' ? (STOP_REASONS[r] ?? 'end_turn') : 'end_turn');

export function toAnthropicMessage(openai: Json, requestedModel: string): Json {
  const choice = (Array.isArray(openai.choices) ? openai.choices[0] : undefined) as Json | undefined;
  const message = (choice?.message ?? {}) as Json;
  const content: Json[] = [];
  if (typeof message.content === 'string' && message.content !== '') content.push({ type: 'text', text: message.content });
  for (const tc of Array.isArray(message.tool_calls) ? (message.tool_calls as Json[]) : []) {
    const fn = (tc.function ?? {}) as Json;
    let input: unknown = {};
    try {
      input = JSON.parse(String(fn.arguments ?? '{}'));
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: String(tc.id ?? rid('toolu')), name: String(fn.name ?? ''), input });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const usage = (openai.usage ?? {}) as Json;
  return {
    id: rid('msg'),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: stopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: Number(usage.prompt_tokens ?? 0), output_tokens: Number(usage.completion_tokens ?? 0) },
  };
}

export function anthropicError(status: number, message: string): Response {
  const type =
    status === 401 || status === 403 ? 'authentication_error' : status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error' : status === 503 ? 'overloaded_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
  return Response.json({ type: 'error', error: { type, message } }, { status });
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Translates an OpenAI chat SSE stream into Anthropic Messages stream events. */
export function translateStream(upstream: ReadableStream<Uint8Array>, model: string, inputEstimate: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const reader = upstream.getReader();
  const id = rid('msg');
  let buffer = '';
  let started = false;
  let nextIndex = 0;
  let open: { kind: 'text' | 'tool'; index: number; tool?: number } | null = null;
  const toolBlocks = new Map<number, number>();
  let outChars = 0;
  let usageIn: number | null = null;
  let usageOut: number | null = null;
  let reason: string | null = null;
  let done = false;

  const start = (out: string[]) => {
    if (started) return;
    started = true;
    out.push(sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputEstimate, output_tokens: 0 } } }));
  };
  const closeOpen = (out: string[]) => {
    if (open) out.push(sse('content_block_stop', { type: 'content_block_stop', index: open.index }));
    open = null;
  };
  const finish = (out: string[]) => {
    if (done) return;
    done = true;
    start(out);
    closeOpen(out);
    out.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: reason ?? 'end_turn', stop_sequence: null }, usage: { input_tokens: usageIn ?? inputEstimate, output_tokens: usageOut ?? Math.ceil(outChars / 4) } }));
    out.push(sse('message_stop', { type: 'message_stop' }));
  };

  const handle = (payload: string, out: string[]) => {
    if (payload === '[DONE]') return finish(out);
    let chunk: Json;
    try {
      chunk = JSON.parse(payload) as Json;
    } catch {
      return;
    }
    if (isObj(chunk.error)) {
      start(out);
      closeOpen(out);
      out.push(sse('error', { type: 'error', error: { type: 'api_error', message: String((chunk.error as Json).message ?? 'upstream error') } }));
      done = true;
      return;
    }
    start(out);
    if (isObj(chunk.usage)) {
      if (typeof chunk.usage.prompt_tokens === 'number') usageIn = chunk.usage.prompt_tokens;
      if (typeof chunk.usage.completion_tokens === 'number') usageOut = chunk.usage.completion_tokens;
    }
    const choice = (Array.isArray(chunk.choices) ? chunk.choices[0] : undefined) as Json | undefined;
    const delta = (choice?.delta ?? {}) as Json;
    if (typeof delta.content === 'string' && delta.content !== '') {
      if (open?.kind !== 'text') {
        closeOpen(out);
        open = { kind: 'text', index: nextIndex++ };
        out.push(sse('content_block_start', { type: 'content_block_start', index: open.index, content_block: { type: 'text', text: '' } }));
      }
      outChars += delta.content.length;
      out.push(sse('content_block_delta', { type: 'content_block_delta', index: open.index, delta: { type: 'text_delta', text: delta.content } }));
    }
    for (const tc of Array.isArray(delta.tool_calls) ? (delta.tool_calls as Json[]) : []) {
      const t = typeof tc.index === 'number' ? tc.index : 0;
      const fn = (tc.function ?? {}) as Json;
      if (!toolBlocks.has(t)) {
        closeOpen(out);
        const index = nextIndex++;
        toolBlocks.set(t, index);
        open = { kind: 'tool', index, tool: t };
        out.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: String(tc.id ?? rid('toolu')), name: String(fn.name ?? ''), input: {} } }));
      }
      if (typeof fn.arguments === 'string' && fn.arguments !== '') {
        outChars += fn.arguments.length;
        out.push(sse('content_block_delta', { type: 'content_block_delta', index: toolBlocks.get(t)!, delta: { type: 'input_json_delta', partial_json: fn.arguments } }));
      }
    }
    if (choice?.finish_reason != null) {
      reason = stopReason(choice.finish_reason);
      closeOpen(out);
    }
  };

  return new ReadableStream<Uint8Array>({
    // Keep reading until something can be emitted: a read may end mid-line and yield no complete event.
    async pull(controller) {
      const out: string[] = [];
      try {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) {
            if (buffer.trim().startsWith('data:')) handle(buffer.trim().slice(5).trim(), out);
            finish(out);
            if (out.length) controller.enqueue(enc.encode(out.join('')));
            controller.close();
            return;
          }
          buffer += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line.startsWith('data:')) handle(line.slice(5).trim(), out);
          }
          if (out.length) {
            controller.enqueue(enc.encode(out.join('')));
            return;
          }
        }
      } catch {
        start(out);
        out.push(sse('error', { type: 'error', error: { type: 'api_error', message: 'upstream stream failed' } }));
        controller.enqueue(enc.encode(out.join('')));
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Converts the gateway's OpenAI-format response into the Anthropic format:
 * errors, non-streaming messages and SSE streams. `requestedModel` is echoed back, as Anthropic does.
 */
export async function wrapResponse(res: Response, requestedModel: string, inputEstimate: number): Promise<Response> {
  if (!res.ok) {
    let message = res.statusText || 'request failed';
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (j?.error?.message) message = j.error.message;
    } catch {
      // keep status text
    }
    const out = anthropicError(res.status, message);
    for (const h of ['x-pourgate-provider', 'x-pourgate-model']) {
      const v = res.headers.get(h);
      if (v) out.headers.set(h, v);
    }
    return out;
  }
  const headers = new Headers();
  for (const h of ['x-pourgate-provider', 'x-pourgate-model', 'x-pourgate-tier', 'x-pourgate-complexity', 'x-pourgate-cache', 'x-pourgate-redacted', 'x-pourgate-trace-id', 'age']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (res.headers.get('content-type')?.includes('text/event-stream') && res.body) {
    headers.set('content-type', 'text/event-stream; charset=utf-8');
    headers.set('cache-control', 'no-cache');
    return new Response(translateStream(res.body, requestedModel, inputEstimate), { status: 200, headers });
  }
  headers.set('content-type', 'application/json');
  const json = (await res.json()) as Json;
  return new Response(JSON.stringify(toAnthropicMessage(json, requestedModel)), { status: 200, headers });
}
