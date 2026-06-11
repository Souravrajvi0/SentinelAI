# 05 — Every Technology Used, Explained from Scratch

If someone asks "why did you use X instead of Y" — this is your answer.

---

## Node.js + TypeScript

### What is Node.js?
Node.js lets you run JavaScript on a server (outside a browser). JavaScript was originally only for browsers. Node.js changed that in 2009 by taking the V8 engine (the JS engine inside Chrome) and packaging it as a standalone runtime.

Why use it for an API gateway?
- **Non-blocking I/O:** Node.js handles I/O (network requests, database queries) without blocking the thread. While waiting for a database response, it can handle other incoming requests. This makes it very efficient for a gateway that does lots of I/O (LLM calls, DB writes, Redis reads).
- **Ecosystem:** npm has packages for everything — OpenAI SDK, Anthropic SDK, BullMQ, Fastify, Zod, pgvector clients, etc.
- **TypeScript support:** First-class, excellent tooling.

### What is TypeScript?
TypeScript is JavaScript with types. You declare what type each variable, function parameter, and return value should be:

```typescript
function callLLM(provider: Provider, model: string, messages: Message[]): Promise<LLMResult>
```

The TypeScript compiler checks these types at build time. If you pass the wrong type, it's a compile error — caught before deployment, not after. This is especially important in a codebase with multiple services sharing types.

**Why not Python?** Python is the AI ecosystem's language for training models and writing ML pipelines. But for a gateway (HTTP server, queues, database), Node.js with TypeScript is faster to write, has comparable performance, and has excellent LLM SDK support. Python would also be a valid choice — FastAPI + Celery + SQLAlchemy is the rough equivalent.

---

## Fastify

### What is it?
Fastify is a Node.js web framework — like Express, but faster and with more built-in features.

### Why Fastify over Express?
Express is the oldest, most popular Node.js framework but it's quite barebones:
- No built-in schema validation
- No built-in serialization optimization
- Plugin system is unofficial and inconsistent
- TypeScript support is bolted on

Fastify was designed to fix these:

| Feature | Express | Fastify |
|---|---|---|
| Schema validation | Manual / use a library | Built-in (JSON Schema) |
| Response serialization | JSON.stringify (slow) | Fast schema-based serializer |
| Plugin system | Informal, middleware-based | Formal, encapsulation scopes |
| TypeScript | Types are add-ons | First-class from the start |
| Swagger/OpenAPI | Manual | Plugin: auto-generates from schemas |

In SentinelAI, Fastify's plugin system is used for auth (`app.register(authPlugin)`) and rate limiting (`app.register(fastifyRateLimit)`). Each route file is a Fastify plugin registered under the `/v1` prefix. Swagger UI is auto-generated from the route schemas.

---

## PostgreSQL

### What is it?
PostgreSQL (Postgres) is an open-source relational database. Data is stored in tables with rows and columns, and you query it with SQL.

### Why PostgreSQL for an AI project?
The common assumption is: AI projects need a specialized vector database (Pinecone, Qdrant, Weaviate). This is often wrong.

The **pgvector** extension adds a `vector` column type to Postgres and operators for distance calculation. This gives you:
- Vector storage + similarity search (for RAG and semantic cache)
- All the standard SQL features you already need (JOINs, transactions, indexes, foreign keys)
- One database to operate, backup, monitor, and restore

For a project handling hundreds of thousands of document chunks, pgvector with an IVFFlat index is fast enough (millisecond queries). Only at tens of millions of vectors does a dedicated vector DB become worth the operational complexity.

### Key Postgres Features Used

**pgvector:**
```sql
embedding vector(1024)  -- column type
ORDER BY embedding <=> query_vector  -- cosine distance operator
CREATE INDEX USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
```

**Generated columns (for hybrid search):**
```sql
content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
```
PostgreSQL computes and updates this column automatically. No application code needed to maintain it.

**JSONB:**
```sql
metadata JSONB NOT NULL DEFAULT '{}'
messages JSONB NOT NULL DEFAULT '[]'  -- stores conversation history
```
JSONB stores structured data (arrays, objects) inside a column. It's indexed, queryable, and flexible — perfect for storing message arrays that vary in length.

