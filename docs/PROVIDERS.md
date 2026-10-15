# Providers: what works, what is verified, how much free quota

Checked on **2026-10-15** from a cloud container, with `pourgate registry verify`. "Verified" means a real chat request through the gateway's own code path returned an answer. A provider that needs a key can only be verified by someone holding that key: run `pourgate registry verify` (or press **Test** next to a key in the dashboard, which now sends the same tiny real request) to check yours.

## Status

| Provider | Needs a key? | Models | Status on 2026-10-15 |
|---|---|---|---|
| Kilo | no (anonymous) | 12 | **Verified**: 9 answered, 3 were briefly rate-limited (they route, the per-model daily limit was reached) |
| OVHcloud AI Endpoints | no (anonymous) | 10 | **Verified**: 10 of 10 answered. One listed model (`Mistral-7B-Instruct-v0.3`) answers "no Route matched" and was removed |
| LLM7 (turbo models) | no (anonymous) | 7 | **Verified**: 5 answered, 2 briefly rate-limited (1 request/second limit) |
| Pollinations | no (anonymous) | 1 | **Verified** |
| OpenRouter | yes | 13 `:free` | Reachable; the API rejects a bad key with a proper 401. Not run with a real key |
| Groq | yes | 4 | same |
| Cerebras | yes | 2 | same |
| Mistral | yes | 3 | same |
| Gemini (OpenAI-compatible endpoint) | yes | 3 | same |
| Routeway | yes | 9 | same |
| xKiro | yes | 55 | same |
| OrcaRouter | yes | 4 | same |
| BazaarLink | yes | 2 | same |
| Requesty | yes | 12 | same |

"Same" = reachable, no blocking by the provider's CDN with the gateway's default User-Agent, and a wrong key gives the provider's normal authentication error (so a right key should reach the model). That is evidence, not proof.

## How much can it reach per month?

Short answer: **about 0.4 billion tokens a month with one account per keyed provider; about 1.4 billion if Mistral's pooled free quota is really ~1 billion; the keyless providers add more that cannot be quantified.** Not 7.4 billion (that is FreeLLMAPI's headline for a 34-provider catalogue). These are estimates, not measurements.

Per account, per month, only where a *token* quota is documented or seeded:

| Provider | Free quota (claimed) | Tokens / month | Where the figure comes from |
|---|---|---|---|
| Mistral | "Experiment" plan, ~1B tokens/month shared by all models | ~1,000M | FreeLLMAPI's seed notes; the least certain and the biggest line |
| Gemini | per-model free tiers (flash-lite 1,000 requests/day, pro, flash) | ~135M | FreeLLMAPI seed budgets, which assume a 250k-token window per request |
| xKiro | 5M tokens/day on free models | ~150M | FreeLLMAPI docs |
| Cerebras | 1M tokens/day | ~30M | FreeLLMAPI seed |
| Groq | llama-3.3-70b 100k/day + llama-3.1-8b 500k/day | ~18M | this registry's limits |
| OpenRouter | 200 requests/day on `:free` models | ~6-12M | request cap × ~1-2k tokens |
| Routeway | 200 requests/day | ~12M | request cap × ~2k tokens |
| Requesty | 200 requests/day shared by free models | ~12M | request cap × ~2k tokens |
| **Sum** | | **≈ 1,370M (≈ 370M without Mistral)** | |

Not quantifiable: Kilo, OVH, LLM7, Pollinations (anonymous, limited per IP and per minute), OrcaRouter and BazaarLink (limits not published).

What moves the number:

- **More accounts multiply it** (up to 500 keys per provider in the gateway, weighted rotation). 7.4B would need roughly 5 accounts at every provider above, or far more at the small ones. **Most providers' terms forbid opening several free accounts to get around quotas**, and they do ban for it: use keys that are legitimately yours (family, team, separate projects where the provider allows it).
- **Quotas change without notice** (Gemini cut its free tier in late 2025). Run `pourgate registry check` and `registry verify` now and then.
- The cache (`POURGATE_CACHE_*`), compression (`POURGATE_COMPRESSION`) and latency-aware routing stretch the same quota further.

## Checking a provider yourself

```bash
pourgate registry verify                       # one tiny request per provider with your keys
pourgate registry verify --provider groq --all-models   # every model of one provider
pourgate registry check                        # are the model ids still listed by the provider?
pourgate registry discover --write             # refresh the free model lists
```
