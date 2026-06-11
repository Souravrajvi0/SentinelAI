# 03 — System Design: How SentinelAI is Built

How the pieces fit together. Every service, every database table, every queue — explained from scratch.

---

## The Monorepo Structure

SentinelAI is a **monorepo** — one Git repository that contains multiple separate services. This is a common pattern at companies like Google, Meta, and Stripe.

```
SentinelAI/
├── shared/              ← TypeScript types shared by all services
├── services/
│   ├── gateway/         ← The main HTTP server (port 3000)
│   ├── ingestion-worker/← Background worker for document processing
│   └── eval-worker/     ← Background worker for response scoring
├── infra/
│   ├── postgres/        ← Database schema (init.sql)
│   ├── nginx/           ← Reverse proxy config
│   ├── prometheus/      ← Metrics scrape + alert rules
│   └── grafana/         ← Dashboard provisioning
└── docker-compose.yml   ← Runs all 8 services together
```

Why monorepo? The services share types (`Message`, `Provider`, queue names). If they were separate repos, keeping those types in sync would be painful. With a monorepo, a type change in `shared/` breaks any service that misuses it — at compile time, before deployment.

---

## The 8 Services (Docker Compose)

```
┌─────────────┐    ┌──────────┐    ┌────────────────────┐
│    Nginx    │───▶│ Gateway  │───▶│   PostgreSQL +     │
│  (port 80)  │    │(port 3000│    │    pgvector        │
└─────────────┘    └──────────┘    └────────────────────┘
                        │                    ▲
                        ▼                    │
                   ┌──────────┐    ┌─────────┴──────────┐
                   │  Redis   │    │  Ingestion Worker  │
                   │ (queue + │    │  (chunks + embeds) │
                   │  cache)  │    └────────────────────┘
                   └──────────┘    ┌────────────────────┐
                        │          │    Eval Worker     │
                        └─────────▶│  (scores answers) │
                                   └────────────────────┘
                   ┌──────────┐    ┌────────────────────┐
                   │Prometheus│    │      Grafana       │
                   │(metrics) │───▶│   (dashboards)     │
                   └──────────┘    └────────────────────┘
```

### Gateway (Fastify, port 3000)
The main HTTP server. Every API request comes through here. It handles auth, rate limiting, routing, LLM calls, RAG retrieval, session memory, and response streaming. This is where 90% of the business logic lives.

### Ingestion Worker
A background process that watches a Redis queue. When you upload a document via `POST /v1/documents`, the gateway adds a job to the `INGEST` queue. The ingestion worker picks it up, splits the document into chunks, calls Mistral to embed them, and stores the vectors in Postgres. It never handles HTTP traffic directly.

### Eval Worker
Another background process. After every successful LLM response, the gateway adds a job to the `EVAL` queue. The eval worker calls a judge LLM (e.g. llama-3.3-70b-versatile) to score the response quality and saves the scores. It runs asynchronously so it never adds latency to client responses.

### PostgreSQL + pgvector
The primary database. Stores everything: tenants, API keys, requests, traces, documents, embeddings, sessions, budgets, experiments, eval scores, and audit logs. The `pgvector` extension adds a `vector` column type and distance operators (`<=>` for cosine distance) that power all semantic search.

### Redis
Two jobs:
1. **Rate limiting** — tracks how many requests per minute each tenant has made
2. **BullMQ queue** — stores the INGEST and EVAL job queues persistently. Jobs survive gateway restarts because they're in Redis, not in memory.

### Nginx
The reverse proxy that sits in front of the gateway. In production it handles SSL termination and routes `http://64.227.178.3/` to `localhost:3000`. In development it's mostly transparent.

### Prometheus
Pulls metrics from the gateway every 15 seconds via `GET /metrics`. Stores time-series data. Fires alerts (to Grafana / PagerDuty / Slack) if error rates go too high.

### Grafana
Dashboard UI. Connects to Prometheus as a data source and displays charts of requests per second, latency percentiles, token usage, cost, and error rates.

---

## Full Request Lifecycle

Let's trace what happens when a client calls `POST /v1/chat`:

```
1. Nginx receives the request on port 80
   → Proxies to Gateway on port 3000

2. Fastify auth plugin
   → Reads X-Api-Key header
   → SHA-256 hashes it
   → Queries api_keys table for a match
   → Attaches tenantId and scopes to the request
   → Returns 401 if no match

3. Fastify rate-limit plugin
   → Checks Redis: how many requests has this tenantId made in the last minute?
   → Returns 429 if over the per-tenant RPM limit
   → Increments the counter

4. Guardrails check
   → Regex scan for prompt injection patterns
   → Regex scan for PII (email, phone, SSN, credit card)
   → Redacts PII in-place if found
   → Blocks and returns 400 if injection detected

5. Budget check
   → Queries tenant_budgets + SUM of this month's cost from llm_requests
   → Returns 402 if the monthly budget is exceeded
   → Fires webhook alert if over 80% threshold

6. Semantic cache check (skipped if session_id or RAG or streaming)
   → Embeds the user's message via Mistral
   → Queries semantic_cache for cosine distance < 0.05 (similarity > 0.95)
   → Returns cached response immediately if hit (no LLM call)

7. Model routing
   → Checks routing rules: long context? → big model. Low priority? → small model
   → A/B experiment override if one is active for this tenant
   → Picks provider + model

8. Session memory load (only if session_id provided)
   → Loads message history from conversation_sessions
   → Appends the new user message
   → Context guard: if total tokens > 75% of model limit, summarizes old turns
   → Builds final message array to send to LLM

9. RAG retrieval (only if rag.enabled = true)
   → Embeds the user's query
   → Runs hybrid search: pgvector cosine + tsvector keyword, merged via RRF
   → Builds system message: "Answer using this context: [chunks]"

10. LLM call
    → withRetry(): calls the provider (Groq, OpenAI, Anthropic, etc.)
    → Exponential backoff on failure: 100ms, 200ms, 400ms
    → If all retries fail, tries fallback provider
    → Returns content, token counts, latency

11. Persist request record
    → INSERT INTO llm_requests (all the metadata: tokens, cost, latency, provider, etc.)

12. Fire-and-forget async work
    → flushSpans(): writes OTel trace spans to trace_spans table
    → evalQueue.add(): adds eval job to Redis/BullMQ
    → saveSession(): updates conversation_sessions if session_id was provided

13. Response to client
    → JSON with content, trace_id, session_id, usage, cost, latency
```

