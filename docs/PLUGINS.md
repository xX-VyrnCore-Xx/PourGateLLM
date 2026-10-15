# Plugins

Plugins extend PourGateLLM without forking it. A plugin is a JavaScript ES module dropped into the plugins directory
(`./plugins`, or `POURGATE_PLUGINS_DIR`). Each `*.mjs` / `*.js` file is loaded at startup, in file-name order.

> [!WARNING]
> Plugins run **in the gateway process with its full privileges** (they can read provider keys from memory and the
> environment). Install only code you have read and trust. Plugins are loaded from a local directory only, never from
> the registry or the network.

## What a plugin can do

```js
// plugins/my-plugin.mjs
export default {
  name: 'my-plugin',                      // required, [a-z0-9-]+, unique

  init({ log }) {},                       // optional, once at startup (may be async)

  // Optional: inspect, rewrite or reject a request before routing.
  onRequest({ endpoint, body, clientId, headers }) {
    // endpoint: 'chat' | 'embeddings' | 'transcription' | 'speech' | 'images'
    // body is OpenAI format (Anthropic requests are translated first); for 'transcription' it holds the text fields
    // only (never the audio) and rewrites are ignored, but rejecting works
    // clientId: token id, or null for static env tokens; headers never include credentials
    return { body: { ...body, temperature: 0 } };            // replace the body
    // return { reject: { status: 400, message: 'no' } };    // or reject
    // return;                                               // or leave it alone
  },

  // Optional: observe finished requests (metadata only, never prompts or completions).
  onResponse({ endpoint, requested, provider, model, status, totalMs, tokens, cache, clientId, error }) {},

  // Optional: teach the gateway to talk to providers that are not OpenAI-compatible.
  adapters: {
    'my-api': {
      buildRequest({ body, model, baseUrl, apiKey, stream }) {
        return { url: `${baseUrl}/generate`, init: { method: 'POST', headers: { /* ... */ }, body: JSON.stringify({ /* ... */ }) } };
      },
      async parseResponse(res, { model, stream }) {
        // return an OpenAI chat-completions Response (JSON, or SSE chunks when stream is true)
      },
    },
  },
};
```

### Behavior guarantees

| Hook | Runs | If it fails |
|---|---|---|
| `onRequest` | in plugin order, after authentication and client quotas, before the cache and routing | **Fails closed**: a throw or a timeout (5 s) answers `500 plugin_error`; `reject` answers with your status and `rejected_by_plugin` |
| `onResponse` | after the response finished (fire and forget) | Logged and ignored; can never slow down or break a request |
| adapter `buildRequest` / `parseResponse` | per upstream attempt | A throw is treated as an upstream failure: the key cools down and the next candidate is tried |

Adapters only serve **chat** (not embeddings). Failover, key rotation, limits and cooldowns work as usual: `429`/`5xx`
responses are handled by the gateway before `parseResponse` is called, and other error statuses are passed through
untouched. `parseResponse` is only called for successful responses.

## Using an adapter

Reference it from a registry file (or an [override](../README.md#️-the-open-registry)) with `adapter: <name>`:

```yaml
provider: my-provider
base_url: https://api.example.com
api_key_env: MY_PROVIDER_API_KEYS
adapter: my-api
models:
  - id: my-model
    capabilities: [chat]
```

A provider whose adapter is not installed is skipped (a warning is printed at startup). A signed registry bundle can
name an adapter, but it can only select adapters you installed yourself.

## Examples

[`examples/plugins/`](../examples/plugins) contains two working samples:

- [`block-words.mjs`](../examples/plugins/block-words.mjs): rejects prompts containing words listed in `POURGATE_BLOCK_WORDS`.
- [`json-api-adapter.mjs`](../examples/plugins/json-api-adapter.mjs): a template adapter for a hypothetical non-OpenAI API. Adapt it to a real provider's API before use; streaming is left to you.

With Docker, mount a directory: add `- ./plugins:/app/plugins:ro` under `volumes:` in `compose.yaml`.
