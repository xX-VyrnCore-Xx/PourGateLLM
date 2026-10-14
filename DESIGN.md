# PourGateLLM — Documento di design (v0.1)

> Gateway self-hosted che unifica i piani gratuiti dei provider LLM dietro un'unica API OpenAI-compatibile.
> Catalogo aperto, routing basato su misure reali, token per client e quote.

## 1. Decisioni prese

| Area | Scelta |
|---|---|
| Obiettivo | Gateway free-tier personale / piccolo team |
| Stack | TypeScript, Node 22.13+ con Hono, monorepo pnpm |
| Storage | SQLite via `node:sqlite` integrato (Node >= 22.13), migrazioni SQL con `user_version`; Drizzle rimandato |
| Dashboard | React + Vite + Tailwind + shadcn/ui |
| Distribuzione | Docker/Compose, app desktop, CLI (`npx pourgate`) |
| API day-1 | OpenAI Chat Completions + Models (streaming, tool calling) |
| Catalogo | Registry aperto su Git + sync automatico |
| Routing | Strategie multiple + scoring da eval reali + routing per complessità |
| Sicurezza | Multi-utente, token per client, quote, audit log |
| Extra | Cache semantica/prompt cache, OpenTelemetry, PII redaction, plugin system |
| Licenza | MIT, nessun paywall |

## 2. Principi di design

| Principio | Come si traduce |
|---|---|
| Catalogo aperto | Registry in YAML nel repo (`registry/`), sync da bundle, PR della community, CI di validazione |
| Dati verificabili | **Probing** (pianificato): il gateway rileva i limiti reali da header e 429 e segnala drift rispetto al registry |
| Ranking basato su misure | **Eval periodiche** (pianificate): mini-benchmark per qualità, latenza, affidabilità per modello |
| Multi-utente | Token per client con rate limit, quota giornaliera e scadenza; audit log (pianificato) |
| Costo proporzionato alla richiesta | Routing per **complessità del prompt**: classificatore euristico a costo zero di quota (implementato) |
| Privacy esplicita | **PII redaction** e policy per provider (pianificate), es. "questo provider addestra sui prompt" |

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

- Sync: il gateway scarica periodicamente un bundle JSON del registry (ogni 12 h di default) con firma Ed25519 staccata opzionale (`<url>.sig`) verificata con una chiave pubblica configurata; nessun servizio a pagamento.
- Modello di fiducia: le voci del registry decidono a chi vengono inviate le chiavi API. Senza firma, il bundle può aggiornare solo modelli/limiti di provider già inclusi (mai endpoint o variabili chiave, mai nuovi provider). Con firma valida sono accettati anche nuovi provider, ma solo con endpoint `https` pubblici e variabile chiave `*_API_KEYS`. Versioni più vecchie sono rifiutate; l'ultimo bundle valido è in cache e ri-verificato all'avvio.
- Override locali: l'utente può correggere o aggiungere voci senza toccare il registry.
- Drift: se i limiti osservati divergono, la dashboard propone di aprire una PR/issue.

## 5. Router

1. **Filtro**: capability richieste (tools, vision, contesto) + policy privacy dell'utente.
2. **Candidati**: modelli con almeno una chiave non in cooldown e quota residua.
3. **Punteggio**: combinazione pesata di qualità (eval), velocità (p50/TTFT), affidabilità (tasso errori), quota residua.
4. **Strategie**: `quality`, `speed`, `quota`, `balanced`, profili nominati (`auto:coding`, `auto:vision`).
5. **Complessità** (implementato, `packages/server/src/complexity.ts`): classificatore euristico deterministico che non consuma quota. Somma segnali (lunghezza, codice, termini di ragionamento/ingegneria EN+IT, matematica, profondità della conversazione, tool, output strutturato, output lungo, `reasoning_effort`) in un punteggio → `easy`/`medium`/`hard` → tier `small`/`medium`/`large` (campo `tier` del registry). Il tier è una **preferenza**: gli altri restano come fallback. Dentro un tier vince il modello meno usato oggi. Si filtrano i modelli senza le capability richieste (tools, JSON, vision) o con contesto troppo piccolo. Modelli virtuali: `auto` (classifica) e `auto:small|medium|large` (forza il tier). Header di risposta: `x-pourgate-complexity`, `x-pourgate-tier`. Evoluzione possibile: classificatore con un piccolo modello gratuito per i casi ambigui.
6. **Failover**: su 429/5xx cooldown + rotazione chiave + modello successivo; sticky di conversazione opzionale.

## 6. Sicurezza e multi-utente

- Chiavi provider cifrate (AES-256-GCM con AAD = nome provider, chiave master da `POURGATE_MASTER_KEY` o keyfile 0600 generato al primo avvio), gestite dalla dashboard o da variabili d'ambiente, mai loggate né restituite dall'API.
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
| **MVP** (fatto: vedi README) | Monorepo, `/v1/chat/completions` + `/v1/models`, 5 provider (Groq, Gemini, Cerebras, Mistral, OpenRouter), key pool cifrato, limiter RPM/RPD, failover, SQLite, CLI base, Docker |
| **v0.2** | Registry aperto + sync + CI, dashboard (chiavi, modelli, playground), token per client |
| **v0.3** | Eval periodiche + scoring, strategie e profili, analytics |
| **v0.4** | Cache, PII redaction, OpenTelemetry (routing per complessità: fatto) |
| **v1.0** | Plugin system, app desktop, hardening sicurezza, documentazione |
| **Dopo** | Anthropic Messages, embeddings/immagini/audio, Responses API, MCP server |

## 9. Rischi e domande aperte

- **ToS dei provider**: la rotazione di molte chiavi/account può violare i termini. Il progetto deve dichiarare uso personale e rispetto dei limiti per chiave, senza incentivare multi-account abusivi.
- **Qualità dei dati del registry**: serve un processo di verifica (CI + probing) per evitare dati obsoleti.
- **Costo delle eval**: consumano quota gratuita; vanno limitate e schedulate a basso traffico.
- **Decisi in seguito**: nome PourGateLLM; runtime Node 22.13+ con Hono; provider MVP: Groq, Google Gemini, Cerebras, Mistral, OpenRouter; UI e documentazione in inglese con i18n pronta (italiano come traduzione).
