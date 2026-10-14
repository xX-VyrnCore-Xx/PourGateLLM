// Template adapter for a provider that is NOT OpenAI-compatible.
//
// It targets a *hypothetical* API:  POST {baseUrl}/generate  {"model", "prompt"}  ->  {"text", "tokens"}
// Copy it, change buildRequest()/parseResponse() to match your provider's real API, then reference it in a
// registry file (registry or overrides) with `adapter: json-api`.
//
// Streaming is not implemented here: for a real provider, return an SSE Response in OpenAI chunk format
// from parseResponse() when `ctx.stream` is true.
export default {
  name: 'json-api',
  adapters: {
    'json-api': {
      buildRequest({ body, model, baseUrl, apiKey }) {
        const prompt = (body.messages ?? []).map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n');
        return {
          url: `${baseUrl.replace(/\/$/, '')}/generate`,
          init: {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, prompt, max_tokens: body.max_tokens }),
          },
        };
      },
      async parseResponse(res, { model }) {
        const data = await res.json();
        return Response.json({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: data.text ?? '' }, finish_reason: 'stop' }],
          usage: { total_tokens: data.tokens ?? 0 },
        });
      },
    },
  },
};
