# PourGateLLM

Self-hosted gateway that unifies free-tier LLM providers behind one OpenAI-compatible API.
See [DESIGN.md](DESIGN.md) for the vision, architecture and roadmap.

## Status

MVP scaffold: `GET /v1/models` and `POST /v1/chat/completions` (streaming passthrough),
per-key rotation with cooldown and RPM limiting, per-client tokens with RPM/daily quotas and usage persisted in SQLite, failover across keys/models, and a
registry of providers in [`registry/`](registry). Providers in the registry: Groq, Gemini, Cerebras, Mistral, OpenRouter (model ids and limits are unverified except where noted).

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

## Docker

```bash
cp .env.example .env   # set a strong POURGATE_TOKENS and your provider keys
docker compose up -d --build
docker compose exec pourgate node dist/cli.js tokens create --name laptop --rpm 30
```

The SQLite database lives in the `pourgate-data` volume. Change the host port with `PORT` in `.env`.
Never keep the placeholder `POURGATE_TOKENS=pg-change-me`.

## Client tokens

Create per-client tokens with quotas (stored hashed in SQLite, default `data/pourgate.db`, override with `POURGATE_DB`):

```bash
pnpm --filter @pourgate/server cli tokens create --name laptop --rpm 30 --daily 500 --expires-days 90
pnpm --filter @pourgate/server cli tokens list
pnpm --filter @pourgate/server cli tokens revoke 1
```

`POURGATE_TOKENS` remains available as static, unlimited bootstrap tokens. Requires Node >= 22.13 (built-in `node:sqlite`).

## Development

```bash
pnpm typecheck && pnpm test
```

## License

MIT
