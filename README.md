# SentinelAI

A self-hosted AI gateway and observability platform. Routes requests to LLMs, enforces security policies, retrieves enterprise documents (RAG), runs agent workflows, and records full traces — all in one deployable stack.

```
Client → Nginx → Gateway (Fastify)
                    ├── Auth + Rate Limiting (Redis)
                    ├── Guardrails (injection, PII)
                    ├── Semantic Cache (pgvector)
                    ├── Model Router + A/B Experiments
                    ├── Session Memory + Context Guard
                    ├── RAG Retrieval (Hybrid Search)
                    ├── LLM Call (retry + fallback)
                    ├── Trace Spans → Postgres
                    ├── Eval Job → BullMQ → Eval Worker
                    └── Response
```

**Live:** `http://64.227.178.3` · **Docs:** `http://64.227.178.3/docs`

---

## Features

| Feature | Details |
|---|---|
| Multi-provider routing | OpenAI, Anthropic, Groq, Mistral, Cerebras, Gemini |
| Retry + fallback | Exponential backoff, automatic provider failover |
| Guardrails | Prompt injection detection, PII redaction |
| Semantic cache | pgvector cosine ≥ 0.95, 24h TTL |
| RAG | Hybrid vector + keyword search, RRF reranking |
| Conversation memory | Server-side sessions, context window auto-compression |
| A/B experiments | Probabilistic traffic split, variant tagged in response |
| Cost budgets | Monthly limits per tenant, webhook alerts |
| Eval worker | Faithfulness, relevance, coherence scored async |
| Observability | OTel-style spans, Prometheus metrics, Grafana dashboard |
| Admin API | Keys, budgets, experiments, cache management |
| Audit logs | Append-only compliance trail |

---

## Stack

```
Node.js 20 + TypeScript    Fastify HTTP server
PostgreSQL 16 + pgvector   Primary DB + vector search
Redis 7                    Rate limiting + BullMQ queues
BullMQ                     Async eval + ingestion jobs
Prometheus + Grafana       Metrics + dashboards
Nginx                      Reverse proxy
Docker Compose             8-service local/production stack
GitHub Actions             CI/CD → DigitalOcean droplet
```

---

## Quick Start

**Prerequisites:** Docker, Docker Compose, at least one LLM API key.

```bash
git clone https://github.com/Souravrajvi0/SentinelAI.git
cd SentinelAI
cp .env.example .env
# Edit .env — add at minimum GROQ_API_KEY and JWT_SECRET
docker compose up -d
```

The seed script creates a dev tenant and API key `sentinel-dev-key` automatically.

Test it:
```bash
curl -X POST http://localhost:3000/v1/chat \
  -H "X-Api-Key: sentinel-dev-key" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

API docs: `http://localhost:3000/docs`

---

## API Reference

### POST /v1/chat
Send a message to an LLM through the gateway.

```json
{
  "messages": [{"role": "user", "content": "Explain RAG in one sentence"}],
  "provider": "groq",
  "model": "llama-3.3-70b-versatile",
  "stream": false,
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "rag": {"enabled": true, "top_k": 5}
}
```

Response:
```json
{
  "id": "...",
  "trace_id": "...",
  "content": "RAG is a technique that...",
  "model": "llama-3.3-70b-versatile",
  "provider": "groq",
  "usage": {"prompt_tokens": 12, "completion_tokens": 45, "cost_usd": 0.0},
  "latency_ms": 423,
  "session_id": "550e8400-...",
  "session_turn": 1,
  "context_compressed": false
}
```

### POST /v1/retrieve
Hybrid search over indexed documents.

```json
{
  "query": "How does our refund policy work?",
  "top_k": 5,
  "hybrid": true
}
```

### POST /v1/documents
Upload a document for RAG indexing.

```bash
curl -X POST http://localhost:3000/v1/documents \
  -H "X-Api-Key: sentinel-dev-key" \
  -F "file=@policy.pdf" \
  -F "title=Refund Policy"
```

### POST /v1/agent
Run a ReAct agent with tool use. Supports streaming via SSE.

