import { analyzePrompt, requiredCapabilities } from './complexity.js';
import { rankCandidates, listCandidates, errorResponse, type Candidate, type RouterDeps } from './router.js';

/**
 * "Fusion": ask several different free models the same question in parallel, then have a judge model write one
 * answer from the drafts. Costs N+1 requests of free quota per call, so it is opt-in (`"model": "fusion"`).
 */
export const FUSION_MODEL = 'fusion';

type Json = Record<string, unknown>;
type Route = (deps: RouterDeps, body: Json, requested: string, signal?: AbortSignal) => Promise<Response>;

/** Distinct models for the panel: strongest tier first, at most one per provider, then per family. */
export function pickPanel(candidates: Candidate[], size: number): Candidate[] {
  const out: Candidate[] = [];
  const providers = new Set<string>();
  const families = new Set<string>();
  const take = (c: Candidate, uniqueProvider: boolean) => {
    const fam = c.model.family ?? c.model.id;
    if (out.includes(c) || (uniqueProvider && providers.has(c.provider.provider)) || families.has(fam)) return;
    out.push(c);
    providers.add(c.provider.provider);
    families.add(fam);
  };
  for (const c of candidates) if (out.length < size) take(c, true);
  for (const c of candidates) if (out.length < size) take(c, false);
  return out;
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p && typeof p === 'object' && typeof (p as Json).text === 'string' ? ((p as Json).text as string) : '')).filter(Boolean).join('\n') : '';

function judgeMessages(original: Json[], drafts: { text: string }[]): Json[] {
  const convo = original.map((m) => `${String(m.role).toUpperCase()}: ${textOf(m.content)}`).join('\n\n');
  const list = drafts.map((d, i) => `--- Draft ${i + 1} ---\n${d.text}`).join('\n\n');
  return [
    {
      role: 'system',
      content:
        'You combine several draft answers into one final answer. Keep what is correct and agreed on, resolve disagreements by reasoning about which draft is right, drop mistakes and repetition. ' +
        'Answer the conversation directly, in the same language as the user, and do not mention the drafts or that you were given any.',
    },
    { role: 'user', content: `CONVERSATION:\n${convo}\n\n${list}\n\nWrite the final answer.` },
  ];
}

interface Completion {
  text: string;
  usage: { prompt_tokens: number; completion_tokens: number };
  provider?: string;
  model?: string;
}

async function complete(route: Route, deps: RouterDeps, body: Json, model: string, signal?: AbortSignal): Promise<Completion | undefined> {
  try {
    const res = await route(deps, { ...body, model, stream: false, stream_options: undefined }, model, signal);
    if (!res.ok) {
      await res.body?.cancel();
      return undefined;
    }
    const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = textOf(json.choices?.[0]?.message?.content).trim();
    if (!text) return undefined;
    return {
      text,
      usage: { prompt_tokens: json.usage?.prompt_tokens ?? 0, completion_tokens: json.usage?.completion_tokens ?? 0 },
      provider: res.headers.get('x-pourgate-provider') ?? undefined,
      model: res.headers.get('x-pourgate-model') ?? undefined,
    };
  } catch {
    return undefined;
  }
}

function sseFrom(id: string, created: number, text: string, usage: Json): Response {
  const enc = new TextEncoder();
  const chunk = (delta: Json, finish: string | null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: FUSION_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const body = chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: FUSION_MODEL, choices: [], usage })}\n\ndata: [DONE]\n\n`;
  return new Response(enc.encode(body), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } });
}

export async function runFusion(deps: RouterDeps, body: Json, route: Route, panelSize: number, signal?: AbortSignal): Promise<Response> {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return errorResponse(400, 'The fusion model does not support tools: use a regular model or a profile for tool calling', 'invalid_request_error', 'fusion_no_tools');
  }
  const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
  const analysis = analyzePrompt(body);
  const ranked = rankCandidates(listCandidates(deps.registry, 'auto'), 'large', analysis, (c) => deps.pools.get(c.provider.provider)?.usageToday(c.model.id).requests ?? 0, deps.scoring, (c) =>
    deps.latency?.bucket(`${c.provider.provider}|${c.model.id}`) ?? 0,
  ).filter((c) => requiredCapabilities(analysis.needs).every((cap) => c.model.capabilities.includes(cap)));
  const panel = pickPanel(ranked, Math.max(1, Math.min(5, panelSize)));
  if (panel.length === 0) return errorResponse(503, 'No model is available for fusion', 'server_error', 'no_capacity');

  const drafts = (await Promise.all(panel.map((c) => complete(route, deps, body, c.model.id, signal)))).filter((d): d is Completion => d !== undefined);
  if (drafts.length === 0) return errorResponse(503, 'All providers are currently rate-limited or unavailable', 'server_error', 'no_capacity');

  let final = drafts[0]!;
  let judged = false;
  if (drafts.length > 1) {
    const verdict = await complete(route, deps, { ...body, messages: judgeMessages(messages, drafts), temperature: 0.2 }, 'auto:large', signal);
    if (verdict) {
      final = verdict;
      judged = true;
    }
  }
  const all = judged ? [...drafts, final] : drafts;
  const usage = {
    prompt_tokens: all.reduce((n, d) => n + d.usage.prompt_tokens, 0),
    completion_tokens: all.reduce((n, d) => n + d.usage.completion_tokens, 0),
    total_tokens: 0,
  };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

  const id = `chatcmpl-fusion-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    'x-pourgate-provider': 'fusion',
    'x-pourgate-model': FUSION_MODEL,
    'x-pourgate-fusion': `${drafts.length} drafts${judged ? ' + judge' : ''}`,
    'x-pourgate-fusion-panel': drafts.map((d) => d.model ?? '?').join(','),
  };
  const res = body.stream === true
    ? sseFrom(id, created, final.text, usage)
    : Response.json({ id, object: 'chat.completion', created, model: FUSION_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: final.text }, finish_reason: 'stop' }], usage });
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}
