# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it and the
impact you see. You will get an answer as soon as possible, and we will credit you in the fix unless you prefer not to be named.

## Supported versions

Only the latest commit on `main` is supported; the project has no tagged releases yet.

## What is in scope

PourGateLLM handles credentials, so reports about any of these are especially welcome:

- authentication or authorization bypass (client tokens, admin session, metrics token);
- leaks of provider keys, client tokens, the master key or the admin password (logs, API responses, errors, traces);
- weaknesses in key encryption at rest, or in how the registry sync decides what to trust;
- request smuggling, SSRF or injection through any endpoint, plugin hook or registry field;
- denial of service that an unauthenticated or low-privilege caller can trigger cheaply.

Out of scope: vulnerabilities that require control of the host, of the plugins directory (plugins are trusted code
by design) or of the environment variables; findings in third-party providers; missing HTTPS on a deployment you
configured without it.

## Hardening checklist for operators

- Serve the gateway **behind HTTPS** and set `POURGATE_COOKIE_SECURE=true`.
- Use long random values for `POURGATE_ADMIN_PASSWORD`, `POURGATE_TOKENS` and `POURGATE_METRICS_TOKEN`; never keep the `.env.example` placeholders.
- Set `POURGATE_MASTER_KEY` from a secret store instead of the key file that lives in the data volume, and back it up.
- Prefer per-client tokens with quotas and expiry over the static bootstrap tokens.
- Configure `POURGATE_REGISTRY_PUBKEY` if you follow a remote registry; unsigned bundles can only change models and limits.
- Install plugins only from sources you trust: they run with the gateway's privileges.
- Keep `POURGATE_LOG_RETENTION_DAYS` short if request metadata is sensitive, and remember that the response cache stores completions.