---

## Database Schema Design

Why does the schema look the way it does?

### Multi-tenancy
Every table that contains per-customer data has a `tenant_id UUID` column. This is the **shared schema** multi-tenancy pattern — all tenants' data is in the same tables, but every query filters by `tenant_id`. This is simpler to operate than separate schemas per tenant while still providing data isolation through the application layer.

### API keys store hashes, not raw keys
```sql
key_hash VARCHAR(64) UNIQUE NOT NULL  -- SHA-256 of raw key
```
The raw key is shown exactly once (at creation time) and never stored. Even if an attacker reads the database, they get hashes — useless without the original key. This is the same approach used by GitHub, Stripe, and Heroku for API tokens.

### Audit logs are append-only
```sql
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  ...
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- No updated_at, no soft-delete — this table must never change
```
An audit log that can be modified is not a real audit log. The `BIGSERIAL` primary key (sequential integers) makes it easy to detect gaps if rows are deleted. In production you'd also set a Postgres role that only has `INSERT` privilege on this table.

### pgvector columns
```sql
embedding vector(1024)  -- in document_chunks
query_embedding vector(1024)  -- in semantic_cache
```
The `vector(1024)` type stores a 1024-dimensional float array. The `<=>` operator computes cosine distance. The IVFFlat index makes queries fast:
```sql
CREATE INDEX ON document_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```
`lists = 100` means the index divides all vectors into 100 clusters. At query time it only searches the most similar clusters, not all rows — trading a tiny bit of accuracy for massive speed.

### Generated column for hybrid search
```sql
content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
```
This is a Postgres feature: the column is automatically computed from `content` whenever a row is inserted or updated. We don't have to remember to update it manually. The GIN index on this column powers full-text search.

---

## The Queue Architecture (BullMQ)

BullMQ is a job queue that uses Redis for storage. Here's why it matters:

**Without a queue:**
```
Request → call Mistral to embed → store in DB → return response
         ↑ this adds 500ms to every document upload
```

**With a queue:**
```
Request → add job to Redis queue → return "processing" response (fast)
                                         ↓
                    [separately] Ingestion Worker polls queue
                    → calls Mistral → stores in DB → marks job complete
```

The queue decouples the HTTP request from the slow work. The client gets a fast response. The slow work happens in the background.

BullMQ also gives you:
- **Persistence:** jobs are in Redis, not in memory. A gateway restart doesn't lose jobs.
- **Retries:** if the embedder crashes mid-job, BullMQ retries it automatically.
- **Visibility:** you can see how many jobs are pending, active, or failed.

---

## Observability: Traces, Metrics, Alerts

**Traces** answer "what happened for request X?"
```
trace_id: abc-123
  span: gateway.guardrails     0ms → 2ms    (ok)
  span: gateway.routing        2ms → 3ms    (ok)
  span: retrieval.search       3ms → 45ms   (ok, returned 5 chunks)
  span: llm.completion         45ms → 612ms (ok)
```
Every request produces a tree of spans. If something was slow or failed, you can see exactly where.

**Metrics** answer "how is the system performing overall?"
```
sentinelai_llm_requests_total{provider="groq", status="success"} = 14,823
sentinelai_llm_latency_seconds{p95} = 0.8
sentinelai_llm_cost_usd_total = 4.21
```
Prometheus scrapes these from `GET /metrics` every 15 seconds and stores them over time.

**Alerts** answer "is something broken right now?"
```yaml
- alert: HighErrorRate
  expr: rate(sentinelai_llm_requests_total{status="error"}[2m]) /
        rate(sentinelai_llm_requests_total[2m]) > 0.1
  for: 2m
  # If >10% of requests are erroring for 2 minutes, fire an alert
```

---

## Summary

- SentinelAI is a monorepo with 3 services (gateway, ingestion worker, eval worker) + infra
- The gateway handles all HTTP traffic; workers handle async background jobs
- PostgreSQL stores everything; pgvector adds vector columns; Redis stores queues and rate limits
- Every request produces a trace, metrics, and an async eval job
- The database design enforces multi-tenancy, audit immutability, and efficient vector search
