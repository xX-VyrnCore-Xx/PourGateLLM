# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it and the
impact you see. You will get an answer as soon as possible, and we will credit you in the fix unless you prefer not to be named.

## Supported versions

Only the **latest release** (and `main`) receives security fixes. To keep the Releases page small, the repository keeps only the three newest releases; upgrade with `pourgate update` or by pulling the latest image.

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

## How the project protects itself and you

- **Dependencies** are kept current by Dependabot (daily for npm; minor/patch updates merge automatically once CI is green, major updates and the desktop app's Rust crates wait for review). CodeQL scans the code on every pull request and weekly; the dependency review blocks new high-severity vulnerabilities.
- **`main` is protected**: changes arrive through pull requests with a required passing check (typecheck, tests, build, end-to-end smoke test).
- **Releases are verifiable**: every release publishes `SHA256SUMS`; the installers check the download against it and refuse a mismatch. The tarball and the container image carry signed build-provenance attestations (`gh attestation verify <file> --repo xX-VyrnCore-Xx/PourGateLLM`).
- **Workflows run with least privilege** (read-only token unless a job needs more) and do not keep credentials after checkout.

## Safe by default

- The gateway listens on **127.0.0.1** only; exposing it (`POURGATE_HOST=0.0.0.0`, or `POURGATE_BIND` for Docker) is an explicit choice.
- A dashboard password shorter than 8 characters is refused at start-up; under 12 it warns.
- The dashboard is served with a strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, `no-referrer` and, over HTTPS, HSTS; admin responses are never cached.
- Repeated failed API authentication from one address is throttled (429), on top of the login rate limit.
- The Docker image runs as a non-root user with no extra privileges or Linux capabilities.

## Repository settings

A few protections are GitHub settings that only the repository owner can switch on (secret scanning, push protection, private vulnerability reporting, Dependabot alerts): see [docs/REPO-SECURITY-SETUP.md](docs/REPO-SECURITY-SETUP.md).

## Hardening checklist for operators

- Keep the default loopback binding unless you need network access; if you do, add a firewall and serve the gateway **behind HTTPS** and set `POURGATE_COOKIE_SECURE=true`.
- Use long random values for `POURGATE_ADMIN_PASSWORD`, `POURGATE_TOKENS` and `POURGATE_METRICS_TOKEN`; never keep the `.env.example` placeholders.
- Set `POURGATE_MASTER_KEY` from a secret store instead of the key file that lives in the data volume, and back it up.
- Prefer per-client tokens with quotas and expiry over the static bootstrap tokens.
- Configure `POURGATE_REGISTRY_PUBKEY` if you follow a remote registry; unsigned bundles can only change models and limits.
- Install plugins only from sources you trust: they run with the gateway's privileges.
- Keep `POURGATE_LOG_RETENTION_DAYS` short if request metadata is sensitive, and remember that the response cache stores completions.

## Code scanning notes

CodeQL's `js/insufficient-password-hash` rule is switched off (`.github/codeql/codeql-config.yml`). It reports the SHA-256 hashing of client tokens, which are random 192-bit API tokens rather than passwords, so a slow password hash would add cost without adding security. The rule should be re-enabled if the gateway ever stores user-chosen passwords.
