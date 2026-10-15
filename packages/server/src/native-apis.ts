import { randomBytes } from 'node:crypto';
import { dataLine, finishOf, mapSse, translate } from './openai-extra.js';

/**
 * Native wire formats on top of the chat pipeline: Google Gemini (`/v1beta/models/{m}:generateContent`, used by
 * Gemini CLI and the Google SDKs) and an opt-in Ollama emulation (`/api/chat`, `/api/generate`, `/api/tags`,
 * used by Zed, JetBrains, Open WebUI...). Requests are translated to chat completions and the answer back.
 */
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const rid = (p: string) => `${p}_${randomBytes(8).toString('hex')}`;

export class NativeBadRequest extends Error {}

// ---------------------------------------------------------------------------
// Gemini

/** Gemini model names that the registry does not know map to a virtual model by their size word. */
export function mapGeminiModel(name: string, known: (id: string) => boolean): string {
  const id = name.replace(/^models\//, '');
  if (known(id) || id === 'auto' || id === 'fusion' || id.startsWith('auto:')) return id;
  if (!/^gemini|^gemma/i.test(id)) return id;
  if (/pro/i.test(id)) return 'auto:large';
  if (/lite|nano|flash-8b/i.test(id)) return 'auto:small';
  if (/flash/i.test(id)) return 'auto:medium';
  return 'auto';
}

const partText = (parts: unknown): string =>
  Array.isArray(parts) ? parts.map((p) => (isObj(p) && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n') : '';

export function geminiToChat(body: Json, model: string, stream: boolean): Json {
  if (!Array.isArray(body.contents) || body.contents.length === 0) throw new NativeBadRequest("'contents' must be a non-empty array");
  const messages: Json[] = [];
  const sys = isObj(body.systemInstruction) ? partText(body.systemInstruction.parts) : typeof body.systemInstruction === 'string' ? body.systemInstruction : '';
  if (sys) messages.push({ role: 'system', content: sys });
  let n = 0;
  const pendingCalls: string[] = [];
  for (const c of body.contents as unknown[]) {
    if (!isObj(c) || !Array.isArray(c.parts)) continue;
    const role = c.role === 'model' ? 'assistant' : 'user';
    const content: Json[] = [];
    const calls: Json[] = [];
    for (const p of c.parts as unknown[]) {
      if (!isObj(p)) continue;
      if (typeof p.text === 'string') content.push({ type: 'text', text: p.text });
      else if (isObj(p.inlineData) && typeof p.inlineData.data === 'string') content.push({ type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType ?? 'image/png'};base64,${p.inlineData.data}` } });
      else if (isObj(p.functionCall)) {
        const id = `call_${++n}`;
        pendingCalls.push(id);
        calls.push({ id, type: 'function', function: { name: String(p.functionCall.name ?? ''), arguments: JSON.stringify(p.functionCall.args ?? {}) } });
      } else if (isObj(p.functionResponse)) {
        messages.push({ role: 'tool', tool_call_id: pendingCalls.shift() ?? `call_${++n}`, content: JSON.stringify(p.functionResponse.response ?? {}) });
      }
    }
    if (calls.length) messages.push({ role: 'assistant', content: content.map((x) => x.text).join('\n') || null, tool_calls: calls });
    else if (content.length) messages.push({ role, content: content.every((x) => x.type === 'text') ? content.map((x) => x.text).join('\n') : content });
  }
  const out: Json = { model, messages };
  const g = isObj(body.generationConfig) ? body.generationConfig : {};
  if (typeof g.temperature === 'number') out.temperature = g.temperature;
  if (typeof g.topP === 'number') out.top_p = g.topP;
  if (typeof g.maxOutputTokens === 'number') out.max_tokens = g.maxOutputTokens;
  if (Array.isArray(g.stopSequences) && g.stopSequences.length) out.stop = g.stopSequences;
  if (typeof g.seed === 'number') out.seed = g.seed;
  if (g.responseMimeType === 'application/json') out.response_format = { type: 'json_object' };
  if (Array.isArray(body.tools)) {
    const tools = (body.tools as unknown[]).flatMap((t) => (isObj(t) && Array.isArray(t.functionDeclarations) ? (t.functionDeclarations as Json[]) : []))
      .filter((f) => typeof f.name === 'string')
      .map((f) => ({ type: 'function', function: { name: f.name, ...(f.description ? { description: f.description } : {}), parameters: f.parameters ?? { type: 'object', properties: {} } } }));
    if (tools.length) out.tools = tools;
  }
  if (stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

const gFinish = (r: string | null) => (r === 'length' ? 'MAX_TOKENS' : r === 'content_filter' ? 'SAFETY' : 'STOP');
const gUsage = (u: unknown): Json => {
  const x = isObj(u) ? u : {};
  const p = typeof x.prompt_tokens === 'number' ? x.prompt_tokens : 0;
  const c = typeof x.completion_tokens === 'number' ? x.completion_tokens : 0;
  return { promptTokenCount: p, candidatesTokenCount: c, totalTokenCount: typeof x.total_tokens === 'number' ? x.total_tokens : p + c };
};
const parseArgs = (s: unknown): unknown => {
  try {
    return JSON.parse(String(s || '{}'));
  } catch {
    return {};
  }
};

function geminiFromChat(chat: Json, model: string): Json {
  const choice = (Array.isArray(chat.choices) ? chat.choices[0] : undefined) as Json | undefined;
  const msg = (isObj(choice?.message) ? choice!.message : {}) as Json;
  const parts: Json[] = [];
  if (typeof msg.content === 'string' && msg.content) parts.push({ text: msg.content });
  for (const tc of Array.isArray(msg.tool_calls) ? (msg.tool_calls as Json[]) : []) {
    const fn = (tc.function ?? {}) as Json;
    parts.push({ functionCall: { name: String(fn.name ?? ''), args: parseArgs(fn.arguments) } });
  }
  if (parts.length === 0) parts.push({ text: '' });
  return { candidates: [{ content: { role: 'model', parts }, finishReason: gFinish(finishOf(choice?.finish_reason)), index: 0 }], usageMetadata: gUsage(chat.usage), modelVersion: model };
}

function geminiStream(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  let usage: unknown;
  let reason: string | null = null;
  const calls = new Map<number, { name: string; args: string }>();
  let finished = false;
  const chunk = (parts: Json[], fin?: string) => dataLine({ candidates: [{ content: { role: 'model', parts }, ...(fin ? { finishReason: fin } : {}), index: 0 }], ...(fin ? { usageMetadata: gUsage(usage) } : {}), modelVersion: model });
  const finish = (out: string[]) => {
    if (finished) return;
    finished = true;
    const parts: Json[] = [...calls.values()].map((c) => ({ functionCall: { name: c.name, args: parseArgs(c.args) } }));
    out.push(chunk(parts.length ? parts : [{ text: '' }], gFinish(reason)));
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
        out.push(dataLine({ error: { code: 500, message: String((c.error as Json).message ?? 'upstream error'), status: 'INTERNAL' } }));
        finished = true;
        return;
      }
      if (isObj(c.usage)) usage = c.usage;
      const choice = (Array.isArray(c.choices) ? c.choices[0] : undefined) as Json | undefined;
      const delta = (isObj(choice?.delta) ? choice!.delta : {}) as Json;
      if (typeof delta.content === 'string' && delta.content) out.push(chunk([{ text: delta.content }]));
      for (const tc of Array.isArray(delta.tool_calls) ? (delta.tool_calls as Json[]) : []) {
        const k = typeof tc.index === 'number' ? tc.index : 0;
        const fn = (tc.function ?? {}) as Json;
        const cur = calls.get(k) ?? { name: '', args: '' };
        if (typeof fn.name === 'string') cur.name = fn.name;
        if (typeof fn.arguments === 'string') cur.args += fn.arguments;
        calls.set(k, cur);
      }
      reason = finishOf(choice?.finish_reason) ?? reason;
    },
    finish,
    (out) => out.push(dataLine({ error: { code: 500, message: 'upstream stream failed', status: 'INTERNAL' } })),
  );
}

export const wrapGemini = (res: Response, model: string, stream: boolean): Promise<Response> =>
  stream ? translate(res, () => ({}), (s) => geminiStream(s, model)) : translate(res, (b) => geminiFromChat(b, model), (s) => geminiStream(s, model));

export function geminiError(status: number, message: string): Response {
  const s = status === 400 ? 'INVALID_ARGUMENT' : status === 401 || status === 403 ? 'UNAUTHENTICATED' : status === 404 ? 'NOT_FOUND' : status === 429 ? 'RESOURCE_EXHAUSTED' : status === 503 ? 'UNAVAILABLE' : 'INTERNAL';
  return Response.json({ error: { code: status, message, status: s } }, { status });
}

/** Re-shapes an OpenAI-style error response into Gemini's error format. */
export async function wrapGeminiError(res: Response): Promise<Response> {
  if (res.ok) return res;
  const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return geminiError(res.status, j?.error?.message ?? res.statusText ?? 'request failed');
}

export function geminiModelEntry(id: string): Json {
  return { name: `models/${id}`, version: '1', displayName: id, description: 'Served by PourGateLLM', inputTokenLimit: 1048576, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent', 'countTokens'] };
}

/** Rough token estimate (about 4 characters per token) for countTokens. */
export const estimateTokens = (body: Json): number => Math.max(1, Math.ceil(JSON.stringify(body.contents ?? body.generateContentRequest ?? '').length / 4));

// ---------------------------------------------------------------------------
// Ollama

export function ollamaChatToChat(body: Json, generate: boolean): Json {
  const model = typeof body.model === 'string' ? body.model : '';
  if (!model) throw new NativeBadRequest('model is required');
  let messages: Json[];
  if (generate) {
    if (typeof body.prompt !== 'string') throw new NativeBadRequest('prompt is required');
    messages = [...(typeof body.system === 'string' && body.system ? [{ role: 'system', content: body.system }] : []), { role: 'user', content: body.prompt }];
  } else {
    if (!Array.isArray(body.messages) || body.messages.length === 0) throw new NativeBadRequest('messages is required');
    messages = (body.messages as unknown[]).filter(isObj).map((m) => {
      const imgs = Array.isArray(m.images) ? (m.images as unknown[]).filter((i): i is string => typeof i === 'string') : [];
      const content = imgs.length ? [{ type: 'text', text: String(m.content ?? '') }, ...imgs.map((i) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${i}` } }))] : String(m.content ?? '');
      return { role: m.role === 'assistant' || m.role === 'system' || m.role === 'tool' ? m.role : 'user', content };
    });
  }
  const out: Json = { model, messages };
  const o = isObj(body.options) ? body.options : {};
  if (typeof o.temperature === 'number') out.temperature = o.temperature;
  if (typeof o.top_p === 'number') out.top_p = o.top_p;
  if (typeof o.num_predict === 'number' && o.num_predict > 0) out.max_tokens = o.num_predict;
  if (typeof o.seed === 'number') out.seed = o.seed;
  if (o.stop !== undefined) out.stop = o.stop;
  if (body.format === 'json') out.response_format = { type: 'json_object' };
  if (Array.isArray(body.tools)) out.tools = body.tools;
  if (body.stream !== false) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

