# 06 — Interview Q&A

Real questions an interviewer will ask about this project. Answers you can say out loud.

---

## Architecture Questions

**Q: Walk me through what happens when I call POST /v1/chat.**

A: The request hits Nginx on port 80, which proxies to Fastify on port 3000. The auth plugin SHA-256 hashes the API key and looks it up in the database — 401 if not found. The rate limiter checks Redis to see how many requests this tenant has made this minute. Then guardrails scan for prompt injection and PII, blocking if found. If a budget is set, we check monthly spend — 402 if exceeded. For non-session, non-RAG requests we check the semantic cache using pgvector cosine similarity. Then the router picks a provider and model based on rules and any active A/B experiment. If a session_id is provided, we load history from the database and apply the context guard. If RAG is enabled, we run hybrid search — vector plus full-text — and inject the top chunks as a system message. Then we call the LLM with retry and fallback logic. After the response, we persist the request record, fire trace spans and eval job asynchronously, save the session if needed, and return the response to the client.

---

**Q: Why did you use PostgreSQL for vector storage instead of a dedicated vector database like Pinecone?**

A: For the scale this project operates at — hundreds of thousands of document chunks — pgvector with an IVFFlat index is plenty fast. Millisecond query times are achievable. The benefit is operational simplicity: one database for everything. The vector search joins directly with the documents table and the tenants table in a single SQL query. With Pinecone, you'd need to make a separate API call to retrieve vectors, then a separate database query to get the metadata. You also add another external dependency, another billing account, another failure mode. Dedicated vector databases become worth the complexity at tens of millions of vectors with high concurrent query load — not at this scale.

---

**Q: How does your retry logic prevent making things worse during an outage?**

A: Exponential backoff with jitter. The first retry waits 100ms, the second 200ms, the third 400ms. Each has up to 50ms of random jitter added. The jitter is the critical part — if every client retries at exactly 100ms, 200ms, 400ms, you get synchronized bursts of traffic hitting the provider at the same moments. The random jitter spreads those retries across time, reducing the peak load on the provider. This is called the "thundering herd" problem and it's a standard pattern in distributed systems. After 3 attempts, we try a configured fallback provider rather than continuing to hammer the primary.

---

**Q: How do you handle multi-tenancy? How does tenant A's data not leak to tenant B?**

A: Shared schema with tenant isolation at the application layer. Every table that contains per-tenant data has a `tenant_id UUID` column, and every query includes `WHERE tenant_id = $tenantId`. The `tenantId` comes from the authenticated API key — it's set once at auth time and attached to the request object. There's no way for a tenant to query another tenant's data because the gateway always uses the authenticated tenant's ID. For stronger isolation, a production version could use PostgreSQL row security policies (RLS) as a second layer — database-enforced, not just application-enforced.

---

## AI / ML Concept Questions

**Q: What is RAG and why is it better than fine-tuning for this use case?**

A: RAG stands for Retrieval Augmented Generation. Instead of retraining the model on your data, you retrieve the relevant documents at query time and inject them into the prompt. Fine-tuning bakes knowledge into model weights — it's expensive, requires a training run, and the knowledge gets stale as documents update. RAG is cheap (just embeddings and search), always uses the latest version of your documents, and you can add or remove documents without touching the model. For a use case like "answer questions about company documents" that changes frequently, RAG is almost always the right choice. Fine-tuning is better for changing the model's behavior or style — teaching it to always respond in a certain format, for example — not for knowledge retrieval.

---

**Q: Explain how your hybrid search works. Why not just vector search?**

A: Pure vector search finds semantically similar documents — great for paraphrased queries, but it can miss exact matches. If someone searches for "JIRA-4521" or a specific product SKU, the vector might not place it close to the query because those strings have no semantic meaning. Keyword search handles exact terms precisely. We run both in parallel — pgvector cosine search and PostgreSQL tsvector full-text search — and merge the results using Reciprocal Rank Fusion. The RRF score for each document is the sum of `1 / (60 + rank)` from each list. A document appearing high in both lists scores higher than one appearing top in just one. The k=60 constant is a smoothing factor that prevents the top result of one list from completely dominating when there are few results. This is the same approach used by Elasticsearch's hybrid search and several academic retrieval systems.

---

**Q: What is semantic caching and when does it not work?**

A: Semantic caching stores LLM responses keyed by an embedding of the query. For a new query, we compute its embedding and check for a cached entry with cosine similarity above 0.95. "What is the capital of France?" and "What's France's capital?" map to nearly identical vectors and hit the same cache entry. The limitation: it only works for queries that are truly equivalent in meaning. A 0.95 threshold is quite tight — "What is the refund policy?" and "Can I get a refund?" would likely score around 0.87 and miss the cache. I also disable the cache for session-based queries because those depend on conversation context — the same question means something different in two different conversations. And for RAG queries, because the answer depends on the specific documents in your database, not just the query text.

---

**Q: How does the context guard work? What if the summarization itself fails?**

