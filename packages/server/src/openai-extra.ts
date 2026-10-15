import { randomBytes } from 'node:crypto';

/**
 * OpenAI surfaces that sit on top of chat completions: the legacy `/v1/completions` (editor autocomplete)
 * and the Responses API `/v1/responses` (Codex CLI and newer SDKs). Requests are translated to a chat request,
 * go through the normal pipeline (keys, limits, failover, cache, privacy) and the answer is translated back.
 */
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const rid = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

export class BadRequest extends Error {}

const COMMON = ['temperature', 'top_p', 'seed', 'frequency_penalty', 'presence_penalty', 'user'] as const;

function copyCommon(from: Json, to: Json): void {
  for (const k of COMMON) if (from[k] !== undefined && from[k] !== null) to[k] = from[k];
}

/** Error in the OpenAI shape, used for failures detected before the pipeline runs. */
export function openaiError(status: number, message: string, code = 'invalid_request_error'): Response {
  return Response.json({ error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', code } }, { status });
}

// ---------------------------------------------------------------------------
// SSE plumbing

/** Re-emits an upstream chat SSE stream through `onData` (one call per `data:` payload) and `onEnd`. */
export function mapSse(upstream: ReadableStream<Uint8Array>, onData: (payload: string, out: string[]) => void, onEnd: (out: string[]) => void, onFail: (out: string[]) => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const reader = upstream.getReader();
  let buffer = '';
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const out: string[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim().startsWith('data:')) onData(buffer.trim().slice(5).trim(), out);
            onEnd(out);
            if (out.length) controller.enqueue(enc.encode(out.join('')));
            controller.close();
            return;
          }
          buffer += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line.startsWith('data:')) onData(line.slice(5).trim(), out);
          }
          if (out.length) {
            controller.enqueue(enc.encode(out.join('')));
            return;
          }
        }
      } catch {
        onFail(out);
        controller.enqueue(enc.encode(out.join('')));
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

const PASS_HEADERS = ['x-pourgate-provider', 'x-pourgate-model', 'x-pourgate-tier', 'x-pourgate-complexity', 'x-pourgate-cache', 'x-pourgate-redacted', 'x-pourgate-trace-id', 'age'];

/** Shared wrapper: errors pass through untouched, streams and JSON bodies are translated. */
export async function translate(res: Response, json: (body: Json) => Json, stream: (s: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>): Promise<Response> {
  if (!res.ok) return res;
  const headers = new Headers();
  for (const h of PASS_HEADERS) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (res.headers.get('content-type')?.includes('text/event-stream') && res.body) {
    headers.set('content-type', 'text/event-stream; charset=utf-8');
    headers.set('cache-control', 'no-cache');
    return new Response(stream(res.body), { status: 200, headers });
  }
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(json((await res.json()) as Json)), { status: 200, headers });
}

export const dataLine = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
export const finishOf = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// ---------------------------------------------------------------------------
// /v1/completions

export function completionsToChat(body: Json): Json {
  if (typeof body.model !== 'string' || body.model === '') throw new BadRequest("'model' is required");
  let prompt = body.prompt;
  if (Array.isArray(prompt)) {
    if (prompt.length !== 1 || typeof prompt[0] !== 'string') throw new BadRequest("'prompt' must be a string (batched prompts are not supported)");
    prompt = prompt[0];
  }
  if (typeof prompt !== 'string') throw new BadRequest("'prompt' must be a string");
  if (body.n !== undefined && body.n !== 1) throw new BadRequest("'n' other than 1 is not supported");
  const suffix = typeof body.suffix === 'string' && body.suffix !== '' ? body.suffix : undefined;
  const messages: Json[] = [
    {
      role: 'system',
      content: suffix
        ? 'You are a code completion engine. Reply with only the text that belongs between PREFIX and SUFFIX, no explanation, no markdown fences.'
        : 'You are a text completion engine. Reply with only the continuation of the given text, no explanation, no markdown fences.',
    },
    { role: 'user', content: suffix ? `PREFIX:\n${prompt}\n\nSUFFIX:\n${suffix}` : prompt },
  ];
  const out: Json = { model: body.model, messages };
  copyCommon(body, out);
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.stop != null) out.stop = body.stop;
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

function completionFromChat(chat: Json, model: string): Json {
  const choice = (Array.isArray(chat.choices) ? chat.choices[0] : undefined) as Json | undefined;
  const text = isObj(choice?.message) && typeof (choice!.message as Json).content === 'string' ? ((choice!.message as Json).content as string) : '';
  return {
    id: typeof chat.id === 'string' ? chat.id.replace(/^chatcmpl/, 'cmpl') : rid('cmpl'),
    object: 'text_completion',
    created: typeof chat.created === 'number' ? chat.created : now(),
    model,
    choices: [{ text, index: 0, logprobs: null, finish_reason: finishOf(choice?.finish_reason) ?? 'stop' }],
    ...(isObj(chat.usage) ? { usage: chat.usage } : {}),
  };
}

function completionStream(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const id = rid('cmpl');
  const created = now();
  let usage: Json | undefined;
  let finished = false;
  const chunk = (text: string, finish: string | null) => dataLine({ id, object: 'text_completion', created, model, choices: [{ text, index: 0, logprobs: null, finish_reason: finish }] });
  return mapSse(
    upstream,
    (payload, out) => {
      if (payload === '[DONE]') return;
      let c: Json;
      try {
        c = JSON.parse(payload) as Json;
      } catch {
        return;
      }
      if (isObj(c.error)) {
        out.push(dataLine({ error: c.error }));
        finished = true;
        return;
      }
      if (isObj(c.usage)) usage = c.usage;
      const choice = (Array.isArray(c.choices) ? c.choices[0] : undefined) as Json | undefined;
      const text = isObj(choice?.delta) ? (choice!.delta as Json).content : undefined;
      if (typeof text === 'string' && text !== '') out.push(chunk(text, null));
      const fr = finishOf(choice?.finish_reason);
      if (fr && !finished) {
        finished = true;
        out.push(chunk('', fr));
      }
    },
    (out) => {
      if (!finished) out.push(chunk('', 'stop'));
      if (usage) out.push(dataLine({ id, object: 'text_completion', created, model, choices: [], usage }));
      out.push('data: [DONE]\n\n');
    },
    (out) => out.push(dataLine({ error: { message: 'upstream stream failed', type: 'server_error' } }), 'data: [DONE]\n\n'),
  );
}

export const wrapCompletions = (res: Response, model: string) => translate(res, (b) => completionFromChat(b, model), (s) => completionStream(s, model));

// ---------------------------------------------------------------------------
// /v1/responses

function partsToChat(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: Json[] = [];
  for (const p of content) {
    if (!isObj(p)) continue;
    if ((p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') && typeof p.text === 'string') parts.push({ type: 'text', text: p.text });
    else if (p.type === 'input_image') {
      const url = typeof p.image_url === 'string' ? p.image_url : isObj(p.image_url) ? (p.image_url as Json).url : undefined;
      if (typeof url === 'string') parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => p.text).join('\n');
  return parts;
}

export function responsesToChat(body: Json): Json {
  if (typeof body.model !== 'string' || body.model === '') throw new BadRequest("'model' is required");
  if (body.previous_response_id != null) throw new BadRequest("'previous_response_id' is not supported: send the whole conversation in 'input' (responses are not stored)");
  const messages: Json[] = [];
  if (typeof body.instructions === 'string' && body.instructions !== '') messages.push({ role: 'system', content: body.instructions });
  const input = body.input;
  if (typeof input === 'string') messages.push({ role: 'user', content: input });
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (!isObj(item)) continue;
      if (item.type === 'function_call') {
        const call = { id: String(item.call_id ?? item.id ?? rid('call')), type: 'function', function: { name: String(item.name ?? ''), arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) } };
        const last = messages[messages.length - 1];
        if (last && last.role === 'assistant' && Array.isArray(last.tool_calls)) (last.tool_calls as Json[]).push(call);
        else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      } else if (item.type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: String(item.call_id ?? ''), content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') });
      } else if (item.type === undefined || item.type === 'message') {
        const role = item.role === 'developer' ? 'system' : item.role === 'assistant' || item.role === 'system' ? item.role : 'user';
        messages.push({ role, content: partsToChat(item.content) });
      }
      // reasoning items and hosted-tool items have no chat equivalent: skipped
    }
  } else throw new BadRequest("'input' must be a string or an array of items");
  if (messages.length === 0) throw new BadRequest("'input' is empty");

  const out: Json = { model: body.model, messages };
  copyCommon(body, out);
  if (body.max_output_tokens != null) out.max_tokens = body.max_output_tokens;
  if (Array.isArray(body.tools)) {
    const tools = (body.tools as unknown[])
      .filter((t): t is Json => isObj(t) && t.type === 'function' && typeof t.name === 'string')
      .map((t) => ({ type: 'function', function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters ?? { type: 'object', properties: {} } } }));
    if (tools.length) out.tools = tools;
  }
  const tc = body.tool_choice;
  if (out.tools && tc !== undefined) {
    if (typeof tc === 'string') out.tool_choice = tc;
    else if (isObj(tc) && tc.type === 'function' && typeof tc.name === 'string') out.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  const fmt = isObj(body.text) ? (body.text as Json).format : undefined;
  if (isObj(fmt)) {
    if (fmt.type === 'json_object') out.response_format = { type: 'json_object' };
    else if (fmt.type === 'json_schema') out.response_format = { type: 'json_schema', json_schema: { name: fmt.name ?? 'output', schema: fmt.schema ?? {}, ...(fmt.strict !== undefined ? { strict: fmt.strict } : {}) } };
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

const usageOf = (u: unknown): Json => {
  const x = isObj(u) ? u : {};
  const i = typeof x.prompt_tokens === 'number' ? x.prompt_tokens : 0;
  const o = typeof x.completion_tokens === 'number' ? x.completion_tokens : 0;
  return { input_tokens: i, input_tokens_details: { cached_tokens: 0 }, output_tokens: o, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: typeof x.total_tokens === 'number' ? x.total_tokens : i + o };
};

const messageItem = (id: string, text: string, status: string): Json => ({ id, type: 'message', status, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
const callItem = (id: string, callId: string, name: string, args: string, status: string): Json => ({ id, type: 'function_call', status, call_id: callId, name, arguments: args });

function responseFromChat(chat: Json, model: string): Json {
  const choice = (Array.isArray(chat.choices) ? chat.choices[0] : undefined) as Json | undefined;
  const msg = (isObj(choice?.message) ? choice!.message : {}) as Json;
  const output: Json[] = [];
  if (typeof msg.content === 'string' && msg.content !== '') output.push(messageItem(rid('msg'), msg.content, 'completed'));
  for (const tc of Array.isArray(msg.tool_calls) ? (msg.tool_calls as Json[]) : []) {
    const fn = (tc.function ?? {}) as Json;
    output.push(callItem(rid('fc'), String(tc.id ?? rid('call')), String(fn.name ?? ''), String(fn.arguments ?? '{}'), 'completed'));
  }
  if (output.length === 0) output.push(messageItem(rid('msg'), '', 'completed'));
  const truncated = choice?.finish_reason === 'length';
  return {
    id: rid('resp'),
    object: 'response',
    created_at: typeof chat.created === 'number' ? chat.created : now(),
    status: truncated ? 'incomplete' : 'completed',
    ...(truncated ? { incomplete_details: { reason: 'max_output_tokens' } } : { incomplete_details: null }),
    error: null,
    model,
    output,
    parallel_tool_calls: true,
    usage: usageOf(chat.usage),
  };
}

function responsesStream(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const id = rid('resp');
  const created = now();
  let seq = 0;
  let started = false;
  let done = false;
  let usage: unknown;
  let reason: string | null = null;
  const items: Json[] = [];
  let text: { itemId: string; index: number; buf: string } | null = null;
  const tools = new Map<number, { itemId: string; index: number; callId: string; name: string; args: string }>();

  const ev = (type: string, data: Json) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`;
  const shell = (status: string, output: Json[]) => ({ id, object: 'response', created_at: created, status, error: null, incomplete_details: null, model, output, parallel_tool_calls: true });
  const start = (out: string[]) => {
    if (started) return;
    started = true;
    out.push(ev('response.created', { response: shell('in_progress', []) }));
    out.push(ev('response.in_progress', { response: shell('in_progress', []) }));
  };
  const closeText = (out: string[]) => {
    if (!text) return;
    const part = { type: 'output_text', text: text.buf, annotations: [] };
    out.push(ev('response.output_text.done', { item_id: text.itemId, output_index: text.index, content_index: 0, text: text.buf }));
    out.push(ev('response.content_part.done', { item_id: text.itemId, output_index: text.index, content_index: 0, part }));
    const item = messageItem(text.itemId, text.buf, 'completed');
    items[text.index] = item;
    out.push(ev('response.output_item.done', { output_index: text.index, item }));
    text = null;
  };
  const closeTools = (out: string[]) => {
    for (const t of tools.values()) {
      if (items[t.index]) continue;
      out.push(ev('response.function_call_arguments.done', { item_id: t.itemId, output_index: t.index, arguments: t.args }));
      const item = callItem(t.itemId, t.callId, t.name, t.args, 'completed');
      items[t.index] = item;
      out.push(ev('response.output_item.done', { output_index: t.index, item }));
    }
  };
  const finish = (out: string[]) => {
    if (done) return;
    done = true;
    start(out);
    closeText(out);
    closeTools(out);
    const truncated = reason === 'length';
    const response = { ...shell(truncated ? 'incomplete' : 'completed', items.filter(Boolean)), ...(truncated ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), usage: usageOf(usage) };
    out.push(ev(truncated ? 'response.incomplete' : 'response.completed', { response }));
  };

  return mapSse(
    upstream,
    (payload, out) => {
      if (payload === '[DONE]') return finish(out);
      let c: Json;
      try {
        c = JSON.parse(payload) as Json;
      } catch {
        return;
      }
      if (isObj(c.error)) {
        start(out);
        out.push(ev('error', { code: String((c.error as Json).code ?? 'upstream_error'), message: String((c.error as Json).message ?? 'upstream error'), param: null }));
        done = true;
        return;
      }
      start(out);
      if (isObj(c.usage)) usage = c.usage;
      const choice = (Array.isArray(c.choices) ? c.choices[0] : undefined) as Json | undefined;
      const delta = (isObj(choice?.delta) ? choice!.delta : {}) as Json;
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (!text) {
          const index = items.length;
          items[index] = undefined as unknown as Json; // reserve the slot until the item is closed
          text = { itemId: rid('msg'), index, buf: '' };
          out.push(ev('response.output_item.added', { output_index: index, item: messageItem(text.itemId, '', 'in_progress') }));
          out.push(ev('response.content_part.added', { item_id: text.itemId, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
        }
        text.buf += delta.content;
        out.push(ev('response.output_text.delta', { item_id: text.itemId, output_index: text.index, content_index: 0, delta: delta.content }));
      }
      for (const tc of Array.isArray(delta.tool_calls) ? (delta.tool_calls as Json[]) : []) {
        const k = typeof tc.index === 'number' ? tc.index : 0;
        const fn = (tc.function ?? {}) as Json;
        let t = tools.get(k);
        if (!t) {
          closeText(out);
          const index = items.length;
          items[index] = undefined as unknown as Json;
          t = { itemId: rid('fc'), index, callId: String(tc.id ?? rid('call')), name: String(fn.name ?? ''), args: '' };
          tools.set(k, t);
          out.push(ev('response.output_item.added', { output_index: index, item: callItem(t.itemId, t.callId, t.name, '', 'in_progress') }));
        }
        if (typeof fn.arguments === 'string' && fn.arguments !== '') {
          t.args += fn.arguments;
          out.push(ev('response.function_call_arguments.delta', { item_id: t.itemId, output_index: t.index, delta: fn.arguments }));
        }
      }
      const fr = finishOf(choice?.finish_reason);
      if (fr) {
        reason = fr;
        closeText(out);
      }
    },
    finish,
    (out) => {
      start(out);
      out.push(ev('error', { code: 'upstream_error', message: 'upstream stream failed', param: null }));
    },
  );
}

export const wrapResponses = (res: Response, model: string) => translate(res, (b) => responseFromChat(b, model), (s) => responsesStream(s, model));
