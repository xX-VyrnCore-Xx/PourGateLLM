# Changelog

## Unreleased

- Security: gateway listens on 127.0.0.1 by default (`POURGATE_HOST`; **behaviour change** for anyone reaching it from another machine), strict CSP and security headers for the dashboard, failed-auth throttling on the API, dashboard passwords under 8 characters refused, hardened compose files (`no-new-privileges`, no capabilities, loopback port), release checksums verified by the installers and signed build-provenance attestations.
- Repository: Dependabot (npm daily, actions/docker/cargo weekly) with auto-merge for minor/patch, CodeQL, dependency review, least-privilege workflows, CODEOWNERS.
- Releases: older ones are pruned automatically, keeping the newest three (`.github/workflows/cleanup-releases.yml`).
- Dependencies: zod 4, @hono/node-server 2, react 19, vite 8, @vitejs/plugin-react 6, tailwind-merge 3, vitest 5 and tsup 9 (all tests, build and the browser smoke test pass). TypeScript 7 and @types/node 26 are deliberately left out (Node 22 is the supported runtime).
- Routing: within a tier, models are now ordered by quality score, then response speed (smoothed time-to-first-byte in coarse buckets, forgotten after 5 minutes, failures count as slow), then least used. The Providers page shows each model's latency and always links to the provider's key page.
- CI: `pnpm audit --prod --audit-level=high` on every run.
- Dashboard: add your own OpenAI-compatible endpoints (models auto-detected, stored in the database, hot-reloaded) and paste many keys at once.
- API: `fusion` virtual model: a panel of different models answers in parallel and a judge merges the drafts (`POURGATE_FUSION_PANEL`).
- Routing: named fallback chains (`profiles.yaml`, request `auto:<name>`) and sticky sessions (`x-pourgate-session` header keeps a conversation on the model that served it last, 30 min).
- API: `POST /v1/completions` (legacy text completion with `suffix`, streaming) and `POST /v1/responses` (Responses API for Codex CLI: text, images, function tools, JSON schema output, streaming events), both on top of the normal pipeline.
- Registry: `pourgate registry discover [--write]` builds registry files from the models providers themselves mark as free; shipped for OpenRouter, Kilo, Routeway, OrcaRouter, BazaarLink, Requesty and xKiro (107 models, limits learned at runtime). Up to 500 keys per provider (was 50). New `docs/FREELLMAPI-COMPARISON.md`.
- Registry: `pourgate registry check` compares every model id with the provider's live `/models` list (keys read from the usual `*_API_KEYS` variables; keyless providers are reported as `needs-key`), and a weekly workflow opens an issue when ids vanish.
- Dependabot no longer opens pull requests for major updates of any ecosystem (they are done by hand), so only short-lived minor/patch branches exist.
- Fix: Dependabot now starts from the repository root so `pnpm-lock.yaml` is updated with `package.json` (before, every npm update failed `--frozen-lockfile`); major npm bumps are ignored and done by hand.
- Registry: the OpenRouter free list was refreshed against the live `/models` endpoint (the previous only entry no longer existed).
- Windows app: ships its own Node.js runtime (no prerequisites), hides the gateway console, writes `gateway.log`, shows a welcome screen with the generated credentials (EN/IT), current-user installer with English/Italian installer languages.

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
