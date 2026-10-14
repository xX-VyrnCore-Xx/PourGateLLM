import type { Capability, Tier } from '@pourgate/shared';

export type Complexity = 'easy' | 'medium' | 'hard';

export interface Needs {
  tools: boolean;
  json: boolean;
  vision: boolean;
}

export interface Analysis {
  complexity: Complexity;
  score: number;
  reasons: string[];
  /** Rough prompt size (chars / 4); good enough to skip models whose context window is too small. */
  promptTokens: number;
  needs: Needs;
}

/** Which tier to try first for each complexity; the other tiers remain as fallbacks. */
export const TIER_ORDER: Record<Tier, Tier[]> = {
  small: ['small', 'medium', 'large'],
  medium: ['medium', 'large', 'small'],
  large: ['large', 'medium', 'small'],
};

export const COMPLEXITY_TIER: Record<Complexity, Tier> = { easy: 'small', medium: 'medium', hard: 'large' };

const HARD_WORDS =
  /\b(prove|proof|derive|step[- ]by[- ]step|reason(?:ing)?|analy[sz]e|architecture|refactor|debug|optimi[sz]e|algorithm|complexity|trade-?offs?|compare|design|implement|dimostra|ragiona|passo passo|analizza|architettura|ottimizza|algoritmo|complessit[àa]|progetta|confronta|implementa)\b/gi;
const MATH_WORDS =
  /\b(solve|equation|integral|derivative|theorem|probability|matrix|risolvi|equazione|integrale|derivata|teorema|probabilit[àa]|matrice)\b|[∫∑∏√≈≠≤≥]/i;
const EASY_WORDS =
  /^(?:hi|hello|hey|ciao|salve|thanks|grazie)\b|\b(translate|traduci|define|definisci|what is|what's|who is|chi [èe]|cos[’']?[èe]|capital of|capitale di|spell|synonym|sinonimo)\b/i;
const CODE_HINT = /```|\b(def |function |class |import |const |let |#include|SELECT .* FROM)\b/;

type Part = { type?: string; text?: unknown };
type Message = { role?: unknown; content?: unknown };

function textOf(content: unknown): { text: string; hasImage: boolean } {
  if (typeof content === 'string') return { text: content, hasImage: false };
  if (!Array.isArray(content)) return { text: '', hasImage: false };
  let text = '';
  let hasImage = false;
  for (const part of content as Part[]) {
    if (part?.type === 'text' && typeof part.text === 'string') text += `${part.text}\n`;
    else if (part?.type === 'image_url' || part?.type === 'image') hasImage = true;
  }
  return { text, hasImage };
}

/**
 * Cheap, deterministic prompt classifier. It spends no provider quota: a handful of signals
 * (size, code, reasoning/math wording, tools, structured output, history depth) are summed into a score.
 */
export function analyzePrompt(body: Record<string, unknown>): Analysis {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as Message[];
  let totalChars = 0;
  let hasImage = false;
  let lastUser = '';
  for (const m of messages) {
    const { text, hasImage: img } = textOf(m?.content);
    totalChars += text.length;
    hasImage ||= img;
    if (m?.role === 'user') lastUser = text;
  }
  const promptTokens = Math.ceil(totalChars / 4);

  const rf = body.response_format as { type?: unknown } | undefined;
  const needs: Needs = {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    json: rf?.type === 'json_object' || rf?.type === 'json_schema',
    vision: hasImage,
  };

  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, why: string) => {
    score += points;
    reasons.push(`${points >= 0 ? '+' : ''}${points} ${why}`);
  };

  if (promptTokens > 6000) add(3, 'very long prompt');
  else if (promptTokens > 1500) add(2, 'long prompt');
  else if (promptTokens > 200) add(1, 'medium-size prompt');
  if (lastUser.length > 1200) add(1, 'long last message');
  if (CODE_HINT.test(lastUser)) add(1, 'contains code');
  const hardHits = lastUser.match(HARD_WORDS)?.length ?? 0;
  if (hardHits >= 3) add(4, 'several reasoning/engineering terms');
  else if (hardHits === 2) add(2, 'reasoning/engineering terms');
  else if (hardHits === 1) add(1, 'reasoning/engineering term');
  if (MATH_WORDS.test(lastUser)) add(1, 'math');
  if (messages.length > 8) add(1, 'long conversation');
  if (needs.tools) add(1, 'tool use');
  if (rf?.type === 'json_schema') add(1, 'strict structured output');
  const maxOut = Number(body.max_completion_tokens ?? body.max_tokens ?? 0);
  if (maxOut > 2000) add(1, 'large output requested');
  if (body.reasoning_effort === 'high' || body.reasoning_effort === 'medium') add(2, 'reasoning effort requested');
  if (lastUser.length < 200 && EASY_WORDS.test(lastUser)) add(-1, 'short simple question');

  score = Math.max(0, score);
  const complexity: Complexity = score >= 4 ? 'hard' : score >= 2 ? 'medium' : 'easy';
  return { complexity, score, reasons, promptTokens, needs };
}

/** Capabilities a model must declare to serve a request with these needs. */
export function requiredCapabilities(needs: Needs): Capability[] {
  const caps: Capability[] = ['chat'];
  if (needs.tools) caps.push('tools');
  if (needs.json) caps.push('json_mode');
  if (needs.vision) caps.push('vision');
  return caps;
}
