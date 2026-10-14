# PourGateLLM — Documento di design (v0.1)

> Gateway self-hosted che unifica i piani gratuiti dei provider LLM dietro un'unica API OpenAI-compatibile.
> Ispirato a [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi), con catalogo aperto, routing basato su misure reali e multi-utente.

## 1. Decisioni prese

| Area | Scelta |
|---|---|
| Obiettivo | Gateway free-tier personale / piccolo team |
| Stack | TypeScript, Node 20+ con Hono, monorepo pnpm |
| Storage | SQLite (Drizzle ORM + migrazioni) |
| Dashboard | React + Vite + Tailwind + shadcn/ui |
| Distribuzione | Docker/Compose, app desktop, CLI (`npx pourgate`) |
| API day-1 | OpenAI Chat Completions + Models (streaming, tool calling) |
| Catalogo | Registry aperto su Git + sync automatico |
| Routing | Strategie multiple + scoring da eval reali + routing per complessità |
| Sicurezza | Multi-utente, token per client, quote, audit log |
| Extra | Cache semantica/prompt cache, OpenTelemetry, PII redaction, plugin system |
| Licenza | MIT, nessun paywall |

## 2. Differenziatori rispetto a FreeLLMAPI

| Punto debole originale | Risposta di PourGateLLM |
|---|---|
| Aggiornamenti catalogo in giornata a pagamento (feed firmato, lag 30 gg per i free) | Registry **aperto** nel repo (`registry/`), sync da GitHub, PR della community, CI di validazione |
| Quote/limiti dichiarati, non verificati | **Probing**: il gateway rileva limiti reali da header e 429 e segnala drift rispetto al registry |
| Ranking basato su metriche live generiche | **Eval periodiche** (mini-benchmark) per qualità, latenza, affidabilità per modello |
| Single-user | Utenti, token per client, quote e budget per token, audit log |
| Solo routing per strategia | Routing per **complessità del prompt** (classificatore leggero) |
| Privacy non gestita | **PII redaction** e policy per provider (es. "questo provider addestra sui prompt") |

## 3. Architettura

```
Client (OpenAI SDK, curl, agenti)
        │  Bearer pg-xxxx
        ▼
┌─────────────────────────── Gateway (Hono) ───────────────────────────┐
│ Auth & quote → Middleware (PII, cache) → Router → Provider adapters          │
│                                            │            │                    │
│                                   Scoring/Eval     Key pool + limiter        │
└─────────────────────────────────────────────────────────────────────────────┘
        │                    │                         │
   SQLite (stato)    Registry sync (Git)      Provider (Groq, Gemini, …)
        │
   Dashboard React + CLI + Desktop (Tauri)
```

### Pacchetti del monorepo

- `packages/shared` — tipi, schema Zod del registry, utilità.
- `packages/server` — API, router, adapter provider, limiter, cache, telemetria.
- `packages/client` — dashboard React.
- `packages/cli` — comando `pourgate` (serve, keys, tokens, registry, eval).
- `packages/desktop` — wrapper Tauri.
- `registry/` — catalogo YAML dei provider/modelli/limiti (vedi §4).
- `evals/` — suite di mini-benchmark.

## 4. Registry aperto

Un file per provider, validato in CI con schema Zod:

```yaml
provider: groq
base_url: https://api.groq.com/openai/v1
auth: bearer
trains_on_prompts: false
models:
  - id: llama-3.3-70b-versatile
    family: llama-3.3-70b
    capabilities: [chat, tools, json_mode]
    context: 131072
    limits: { rpm: 30, rpd: 1000, tpm: 12000, tpd: 100000 }
    quirks: [no_logprobs]
    verified_at: 2026-10-01
```

- Sync: il gateway scarica periodicamente un release/tag del registry (hash verificato, firma opzionale con chiave pubblica del progetto, nessun servizio a pagamento).
- Override locali: l'utente può correggere o aggiungere voci senza toccare il registry.
- Drift: se i limiti osservati divergono, la dashboard propone di aprire una PR/issue.

## 5. Router

1. **Filtro**: capability richieste (tools, vision, contesto) + policy privacy dell'utente.
2. **Candidati**: modelli con almeno una chiave non in cooldown e quota residua.
3. **Punteggio**: combinazione pesata di qualità (eval), velocità (p50/TTFT), affidabilità (tasso errori), quota residua.
4. **Strategie**: `quality`, `speed`, `quota`, `balanced`, profili nominati (`auto:coding`, `auto:vision`).
5. **Complessità**: classificatore leggero (euristiche + piccolo modello gratuito) → `easy` ai modelli piccoli, `hard` ai migliori.
6. **Failover**: su 429/5xx cooldown + rotazione chiave + modello successivo; sticky di conversazione opzionale.

## 6. Sicurezza e multi-utente

- Chiavi provider cifrate (AES-256-GCM, chiave master da env o keyfile), mai loggate.
- Utenti admin con login (password + opzione passkey), sessioni sicure.
- Token API per client: scope, rate-limit, budget token/giorno, scadenza, revoca.
- Audit log di accessi e modifiche; log delle richieste con redazione configurabile.
- Rate-limit e protezione brute-force sull'endpoint di login.

## 7. Extra

- **Cache**: exact-match + semantica (embedding locali o free), TTL, opt-in per token.
- **Observability**: OpenTelemetry (trace/metriche), endpoint Prometheus, export log JSONL.
- **Privacy**: PII redaction (regex + NER leggero), blocco provider che addestrano sui prompt.
- **Plugin**: interfacce `ProviderAdapter`, `RoutingStrategy`, `Middleware` caricabili da pacchetti npm.

## 8. Roadmap

| Fase | Contenuto |
|---|---|
| **MVP** | Monorepo, `/v1/chat/completions` + `/v1/models`, 5 provider (Groq, Gemini, Cerebras, Mistral, OpenRouter), key pool cifrato, limiter RPM/RPD, failover, SQLite, CLI base, Docker |
| **v0.2** | Registry aperto + sync + CI, dashboard (chiavi, modelli, playground), token per client |
| **v0.3** | Eval periodiche + scoring, strategie e profili, analytics |
| **v0.4** | Routing per complessità, cache, PII redaction, OpenTelemetry |
| **v1.0** | Plugin system, app desktop, hardening sicurezza, documentazione |
| **Dopo** | Anthropic Messages, embeddings/immagini/audio, Responses API, MCP server |

## 9. Rischi e domande aperte

- **ToS dei provider**: la rotazione di molte chiavi/account può violare i termini. Il progetto deve dichiarare uso personale e rispetto dei limiti per chiave, senza incentivare multi-account abusivi.
- **Qualità dei dati del registry**: serve un processo di verifica (CI + probing) per evitare dati obsoleti.
- **Costo delle eval**: consumano quota gratuita; vanno limitate e schedulate a basso traffico.
- **Decisi in seguito**: nome PourGateLLM; runtime Node 20+ con Hono; provider MVP: Groq, Google Gemini, Cerebras, Mistral, OpenRouter; UI e documentazione in inglese con i18n pronta (italiano come traduzione).
