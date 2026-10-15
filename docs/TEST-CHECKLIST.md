# Test checklist

Everything worth checking before you rely on PourGateLLM, in the order you would naturally do it.
**A** = already covered by `pnpm test` / `pnpm smoke` (re-run, nothing to do by hand), **M** = manual.
How to run the tools: see [TESTING.md](TESTING.md).

## 0. Automated (run first)

- [ ] **A** `pnpm install && pnpm typecheck && pnpm test` — all green (250+ tests).
- [ ] **A** `pnpm build && pnpm smoke` — 13 `✓` and "All checks passed."
- [ ] **A** CI on `main` is green (CI workflow; Release and Desktop workflows for releases).

## 1. Installation (one section per way you installed)

### Linux / macOS CLI
- [ ] **M** `curl … install.sh | sh` finishes, prints where it installed and how to uninstall.
- [ ] **M** `pourgate version` prints the release number; `pourgate help` is readable.
- [ ] **M** First `pourgate start` creates `~/.pourgate/config.env` (mode 600) and prints a dashboard password and token once.
- [ ] **M** Re-running the installer says "Updating from …" and keeps `config.env` and `data/`.
- [ ] **M** Node older than 22.13 → the installer stops with a clear message.

### Windows CLI
- [ ] **M** `irm … install.ps1 | iex` finishes; a **new** terminal finds `pourgate`.
- [ ] **M** `pourgate start` works; the dashboard opens at `http://localhost:3000`.
- [ ] **M** Re-running keeps config and data; `pourgate version` shows the new version.

### Docker
- [ ] **M** `install-docker.sh` creates `./pourgate/{docker-compose.yml,.env}`, starts the container, prints credentials.
- [ ] **M** `docker compose ps` shows it healthy; `curl localhost:3000/health` → 200.
- [ ] **M** `docker compose down && docker compose up -d` keeps your data (tokens, keys) — the volume persists.
- [ ] **M** Image pulls without login (`docker pull ghcr.io/xx-vyrncore-xx/pourgatellm:latest`).

### Windows app
- [ ] **M** Run the `.exe` (or `.msi`) on a PC **without Node installed**; SmartScreen warning appears (unsigned) → *More info → Run anyway*.
- [ ] **M** Installer offers English/Italian and installs without asking for admin rights.
- [ ] **M** First launch shows the welcome screen with password and token; **Copy** buttons work; **Open the dashboard** logs in with that password.
- [ ] **M** No console window flashes; closing the app stops the gateway (port 43117 closes).
- [ ] **M** Second launch goes straight to the dashboard (no welcome screen).
- [ ] **M** `…\dev.pourgatellm.desktop\gateway.log` exists and contains the startup lines.
- [ ] **M** Uninstall from *Settings → Apps*; the app disappears from the Start menu.

## 2. First-run setup

- [ ] **M** `pourgate setup`: key input is hidden, links to get keys are shown, a bad key ("has space") is refused, Enter skips a provider.
- [ ] **M** `pourgate setup --provider groq --key gsk_…` appends the key; `config.env` is still mode 600 and comments are intact.
- [ ] **M** `pourgate doctor` → no `✗`; warnings only for providers without keys.
- [ ] **M** `pourgate doctor --live` → each real key says "key accepted"; a deliberately wrong key says "rejected".
- [ ] **M** Dashboard **Overview**: checklist ticks "Add a key" after the key is added and the gateway restarted.
- [ ] **M** `pourgate update --check` reports the version state correctly; `pourgate update` upgrades and keeps data.

## 3. Operation

- [ ] **M** `pourgate service install` → gateway starts by itself; `pourgate service status` says running.
- [ ] **M** Kill the process → it comes back within ~10 s (Linux/macOS).
- [ ] **M** Reboot / log out and in → it is running again (Linux: with `loginctl enable-linger`).
- [ ] **M** `pourgate service uninstall` stops it and removes the unit/task.
- [ ] **M** Logs: Linux `journalctl --user -u pourgatellm`, macOS/Windows `~/.pourgate/pourgate.log`.

## 4. API (with a real key, or the fake provider from `pnpm smoke`)

