# PourGateLLM

Self-hosted gateway that unifies free-tier LLM providers behind one OpenAI-compatible API.
See [DESIGN.md](DESIGN.md) for the vision, architecture and roadmap.

## Status

MVP scaffold: `GET /v1/models` and `POST /v1/chat/completions` (streaming passthrough),
per-key rotation with cooldown and RPM limiting, failover across keys/models, and a
registry of providers in [`registry/`](registry). Only Groq is wired up so far.

## Quick start

```bash
pnpm install
cp .env.example .env   # set POURGATE_TOKENS and GROQ_API_KEYS
pnpm build
POURGATE_TOKENS=pg-secret GROQ_API_KEYS=gsk_... pnpm --filter @pourgate/server start

curl localhost:3000/v1/chat/completions \
  -H 'Authorization: Bearer pg-secret' -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

Use `"model": "auto"` to let the gateway pick any available model, or a specific model id.

## Development

```bash
pnpm typecheck && pnpm test
```

## License

MIT
