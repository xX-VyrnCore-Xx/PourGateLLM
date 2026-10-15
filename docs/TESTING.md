# Testing PourGateLLM

Four levels, from "no setup" to "real providers". Each one tells you something different.

| Level | What it proves | Needs |
|---|---|---|
| 1. Unit tests | the code behaves as designed | Node, pnpm |
| 2. Smoke test | routing, failover, cache, streaming, dashboard work end to end | built project, no keys |
| 3. Doctor | your installation and configuration are sound | an install |
| 4. Real providers | your keys work and the registry matches reality | at least one real key |

## 1. Unit tests

```bash
pnpm install
pnpm typecheck && pnpm test
```

## 2. Smoke test (no API keys)

Starts a **fake provider** and the real built gateway on random ports, then checks 13 behaviours (rate-limit failover, `auto` tier routing, cache hits, streaming, dashboard login, playground, audit log, client tokens, metrics protection). Nothing leaves your machine.

```bash
pnpm build && pnpm smoke
```

Expect every line to start with `✓` and `All checks passed.` A `✗` shows what failed. It also runs in CI.

## 3. Doctor (your own installation)

```bash
pourgate doctor            # installed with the CLI installer
pnpm cli doctor            # from a source checkout
docker compose exec pourgate node dist/cli.js doctor   # Docker
```

It checks Node, the registry, the database (integrity, schema version), tokens, the dashboard password, the master key, and which providers have keys. It never prints secrets and never modifies anything.

Useful options:

- `--url http://localhost:3000 [--token pg-...]` also probes a **running** gateway (`/health`, then `/v1/models`).
- `--live` additionally sends every provider key to its provider (`GET {base_url}/models`) and reports accepted / rejected. This is the quickest way to find a typo in a key.

`✓` is fine, `!` is a warning (for example a provider without keys is simply disabled), `✗` is a problem to fix; the exit code is 1 when there is at least one `✗`.

## 4. Real providers

1. Put one key in your config (`pourgate env` prints the file; for Docker edit `.env`), for example `GROQ_API_KEYS=gsk_...`, and restart.
2. `pourgate doctor --live` — the provider should show `key accepted`.
3. Call the gateway with your API token (printed on first run, or `pourgate tokens create --name test`):

```bash
curl -s localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $PG_TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hi in five words"}]}' -i
```

Look at the response headers: `x-pourgate-provider`, `x-pourgate-model`, `x-pourgate-tier`, `x-pourgate-complexity` tell you where the router sent it.

4. Try the same from the dashboard's **Playground** tab (log in with the dashboard password).
5. Check the model ids: the registry ships with ids and limits that are **not verified**. If a model returns 404/400, correct its entry in `registry/<provider>.yaml` (or an override in `overrides/`), and consider opening a PR.

### Things worth trying once

| To see... | Do this |
|---|---|
| failover | add two keys for a provider and one invalid key: requests still succeed, the bad key is rested |
| complexity routing | send `"hi"` vs. a long engineering question with `model: "auto"`; compare `x-pourgate-tier` |
| the cache | set `POURGATE_CACHE_TTL_SECONDS=60`, send the same request twice with `"temperature":0`: second answer has `x-pourgate-cache: hit` |
| key weights / pause | Providers tab: set a key to ×3, or switch one off; watch `pourgate_` metrics or the usage counters |
| the circuit breaker | point a provider at a dead address in an override file; after a few failures the Providers tab shows `circuit open` |
| backups | `pourgate db backup --out backup.db`, then `pourgate db check` |

## Testing the installers

- **CLI**: on a clean machine run the installer, then `pourgate version`, `pourgate doctor`, `pourgate start`.
- **Uninstall (CLI)**: `pourgate uninstall` keeps your data and config; `pourgate uninstall --purge` removes everything. It refuses to run while the server is up.
- **Docker**: `install-docker.sh`, open `http://localhost:3000`; remove with `uninstall-docker.sh` (`--purge` also deletes the data volume and the folder, `--image` the image).
- **Windows app**: install the `.msi`/`.exe` from the release; remove it from *Settings → Apps*. App data lives in `%APPDATA%\dev.pourgatellm.desktop`.
