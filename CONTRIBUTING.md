# Contributing

Thanks for helping! The most valuable contributions are **registry fixes** (wrong model ids or limits), **new providers**
and **eval tasks**, but code, docs and tests are welcome too.

## Setup

Requires Node ≥ 22.13 and pnpm.

```bash
pnpm install
pnpm typecheck && pnpm test     # must pass before a PR
pnpm dev                        # API on :3000 (from the repo root)
pnpm --filter @pourgate/client dev   # dashboard on :5173
```

CI runs typecheck, tests and the build on every pull request, and `main` only accepts pull requests that pass it.

## Registry changes

Provider and model data lives in [`registry/`](registry) (one YAML file per provider; schema in `packages/shared/src/registry.ts`).

- Verify against the provider's **official documentation or a real response** (the dashboard flags models whose reported
  `x-ratelimit-*` limits differ from the registry), and put the source in the PR description.
- Set `verified_at: YYYY-MM-DD` only for values you actually checked. Unverified entries simply omit it.
- Use `tier: small|medium|large` as a rough capability class (used by complexity routing), `capabilities` honestly
  (`chat`, `tools`, `json_mode`, `vision`, `embeddings`, `transcription`, `speech`, `images`), and `trains_on_prompts`
  only when the provider's terms say so.
- Never add an endpoint you do not control to a provider you do not know: base URLs decide where API keys are sent.

## Eval tasks

[`evals/suite.json`](evals/suite.json) holds short tasks with **deterministic** checks (`equals`, `includes`,
`includesAll`, `regex`, `json`). Good tasks have one unambiguous answer, are cheap to answer, and do not depend on recent facts.

## Code changes

- Keep changes focused, and add or update tests next to the code (`packages/server/test`).
- Match the surrounding style; TypeScript is strict.
- Do not log, store or return prompts, completions, API keys or tokens. Metadata only.
- Anything that sends data to a provider must respect the privacy policy and the key limits.
- User-facing strings in the dashboard go through `packages/client/src/lib/i18n.ts` (English and Italian).

## Pull requests

Describe what changed, any caveats, and how you tested it (the PR template has the headings). Security problems go to
[SECURITY.md](SECURITY.md), not to public issues.

By contributing you agree that your work is released under the [MIT License](LICENSE).
