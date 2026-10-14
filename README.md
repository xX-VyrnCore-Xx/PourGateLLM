# PourGateLLM

Self-hosted gateway that unifies free-tier LLM providers behind one OpenAI-compatible API.
See [DESIGN.md](DESIGN.md) for the vision, architecture and roadmap.

## Status

MVP scaffold with an admin dashboard (React + Tailwind): `GET /v1/models` and `POST /v1/chat/completions` (streaming passthrough),
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

## Dashboard

Set `POURGATE_ADMIN_PASSWORD` and open `http://localhost:3000/` to manage client tokens and see provider/key status.
In development run `pnpm dev` (API on :3000) and `pnpm --filter @pourgate/client dev` (UI on :5173, proxies the API).
Outside Docker, point the server at the built UI with `POURGATE_STATIC_DIR=packages/client/dist`.
Serve it behind HTTPS in production and set `POURGATE_COOKIE_SECURE=true`.

## Limits and cooldowns

Registry limits are enforced per key *and* model: `rpm`/`tpm` over a sliding 60 s window (in memory, so they restart empty),
`rpd`/`tpd` as UTC-day counters and key cooldowns (after 429/5xx, honoring `Retry-After` up to 24 h) persisted in SQLite,
so they survive restarts. Keys are tracked by an HMAC fingerprint; raw keys are never written to usage tables.

- Token limits (`tpm`/`tpd`) use the `usage.total_tokens` reported by the provider on **non-streaming** responses; streamed responses count as requests only.
- Counters older than 7 days are pruned automatically.

## Provider keys

Keys can come from environment variables (`GROQ_API_KEYS=k1,k2`) and/or be added in the dashboard (Providers tab: add, test, remove).
Dashboard keys are stored in SQLite encrypted with AES-256-GCM (bound to the provider name); the dashboard only ever shows the last 4 characters.
The master key comes from `POURGATE_MASTER_KEY` (64 hex chars or base64 of 32 bytes; generate with `openssl rand -hex 32`),
or, if unset, from `data/master.key`, created on first start with mode 0600.

- Back the master key up: without it stored keys cannot be decrypted (they are skipped with a warning, never crash the server).
- Keeping the key file in the same volume as the database only protects against leaks of the database file alone; set `POURGATE_MASTER_KEY` to keep them apart.
- "Test" calls `GET {base_url}/models` with the key and reports only the HTTP status.

## Registry sync

The provider/model catalog in [`registry/`](registry) is open (PRs welcome). A gateway can follow a published bundle:

```bash
# publisher: build (and optionally sign) a bundle, then host registry.json and registry.json.sig anywhere over https
pnpm --filter @pourgate/server cli registry keygen --out-dir keys
pnpm --filter @pourgate/server cli registry bundle --out dist/registry.json --sign keys/registry-private.pem

# gateway
POURGATE_REGISTRY_URL=https://example.com/registry.json
POURGATE_REGISTRY_PUBKEY=./registry-public.pem     # optional but recommended
```

Trust model, because registry entries decide where your API keys are sent:

- **Unsigned** (no public key): the remote bundle may only update models, limits and quirks of providers already shipped locally. Endpoints and key variables are never taken from it, and new providers are ignored.
- **Signed** (public key set): the Ed25519 signature must verify. New providers are accepted, but endpoints must be public `https` URLs and the key variable must end in `_API_KEYS`.
- Older versions than the current one are rejected, size is capped at 2 MB, and the last accepted bundle is cached (and re-verified) in `data/registry-cache.json`.
- Local overrides in `POURGATE_OVERRIDES_DIR` (same YAML format) always win; models merge by id.

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
