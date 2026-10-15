# Changelog

## Unreleased

- Database: tuned pragmas, periodic optimize, graceful shutdown, `cli db stats|check|optimize|backup`, automatic pre-migration backup.
- Release workflow can be started manually (`workflow_dispatch`) and creates the tag itself.
- Dashboard playground (admin-only, streamed token by token) showing the route chosen for each prompt.
- Admin audit log (API `GET /admin/api/audit` and dashboard tab).
- Experimental Tauri desktop scaffold.

## 0.1.0

First public release.

- OpenAI-compatible gateway: chat (streaming, tools), models, embeddings, audio, images; Anthropic Messages translation.
- Key pools with per-key rate limits, persisted cooldowns, failover and learning from `x-ratelimit-*` headers.
- Prompt-complexity routing (`auto`, `auto:small|medium|large`) and eval-based strategies.
- Per-client tokens with quotas, encrypted provider keys, admin dashboard (EN/IT).
- Open model registry with optional Ed25519-signed sync.
- Exact and semantic response cache, PII masking and provider privacy policy.
- Prometheus metrics, OpenTelemetry tracing, JSONL export, plugin system.