- [ ] **A/M** No token → 401; wrong token → 401; valid token → 200.
- [ ] **M** `GET /v1/models` lists registry models plus `auto`, `auto:small|medium|large`.
- [ ] **M** `POST /v1/chat/completions` with a real model id → answer + `x-pourgate-provider/model` headers.
- [ ] **M** Same with `"stream": true` → tokens arrive progressively; the last event is `[DONE]`.
- [ ] **M** Tool calling: send `tools` to a model with the `tools` capability → `tool_calls` come back.
- [ ] **M** JSON mode: `response_format: {"type":"json_object"}` → valid JSON.
- [ ] **M** `POST /v1/embeddings` (needs an embedding model with a key) → vector returned.
- [ ] **M** `POST /v1/audio/transcriptions` with a small audio file → text; `/v1/audio/speech` → audio bytes; `/v1/images/generations` (if a provider supports it).
- [ ] **M** Official OpenAI SDK (Python or Node) works with only `base_url` + `api_key` changed.
- [ ] **M** Anthropic SDK pointed at the gateway (`/v1/messages`, `x-api-key`) → answer; streaming too; `/v1/messages/count_tokens` → a number.
- [ ] **M** Unknown model → 404 `model_not_found`; a body over the limit → 413.

## 5. Routing and resilience

- [ ] **A/M** `auto` with `"hi"` → tier `small`; with a long engineering question → tier `large` (`x-pourgate-tier`, `x-pourgate-complexity`).
- [ ] **M** `auto:large` forces the large tier first; a prompt needing `tools`/`vision` only goes to capable models.
- [ ] **A/M** Failover: a key at its rate limit is skipped and the next one answers; the limited key rests (no repeated hits).
- [ ] **A/M** Two providers, one with a bad key/address → requests still succeed through the other.
- [ ] **A/M** Circuit breaker: after repeated failures the Providers tab shows `circuit open`; it recovers after the pause.
- [ ] **A/M** Upstream timeout: a provider that never answers fails over after `POURGATE_UPSTREAM_TIMEOUT_MS`.
- [ ] **M** Restart the gateway: counters and cooldowns persist (a key that was resting is still resting).
- [ ] **M** `POURGATE_ROUTING_STRATEGY=quality|speed|balanced` after running evals changes the order inside a tier.
- [ ] **M** Evals: *Run evals* in Providers → scores appear; they cost a little free quota, so try with one provider.

## 6. Keys

- [ ] **A/M** Add a key in the dashboard → it shows `••••last4` only; it is never returned by any API response.
- [ ] **A/M** Test button → "works" for a valid key, "failed (401)" for an invalid one.
- [ ] **A/M** Pause a key → it stops being used immediately; resume → it is used again.
- [ ] **A/M** Weight ×3 vs ×1 → roughly 3:1 traffic split over many requests (check usage per key).
- [ ] **M** Multiple keys via `GROQ_API_KEYS=a,b,c` rotate; removing the dashboard key leaves env keys alone.
- [ ] **M** Wrong/missing master key with stored keys → clear error in the log, keys skipped (not a crash).

## 7. Client tokens and quotas

- [ ] **A/M** Create a token with rpm limit → exceeding it returns 429 with a reset hint; others are unaffected.
- [ ] **A/M** Daily request limit and expiry are enforced; a revoked token fails immediately.
- [ ] **M** The full token is shown once at creation and never again; list shows only a prefix.
- [ ] **M** Usage today per token matches what you sent.

## 8. Cache

- [ ] **A/M** `POURGATE_CACHE_TTL_SECONDS=60`, same request with `temperature: 0` twice → second has `x-pourgate-cache: hit`, no provider call.
- [ ] **A/M** `Cache-Control: no-cache` or `x-pourgate-cache: bypass` skips the cache.
- [ ] **A/M** A different token never gets another token's cached answer.
- [ ] **A/M** 5 identical simultaneous requests → 1 provider call (`coalesced`).
- [ ] **A/M** With `POURGATE_CACHE_STALE_SECONDS`, expired answer is served (`stale`) only while every provider is down.
- [ ] **M** Semantic cache (`POURGATE_SEMANTIC_CACHE=on`, needs an embedding model): a reworded question → `x-pourgate-cache: semantic`.
- [ ] **M** Analytics → *Clear cache* works; `DELETE /admin/api/cache?model=…` clears one model.

## 9. Privacy

- [ ] **A/M** `POURGATE_PII_MODE=mask`: send an email/phone/IBAN → the provider receives placeholders (check with the fake provider), response header `x-pourgate-redacted: N`.
- [ ] **A/M** `POURGATE_PRIVACY_POLICY=no-training` → providers that train on prompts are never used; asking for them gives a clear 400.
- [ ] **M** Request log stores metadata only: open the SQLite file or `/admin/api/requests` and confirm no prompt/answer text.

## 10. Registry

