# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

SentinelAI — a self-hosted AI gateway and observability platform. It routes requests to LLMs, enforces security policies, retrieves enterprise documents (RAG), runs async eval workers, and records full traces. There is no frontend; everything is REST APIs.

## Commands

```bash
# Install all workspace dependencies
npm install

# Run a single service in dev mode
npm run dev -w @sentinelai/gateway
npm run dev -w @sentinelai/ingestion-worker
npm run dev -w @sentinelai/eval-worker

# Type-check everything
npm run typecheck

# Build everything
npm run build

# Start infrastructure (Postgres + Redis) only
docker compose up postgres redis -d

# Start full stack
docker compose up -d

# Reset database (drops + recreates)
docker compose down -v && docker compose up postgres -d
```

## Architecture

This is an npm workspace monorepo with three services and one shared types package.

```
shared/                    — Shared TypeScript types + queue name constants
services/
  gateway/                 — Fastify HTTP server (port 3000)
  ingestion-worker/        — BullMQ worker: chunks + embeds documents
  eval-worker/             — BullMQ worker: scores LLM response quality
infra/
  postgres/init.sql        — Full DB schema (run once on fresh DB)
  nginx/nginx.conf         — Reverse proxy config
docker-compose.yml         — Full local stack
```

### Request Flow (gateway)

```
POST /v1/chat
  → auth plugin (SHA-256 API key lookup)
  → rate-limit plugin (Redis, per-tenant)
  → guardrails service (injection detection, PII redaction)
  → router service (picks provider/model, fallback logic)
  → llm service (OpenAI / Anthropic / Groq abstraction)
  → persist llm_requests row
  → async: flush trace_spans to DB
  → async: enqueue eval job to BullMQ
  → return response
```

### Queue Architecture

- **INGEST queue** (`@sentinelai/shared` → `QUEUES.INGEST`): Gateway enqueues when a document is uploaded. Ingestion worker dequeues, chunks with `chunker.ts`, embeds in batches via OpenAI, persists `document_chunks` with `vector` column.
- **EVAL queue** (`QUEUES.EVAL`): Gateway enqueues after every successful chat response. Eval worker scores faithfulness/relevance/coherence using an LLM judge, stores result in `eval_results`.

### Database

PostgreSQL with `pgvector`. Key tables:
- `tenants`, `api_keys` — multi-tenant auth
- `llm_requests` — one row per request, full audit trail
- `trace_spans` — OTel-style spans linked by `trace_id`
- `document_chunks` — chunked text + `vector(1536)` embedding column
- `eval_results` — per-request quality scores
- `audit_logs` — append-only, no UPDATE/DELETE

Vector search uses `ivfflat` index with cosine distance (`<=>` operator).

### Key Design Decisions

- **API key auth only** — keys are SHA-256 hashed at storage; raw key never persisted.
- **Provider abstraction** in `services/llm.ts` — add a new provider by adding a case there and updating `COST_TABLE`.
- **Routing rules** in `services/router.ts` — pure function, easy to extend with cost/latency-based rules.
- **Guardrails** in `services/guardrails.ts` — regex-based injection/PII checks run before every LLM call.
- **Spans are fire-and-forget** — `flushSpans()` is called without `await` so it never blocks the request response.
- **Eval is async** — always enqueued after response is sent; failures are logged but don't affect the client.

## Environment

Copy `.env.example` to `.env` and fill in at minimum `JWT_SECRET` and at least one LLM provider key. The seed in `init.sql` creates a dev tenant and API key `sentinel-dev-key`.

```bash
cp .env.example .env
# then edit .env
```

Test the gateway with:
```bash
curl -X POST http://localhost:3000/v1/chat \
  -H "X-Api-Key: sentinel-dev-key" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

API docs auto-generated at `http://localhost:3000/docs`.
