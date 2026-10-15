# PourGateLLM and FreeLLMAPI

[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) (MIT) solves the same problem: one OpenAI-compatible endpoint over many free LLM tiers. This page records what was compared on 2026-10-15 (against its public repository) and what PourGateLLM took from it. No source code was copied; provider endpoints and "is this model free" facts were re-checked against each provider's own `/models` list.

## About "7.4 billion tokens per month"

That figure is FreeLLMAPI's marketing total: the sum of the published free quotas in its hosted model catalog, across 34 providers. It is not measured, and most of the catalog behind it is a signed feed that is partly paid (premium) and refreshed from their server.

PourGateLLM has **no token cap of its own**. Your real capacity is simply the sum of the free quotas of the keys you add:

| Lever | How |
|---|---|
| More providers | `pourgate registry discover --write` pulls every model a provider itself marks as free (7 providers, 107 models shipped today) |
| More keys | up to **500 keys per provider** (was 50), weighted round-robin, each key keeps its own limits and cooldowns |
| Less waste | response cache (exact and semantic), circuit breaker and latency-aware routing avoid burning quota on failures |

A single free key is a few thousand requests a day; hundreds of keys across dozens of providers is where the billions come from. Add keys, not code.

## What PourGateLLM has that FreeLLMAPI doesn't (or does differently)

Open, signed, self-updating registry (no paid catalog); per-client tokens with quotas; audit log; circuit breaker; PII redaction and per-provider privacy policy; evals-based model ranking; plugin system; one-command CLI/Docker/Windows installers with uninstallers and checksums.

## What FreeLLMAPI has that PourGateLLM lacks (candidate work)

| Feature | Status here |
|---|---|
| `/v1/responses` (needed by Codex CLI) and `/v1/completions` (editor autocomplete) | **done** (text, tools, streaming; responses are not stored) |
| "Fusion": fan out to several models and have a judge merge the answers | not implemented |
| Named fallback-chain profiles (`auto:<profile>`) and sticky sessions | not implemented |
| Dashboard form to add a custom OpenAI-compatible endpoint | possible today through registry overrides, no UI |
| Bulk key import/export, periodic key health checks | not implemented (per-key test button exists) |
| Native Gemini and Ollama API surfaces, MCP server | not implemented |
| Keyless providers (Kilo anonymous, OVH, AI Horde) | not supported: every provider needs a key |
| Prompt compression pipeline | not implemented |
| macOS / mobile apps | Windows app only |