A: When a session's total token estimate exceeds 75% of the model's context limit, we take all turns except the last four, send them to a fast cheap model (llama-3.1-8b-instant) with a summarization prompt, and store the summary plus the four fresh turns. On the next request, the summary is injected as a system message before the fresh turns. The 75% threshold leaves room for the incoming message and the model's response — we don't wait until 100% because by then the next request would already fail. If the summarization call itself fails — network error, model unavailable — we have a fallback: hard truncate to the last 8 turns (4 * 2). It's less graceful but keeps the session alive. The `was_summarized` flag in the response tells the caller when compression happened.

---

## Engineering / Production Questions

**Q: What bugs did you encounter and how did you debug them?**

A: Three stand out. First, Groq decommissioned `llama3-8b-8192` while the project was live. Multi-turn sessions started failing silently — session memory appeared broken, but the root cause was an A/B experiment routing turn 2 to the decommissioned model. Found it by reading gateway logs and seeing `model_decommissioned` error on the second request. Fixed by updating the model in code and in the live A/B experiment row in the database.

Second, a stray file during manual deployment. I accidentally `scp`'d `chat.ts` to the wrong directory. TypeScript found two copies and reported a cascade of "Cannot find module" errors for the entire codebase. Took 15 minutes of directory listing to find the extra file sitting at the wrong level.

Third, PostgreSQL's `ON CONFLICT DO NOTHING` requires an explicit conflict target column. Without it, Postgres raises an error. The eval worker was crashing on every job because the `eval_results` table had no `UNIQUE` constraint yet. The fix required both adding the constraint and specifying the column in the query.

---

**Q: Why is the eval worker async? What if it's wrong?**

A: It's async because evaluation requires an LLM call — a 500-2000ms round trip. Adding that to every client response would be unacceptable latency. The client doesn't need the eval score to use the response. If the eval worker crashes or gives a wrong score, the client experience is completely unaffected. The score is stored separately and used for analytics and regression detection, not for anything that affects the actual API response. If the eval queue gets backed up during high traffic, BullMQ queues the jobs and processes them when load drops. If a job fails permanently, it lands in the "failed" state in BullMQ and can be manually retried or inspected.

---

**Q: How would you scale this system if traffic grew 100x?**

A: The gateway is stateless (all state is in Postgres and Redis), so you can run multiple gateway instances behind Nginx with load balancing. Redis rate limiting works correctly with multiple instances because all instances share the same Redis counter. The ingestion and eval workers can scale horizontally too — BullMQ handles concurrent consumers on the same queue without duplicate processing. The bottleneck at scale would likely be PostgreSQL, specifically the vector search. Solutions: increase the IVFFlat lists parameter for more index partitions, add read replicas for query-heavy workloads, or at very large scale, migrate to a dedicated vector database. Redis would need a cluster setup if rate limiting becomes a bottleneck. The Nginx layer would need to be replaced with a load balancer (AWS ALB, or multiple Nginx instances) if a single proxy becomes the bottleneck.

---

**Q: Why did you use BullMQ instead of something like Kafka?**

A: Kafka is designed for high-throughput event streaming at millions of events per second with complex consumer group semantics and long retention. BullMQ on Redis is simpler, requires no separate infrastructure beyond Redis (which we already had for rate limiting), and handles job retries and dead-letter queues out of the box. For an eval worker processing maybe hundreds to low thousands of jobs per day, Kafka would be massive overkill. The rule of thumb: use a message queue (BullMQ, RabbitMQ) for job processing; use Kafka for event streaming and log aggregation.

---

**Q: What would you add next to make this production-ready?**

A: A few things. First, a proper database migration tool — right now schema changes require manually running `ALTER TABLE` on the live database. Flyway or golang-migrate would track which migrations have run. Second, row-level security in PostgreSQL as a second isolation layer — currently tenant isolation is enforced only in application code, which means a bug in the gateway could potentially expose cross-tenant data. Third, a proper secrets manager (Vault, AWS Secrets Manager) instead of environment variables for API keys — keys should rotate without a restart. Fourth, distributed tracing export to an external system (Jaeger, Grafana Tempo) — right now traces are queryable only via the `/traces` API, but connecting to an external system would allow richer analysis. Fifth, circuit breaker pattern for LLM providers — instead of just retrying, track failure rates per provider and stop sending traffic to a provider that's clearly down, failing fast instead of queuing up retries.

---

## "Tell Me About Yourself" Style Questions

**Q: How long did this take to build?**

A: The core gateway with routing, auth, and basic LLM calls was working in the first few days. The harder features — hybrid search with RRF, semantic cache, conversation memory with context guard, A/B experiments — each took a day or two to design and implement correctly. Getting observability (traces, Prometheus, Grafana) right and deploying everything to production with CI/CD added another few days. The debugging and fixes along the way were the most time-consuming parts — the stray file deployment bug, the Postgres ON CONFLICT issue, the model decommission — but also the most instructive.

**Q: What was the hardest part?**

A: The conversation memory + context guard. Getting the session design right required thinking through several edge cases: what happens when the client sends history the server already has? (Server-side management — client sends only new message.) What happens when context guard summarizes, but the summarization call itself fails? (Fallback to hard truncation.) When should cache be skipped for sessions? (Always — context-dependent questions can't be cached by question text alone.) The interaction between these features required a clear mental model of what state lives where before writing any code.