```json
{
  "task": "Search for the latest news on AI safety and summarize",
  "tools": ["web_search", "calculator"],
  "stream": true
}
```

### GET /v1/traces/:traceId
Full span timeline for any request.

### GET /v1/sessions/:sessionId
Retrieve conversation history + summary for a session.

### Admin endpoints (require `admin` scope)

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/admin/keys` | Create API key |
| DELETE | `/v1/admin/keys/:id` | Revoke API key |
| POST | `/v1/admin/budget` | Set monthly spend limit |
| POST | `/v1/admin/experiments` | Create A/B experiment |
| GET | `/v1/admin/cache/stats` | Semantic cache hit rate |
| DELETE | `/v1/admin/cache` | Flush cache |

---

## Environment Variables

```bash
# Required
JWT_SECRET=your-32-char-secret-minimum

# Database + Cache (Docker Compose sets these automatically)
DATABASE_URL=postgresql://sentinel:sentinel@postgres:5432/sentinelai
REDIS_URL=redis://redis:6379

# LLM providers — add at least one
GROQ_API_KEY=gsk_...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
MISTRAL_API_KEY=...
CEREBRAS_API_KEY=...
GEMINI_API_KEY=...

# Routing defaults
DEFAULT_PROVIDER=groq
DEFAULT_MODEL=llama-3.3-70b-versatile
FALLBACK_PROVIDER=groq
FALLBACK_MODEL=llama-3.1-8b-instant

# Embeddings (for RAG)
MISTRAL_EMBEDDING_MODEL=mistral-embed
EMBEDDING_DIMENSIONS=1024
```

---

## Architecture Decisions

- **Fastify over Express** — built-in schema validation, plugin system, lower overhead
- **pgvector over dedicated vector DB** — one database, joins work, no extra service to run
- **BullMQ over setTimeout** — jobs survive restarts, retries built-in, monitorable
- **SHA-256 for API keys** — high-entropy random strings don't need bcrypt's slowness
- **Fire-and-forget spans + eval** — observability failures never block client responses

See [`IDEA.txt`](./IDEA.txt) for the full engineering journal including design decisions, challenges faced, and inspiration sources.

---

## Project Structure

```
shared/src/types.ts          Shared TypeScript types + Provider union
services/gateway/src/
  app.ts                     Fastify app setup, plugin registration
  config.ts                  Zod-validated environment config
  routes/
    chat.ts                  POST /v1/chat — main gateway handler
    agent.ts                 POST /v1/agent — ReAct agent runtime
    retrieve.ts              POST /v1/retrieve — hybrid RAG search
    documents.ts             Document upload + ingestion trigger
    admin.ts                 Key/budget/experiment management
    sessions.ts              Conversation session CRUD
    traces.ts                Trace viewer + audit logs
  services/
    llm.ts                   Provider abstraction + retry logic
    router.ts                Routing rules + A/B experiment logic
    guardrails.ts            Injection detection + PII redaction
    semanticCache.ts         pgvector similarity cache
    conversationMemory.ts    Session load/save + context guard
    budget.ts                Monthly spend tracking
    audit.ts                 Append-only audit log writer
    agentRuntime.ts          ReAct tool-calling loop
    tracer.ts                OTel-style span management
services/ingestion-worker/   BullMQ worker: chunk + embed documents
services/eval-worker/        BullMQ worker: score response quality
infra/
  postgres/init.sql          Full DB schema
  prometheus/                Scrape config + alert rules
  grafana/                   Dashboard provisioning
```

---

## Deployment

Runs on DigitalOcean via Docker Compose. GitHub Actions deploys on every push to `main`:

```yaml
# .github/workflows/deploy.yml
# SSH → git pull → docker compose up --build → health check
```

Required repository secrets: `DROPLET_IP`, `DROPLET_USER`, `SSH_PRIVATE_KEY`.

---

## Interview / Learning Docs

The [`interview/`](./interview/) directory contains 6 guides that explain every concept used in this project from the ground up — from "what is an LLM" to deep dives on RAG, vector search, and system design trade-offs.

---

*Built as a portfolio project targeting AI infrastructure and backend platform engineering roles.*