**Window / aggregate functions for cost tracking:**
```sql
SELECT SUM(cost_usd) FROM llm_requests
WHERE tenant_id = $1
AND created_at >= date_trunc('month', NOW())
```

---

## Redis

### What is it?
Redis is an in-memory key-value store. Unlike a database (data on disk), Redis keeps everything in RAM — making reads and writes microseconds fast. It does persist to disk for durability, but the primary value is speed.

### Two Uses in SentinelAI

**1. Rate limiting**

```
Key: "rate_limit:tenant-uuid-123"
Value: counter (how many requests this minute)
TTL: 60 seconds (auto-expires after a minute)

Operation:
  INCR rate_limit:tenant-uuid-123
  → if value > limit: 429 Too Many Requests
  → if value == 1: set TTL to 60s (first request of this window)
```

This is done using the `@fastify/rate-limit` plugin which uses Redis under the hood. The counter is distributed — if you run multiple gateway instances, they all share the same Redis counter. This makes rate limiting work correctly at scale.

**2. BullMQ job queues**

BullMQ stores job data, job states (waiting/active/completed/failed), and retry counts in Redis. A job looks like:
```
Key: "bull:INGEST:job:42"
Value: { document_id: "...", tenant_id: "...", status: "waiting" }
```

When the ingestion worker picks up the job, it changes the status to "active." When done, "completed." If it throws, BullMQ moves it to the "failed" state and optionally retries. All of this is managed by BullMQ automatically using Redis data structures.

---

## BullMQ

### What is it?
BullMQ is a Node.js library for creating job queues backed by Redis. You add jobs to a queue, and workers pick them up and process them.

### Why Not Just `setTimeout` or `setImmediate`?
```typescript
// BAD: job is lost if the server restarts
setTimeout(() => embedDocument(docId), 0);

// GOOD: job is in Redis, survives restarts, has retry logic
await ingestQueue.add('ingest', { document_id: docId });
```

The key advantages:
- **Persistence:** jobs in Redis survive process crashes and restarts
- **Retries:** BullMQ can retry failed jobs automatically with backoff
- **Visibility:** you can see the queue length, active jobs, failed jobs
- **Concurrency:** multiple worker processes can consume from the same queue without duplicate processing (Redis handles locking)

---

## Docker + Docker Compose

### What is Docker?
Docker packages an application and all its dependencies into a **container** — a lightweight, isolated environment. The container runs the same way on your laptop, on CI, and on a production server.

Without Docker: "It works on my machine" — differences in Node.js version, OS library versions, etc. cause bugs that only appear in production.

With Docker: everyone runs the exact same thing.

### What is Docker Compose?
Docker Compose lets you define and run multiple containers together in one config file.

SentinelAI's `docker-compose.yml` defines all 8 services:
```yaml
services:
  gateway:
    build: ./services/gateway
    ports: ["3000:3000"]
    depends_on: [postgres, redis]
  
  postgres:
    image: pgvector/pgvector:pg16
    volumes: [postgres_data:/var/lib/postgresql/data]
  
  redis:
    image: redis:7-alpine
  ...
```

`docker compose up -d` starts all 8 services, creates networks between them, and manages restarts. `docker compose build gateway` rebuilds only the gateway image when code changes.

### Why Alpine Images?
Images like `node:20-alpine` and `redis:7-alpine` use Alpine Linux (a minimal Linux distro, ~5MB vs ~100MB for Ubuntu). Smaller images = faster builds, faster pulls, smaller attack surface.

---

## Prometheus + Grafana

### Prometheus
Prometheus is a time-series database and monitoring system. It works by **scraping** — periodically making an HTTP request to your service's `/metrics` endpoint and storing the numbers.

SentinelAI exposes metrics like:
```
# HELP sentinelai_llm_requests_total Total LLM requests
# TYPE sentinelai_llm_requests_total counter
sentinelai_llm_requests_total{provider="groq",model="llama-3.3-70b-versatile",status="success"} 14823

# HELP sentinelai_llm_latency_seconds Request latency
# TYPE sentinelai_llm_latency_seconds histogram
sentinelai_llm_latency_seconds_bucket{le="0.5"} 12041
sentinelai_llm_latency_seconds_bucket{le="1.0"} 14201
```

Prometheus is configured to scrape `http://gateway:3000/metrics` every 15 seconds.