const oUsage = (u: unknown): Json => {
  const x = isObj(u) ? u : {};
  return { total_duration: 0, load_duration: 0, prompt_eval_count: typeof x.prompt_tokens === 'number' ? x.prompt_tokens : 0, eval_count: typeof x.completion_tokens === 'number' ? x.completion_tokens : 0 };
};
const nd = (v: unknown) => `${JSON.stringify(v)}\n`;
const oShape = (model: string, generate: boolean, text: string, done: boolean, extra: Json = {}): Json => ({
  model,
  created_at: new Date().toISOString(),
  ...(generate ? { response: text } : { message: { role: 'assistant', content: text } }),
  done,
  ...extra,
});

function ollamaFromChat(chat: Json, model: string, generate: boolean): Json {
  const choice = (Array.isArray(chat.choices) ? chat.choices[0] : undefined) as Json | undefined;
  const msg = (isObj(choice?.message) ? choice!.message : {}) as Json;
  const text = typeof msg.content === 'string' ? msg.content : '';
  const base = oShape(model, generate, text, true, { done_reason: finishOf(choice?.finish_reason) === 'length' ? 'length' : 'stop', ...oUsage(chat.usage) });
  if (!generate && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    (base.message as Json).tool_calls = (msg.tool_calls as Json[]).map((tc) => ({ function: { name: String(((tc.function ?? {}) as Json).name ?? ''), arguments: parseArgs(((tc.function ?? {}) as Json).arguments) } }));
  }
  return base;
}

