# Changelog

## Unreleased

- Dashboard: Overview tab (setup checklist, provider health, copy-paste connection snippets), light/dark/system theme switch, English/Italian language switch, "get a key" links.

- `pourgate setup` (interactive and `--provider/--key`), `pourgate service install|uninstall|status|print` (systemd user unit, launchd, Windows scheduled task), `pourgate update [--check]`; colored help and a friendlier startup banner. Registry entries may carry a `signup_url` hint. Uninstallers also remove the service.
- `pourgate doctor [--live] [--url]`: read-only diagnosis of an installation; `pnpm smoke`: end-to-end self-test with a fake provider (also in CI); `docs/TESTING.md`.
- Uninstallers: `pourgate uninstall [--purge] [--yes]` (`install/uninstall.sh`, `install/uninstall.ps1`) and `install/uninstall-docker.sh`; installers record what they installed (`install.json`) and report updates.
- Cache: coalescing of identical in-flight requests, stale-if-error (`POURGATE_CACHE_STALE_SECONDS`), byte cap (`POURGATE_CACHE_MAX_MB`), per-model clear, served-result counters.

- Provider keys: pause/resume and traffic weights (×1–×10) from the dashboard and `PATCH /admin/api/provider-keys/:id`.
- Routing: per-model circuit breaker (`POURGATE_BREAKER_THRESHOLD`) and upstream timeout (`POURGATE_UPSTREAM_TIMEOUT_MS`); circuit state shown in the dashboard.

- Desktop release workflow stamps the release version into the app so installer names match.

## 0.1.1

- Installers: `install/install.sh`, `install/install.ps1`, `install/install-docker.sh` and a `pourgate` launcher (`bin/pourgate.mjs`) shipped in the release tarball.
- Windows installer build (`desktop-release.yml`, experimental).

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