### Grafana
Grafana is a dashboard tool. It connects to Prometheus as a data source and renders charts. You write PromQL (Prometheus Query Language) queries:

```promql
# Requests per second over last 5 minutes
rate(sentinelai_llm_requests_total[5m])

# p95 latency
histogram_quantile(0.95, rate(sentinelai_llm_latency_seconds_bucket[5m]))
```

In SentinelAI, the Grafana dashboard is provisioned automatically at startup via JSON config files mounted as Docker volumes — no manual setup needed.

---

## Nginx

### What is it?
Nginx is a web server and reverse proxy. In SentinelAI, it sits in front of the gateway and:
- Listens on port 80 (the default HTTP port)
- Proxies all requests to `localhost:3000` (the gateway)
- Can terminate SSL (HTTPS) in production

```nginx
server {
  listen 80;
  location / {
    proxy_pass http://gateway:3000;
  }
}
```

The reason for Nginx in front of Fastify: Nginx is battle-hardened at handling slow clients, connection limits, and static file serving. Fastify handles application logic; Nginx handles the network edge.

---

## GitHub Actions

### What is it?
GitHub Actions is GitHub's built-in CI/CD (Continuous Integration / Continuous Deployment) system. You define workflows in YAML files under `.github/workflows/`. GitHub runs them automatically when you push code.

### SentinelAI's Deploy Workflow
```yaml
on:
  push:
    branches: [main]    # trigger on every push to main

jobs:
  deploy:
    steps:
      - uses: appleboy/ssh-action@v1.0.3
        # SSH into the droplet and run:
        # git pull → docker compose build → docker compose up → health check
```

**What `appleboy/ssh-action` does:** it's a Docker-based GitHub Action that establishes an SSH connection to a remote server and runs a script. The SSH key and host IP are stored as GitHub Secrets (not in code).

The deploy pipeline:
```
Push to main
  → GitHub Actions triggers
  → Runner SSHes into DigitalOcean droplet
  → git reset --hard origin/main  (sync code)
  → docker compose up -d --build  (rebuild changed images)
  → curl health check loop         (verify gateway came up)
  → docker compose ps              (print service status)
  → Pass ✓ or Fail ✗
```

---

## Zod

### What is it?
Zod is a TypeScript library for runtime schema validation and type inference.

The problem it solves: TypeScript types only exist at compile time. At runtime, `request.body` is just `unknown` — TypeScript doesn't check that an HTTP request body matches your expected shape.

```typescript
const bodySchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1),
  })).min(1),
  provider: z.enum(['openai', 'anthropic', 'groq', 'mistral', 'cerebras', 'gemini']).optional(),
  session_id: z.string().uuid().optional(),
});

const result = bodySchema.safeParse(request.body);
if (!result.success) {
  return reply.status(400).send({ error: result.error.flatten() });
}
// result.data is now correctly typed — TypeScript knows the shape
const { messages, provider, session_id } = result.data;
```

Zod validates the data at runtime AND infers the TypeScript type from the schema. One definition, two benefits.

It's also used in `config.ts` to validate environment variables at startup — if `DATABASE_URL` is missing, the process exits immediately with a clear error instead of crashing with a confusing error later.

---

## Summary: Why This Stack Together?

| Technology | Role | Why not the alternative? |
|---|---|---|
| Node.js | Runtime | Python works too; Node.js excels at high-concurrency I/O |
| TypeScript | Language | Catches bugs at compile time; excellent with Node.js |
| Fastify | HTTP server | Faster than Express, better TypeScript support |
| PostgreSQL | Database | pgvector + SQL = one DB for everything; Mongo lacks strong schemas |
| Redis | Cache + queues | In-memory speed for rate limiting; BullMQ needs Redis for queues |
| BullMQ | Job queue | Jobs survive restarts; Kafka would be overkill |
| Docker Compose | Orchestration | Simple, reproducible local + prod; Kubernetes is overkill for 1 droplet |
| Nginx | Reverse proxy | Production-hardened network edge; Fastify alone lacks this |
| Prometheus | Metrics | Pull-based, standard, huge ecosystem; integrates with Grafana natively |
| GitHub Actions | CI/CD | Built into GitHub; free for public repos; no separate CI service |
| Zod | Validation | TypeScript-native; one schema = types + runtime validation |