function ollamaStream(upstream: ReadableStream<Uint8Array>, model: string, generate: boolean): ReadableStream<Uint8Array> {
  let usage: unknown;
  let reason: string | null = null;
  let finished = false;
  const finish = (out: string[]) => {
    if (finished) return;
    finished = true;
    out.push(nd(oShape(model, generate, '', true, { done_reason: reason === 'length' ? 'length' : 'stop', ...oUsage(usage) })));
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
        out.push(nd({ error: String((c.error as Json).message ?? 'upstream error') }));
        finished = true;
        return;
      }
      if (isObj(c.usage)) usage = c.usage;
      const choice = (Array.isArray(c.choices) ? c.choices[0] : undefined) as Json | undefined;
      const delta = (isObj(choice?.delta) ? choice!.delta : {}) as Json;
      if (typeof delta.content === 'string' && delta.content) out.push(nd(oShape(model, generate, delta.content, false)));
      reason = finishOf(choice?.finish_reason) ?? reason;
    },
    finish,
    (out) => out.push(nd({ error: 'upstream stream failed' })),
  );
}

export async function wrapOllama(res: Response, model: string, generate: boolean, stream: boolean): Promise<Response> {
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return Response.json({ error: j?.error?.message ?? res.statusText ?? 'request failed' }, { status: res.status });
  }
  const out = await translate(res, (b) => ollamaFromChat(b, model, generate), (s) => ollamaStream(s, model, generate));
  if (stream && out.body) out.headers.set('content-type', 'application/x-ndjson');
  return out;
}

export const ollamaTag = (id: string): Json => ({ name: id, model: id, modified_at: new Date(0).toISOString(), size: 0, digest: rid('sha').slice(0, 16), details: { format: 'gguf', family: 'remote', families: ['remote'], parameter_size: 'n/a', quantization_level: 'n/a' } });