- [ ] **M** `registry/` entries load (`pourgate doctor` shows counts); an invalid YAML → clear error naming the file.
- [ ] **A/M** Override a model's limits in `overrides/` → the change appears in Providers after restart.
- [ ] **A/M** Registry sync (`POURGATE_REGISTRY_URL`): unsigned bundle can't add providers or change endpoints; signed bundle with the right key can.
- [ ] **M** Providers tab "unverified" tags and "registry may be stale" drift markers appear when a provider reports different limits.
- [ ] **M** **Verify the shipped ids and limits** against each provider's docs (they are not verified) and open a PR for corrections.

## 11. Dashboard

- [ ] **A/M** Login: wrong password → error; 11 attempts in a minute → "too many attempts".
- [ ] **M** Overview: stats, checklist, providers health, copy snippets (curl/Python/Node) work with your own URL.
- [ ] **M** Tokens, Providers (keys, weights, pause, test, circuit state), Analytics (charts, ranges, JSONL export), Audit log (logins, token/key changes), Playground (streaming, route badges).
- [ ] **M** Theme: System/Light/Dark and EN/IT switch instantly and are remembered after reload.
- [ ] **M** Phone-sized window (≈390 px): nothing overflows horizontally, tabs reachable.
- [ ] **M** Keyboard only: tab order sensible, focus visible, forms submit with Enter.

## 12. Observability

- [ ] **A/M** `/metrics` needs `POURGATE_METRICS_TOKEN`; Prometheus can scrape it (`pourgate_requests_total`, cache results…).
- [ ] **M** Analytics numbers match `/admin/api/requests.jsonl`.
- [ ] **M** OpenTelemetry: set `OTEL_EXPORTER_OTLP_ENDPOINT` to a collector (e.g. Jaeger) → one trace per request with one child span per upstream attempt; `traceparent` is honoured.

## 13. Plugins

- [ ] **M** Drop `examples/plugins/block-words.mjs` into `plugins/` → a request with a blocked word is rejected; others pass.
- [ ] **M** `json-api-adapter.mjs` with a provider that declares `adapter:` → requests reach the non-OpenAI API.
- [ ] **A/M** A crashing plugin hook never takes the gateway down (`onRequest` fails closed, `onResponse` is ignored).

## 14. Security

- [ ] **A/M** Cross-origin `POST` to `/admin/api/*` with a foreign `Origin` → 403.
- [ ] **M** Session cookie is `HttpOnly; SameSite=Strict` (and `Secure` behind HTTPS with `POURGATE_COOKIE_SECURE=true`).
- [ ] **M** Provider keys never appear in logs, API responses, backups (encrypted) or the audit log.
- [ ] **M** `config.env` and `master.key` are mode 600 (Linux/macOS); doctor warns otherwise.
- [ ] **M** Put the gateway behind HTTPS (reverse proxy) before exposing it beyond localhost; note the audit log then shows the proxy's IP.

## 15. Data and upgrades

- [ ] **A/M** `pourgate db check` → ok; `db stats` shows sensible counts.
- [ ] **A/M** `pourgate db backup --out b.db` creates a 600 file and refuses to overwrite.
- [ ] **M** Restore test: stop the gateway, replace `pourgate.db` with the backup, start → tokens and keys are back (needs the same master key).
- [ ] **M** Upgrade from an older version: a `pourgate.db.pre-vN.bak` is created automatically before the schema changes.
- [ ] **M** Stop with Ctrl+C / `docker stop` → clean shutdown (no `-wal` file left over).

## 16. Uninstall

- [ ] **M** `pourgate uninstall` while the server is running → refuses and says what to do.
- [ ] **M** `pourgate uninstall` (stopped) → removes command and program, **keeps** data and config; reinstall picks them up.
- [ ] **M** `pourgate uninstall --purge` → everything removed; non-interactive without `--yes` is refused.
- [ ] **M** Docker: `uninstall-docker.sh` keeps the volume and `.env`; with `--purge` removes both; `--image` removes the image.
- [ ] **M** Windows app: uninstall from *Settings → Apps*; optionally delete `%APPDATA%\dev.pourgatellm.desktop`.
- [ ] **M** After uninstalling a service-enabled install, no `pourgatellm` unit / `PourGateLLM` task remains.

## 17. Release hygiene (maintainers)

- [ ] **M** *Release* workflow with a new version → Release page has the tarball; image tags `X.Y.Z` and `latest` exist; the GHCR package is public.
- [ ] **M** *Desktop release* workflow → `.msi` and `.exe` attached with the right version in the name.
- [ ] **M** Download the tarball, check it contains `bin/pourgate.mjs`, `install/`, `registry/`, `public/`, `VERSION`.
- [ ] **M** README commands (install, uninstall, testing) work exactly as written on a clean machine.
