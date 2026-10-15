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
| "Fusion": fan out to several models and have a judge merge the answers | **done** (`"model": "fusion"`, no tools) |
| Named fallback-chain profiles (`auto:<profile>`) and sticky sessions | **done** (file-based `profiles.yaml`, `x-pourgate-session` header; no dashboard editor yet) |
| Dashboard form to add a custom OpenAI-compatible endpoint | **done** (model auto-detection, stored in the database) |
| Bulk key import | **done** (paste many keys; no export, no periodic health check — the per-key test button exists) |
| MCP server | **done** (`/mcp`: chat, list_models, provider_status; no resources/prompts, no SSE stream) |
| Native Gemini and Ollama API surfaces | **done** (text, images, tools, streaming; no embeddings, no model management) |
| Keyless providers (Kilo anonymous, OVH, AI Horde) | **done** for Kilo and OVH (real request verified); AI Horde needs its own queue adapter, not implemented |
| Prompt compression pipeline | not implemented |
| macOS / mobile apps | Windows app only |
