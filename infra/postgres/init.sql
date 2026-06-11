-- SentinelAI PostgreSQL Schema
-- Run once on fresh database; Docker init.d handles this automatically

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ─────────────────────────────────────────────
-- TENANTS & AUTH
-- ─────────────────────────────────────────────

CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(255) NOT NULL,
  slug        VARCHAR(100) UNIQUE NOT NULL,
  plan        VARCHAR(50) NOT NULL DEFAULT 'free', -- free | pro | enterprise
  settings    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash        VARCHAR(64) UNIQUE NOT NULL, -- SHA-256 of raw key; raw key never stored
  name            VARCHAR(255),
  scopes          TEXT[] NOT NULL DEFAULT '{}', -- ['chat', 'retrieve', 'agent', 'admin']
  rate_limit_rpm  INTEGER NOT NULL DEFAULT 60,
  rate_limit_tpm  INTEGER NOT NULL DEFAULT 100000,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- REQUEST TRACES
-- ─────────────────────────────────────────────

CREATE TABLE llm_requests (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  api_key_id          UUID REFERENCES api_keys(id),
  trace_id            UUID NOT NULL,
  session_id          UUID,

  -- What was asked
  mode                VARCHAR(20) NOT NULL DEFAULT 'chat', -- chat | rag | agent
  prompt_preview      TEXT,           -- first 500 chars of prompt (for debugging)
  response_preview    TEXT,           -- first 500 chars of response

  -- Routing
  requested_model     VARCHAR(100),
  routed_provider     VARCHAR(50) NOT NULL,  -- openai | anthropic | groq | gemini
  routed_model        VARCHAR(100) NOT NULL,
  fallback_used       BOOLEAN NOT NULL DEFAULT FALSE,

  -- Token & cost accounting
  prompt_tokens       INTEGER,
  completion_tokens   INTEGER,
  total_tokens        INTEGER,
  cost_usd            NUMERIC(10, 8),

  -- Timing
  latency_ms          INTEGER,
  ttfb_ms             INTEGER,

  -- Outcome
  status              VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | success | error | filtered
  error_code          VARCHAR(100),
  error_message       TEXT,
  http_status         SMALLINT,

  -- Security / guardrails
  guardrail_triggered  BOOLEAN NOT NULL DEFAULT FALSE,
  guardrail_action     VARCHAR(50),   -- blocked | flagged | redacted
  guardrail_reasons    TEXT[],

  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- OpenTelemetry-style spans — one request produces multiple spans
CREATE TABLE trace_spans (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trace_id      UUID NOT NULL,
  parent_id     UUID,               -- null = root span
  request_id    UUID REFERENCES llm_requests(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),

  name          VARCHAR(255) NOT NULL, -- e.g. "gateway.auth", "retrieval.search", "llm.completion"
  kind          VARCHAR(20) NOT NULL DEFAULT 'internal', -- server | client | internal | producer | consumer

  start_time    TIMESTAMPTZ NOT NULL,
  end_time      TIMESTAMPTZ,
  duration_ms   INTEGER,

  status        VARCHAR(10) NOT NULL DEFAULT 'ok',  -- ok | error | unset
  status_msg    TEXT,

  attributes    JSONB NOT NULL DEFAULT '{}',  -- arbitrary KV pairs
  events        JSONB NOT NULL DEFAULT '[]',  -- [{name, timestamp, attributes}]

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- DOCUMENTS & RETRIEVAL (RAG)
-- ─────────────────────────────────────────────

CREATE TABLE documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  title           VARCHAR(500),
  source_url      TEXT,
  source_type     VARCHAR(50) NOT NULL DEFAULT 'upload', -- upload | url | api
  mime_type       VARCHAR(100),
  file_size_bytes INTEGER,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | processing | indexed | failed
  error_message   TEXT,
  chunk_count     INTEGER,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  indexed_at      TIMESTAMPTZ
);

CREATE TABLE document_chunks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  chunk_index     INTEGER NOT NULL,
  content         TEXT NOT NULL,
  content_tokens  INTEGER,
  embedding       vector(1024),    -- Mistral mistral-embed dimensions
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (document_id, chunk_index)
);

-- Log what was retrieved for each RAG request (for debugging + eval)
CREATE TABLE retrieval_results (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id      UUID NOT NULL REFERENCES llm_requests(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  query_text      TEXT NOT NULL,
  chunks_returned INTEGER NOT NULL DEFAULT 0,
  top_score       NUMERIC(5, 4),
  results         JSONB NOT NULL DEFAULT '[]',  -- [{chunk_id, score, content_preview, document_title}]
  latency_ms      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- EVALUATION
-- ─────────────────────────────────────────────

CREATE TABLE eval_results (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id            UUID NOT NULL REFERENCES llm_requests(id) ON DELETE CASCADE UNIQUE,
  tenant_id             UUID NOT NULL REFERENCES tenants(id),

  faithfulness_score    NUMERIC(4, 3),  -- 0.0–1.0: answer grounded in retrieved context?
  relevance_score       NUMERIC(4, 3),  -- 0.0–1.0: answer relevant to question?
  coherence_score       NUMERIC(4, 3),  -- 0.0–1.0: is the answer well-formed?

  hallucination_detected  BOOLEAN NOT NULL DEFAULT FALSE,
  regression_detected     BOOLEAN NOT NULL DEFAULT FALSE,

  eval_model            VARCHAR(100),
  eval_latency_ms       INTEGER,
  raw_eval_output       JSONB,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- AUDIT & METRICS
-- ─────────────────────────────────────────────

-- Append-only audit trail — no UPDATE or DELETE allowed on this table
CREATE TABLE audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID REFERENCES tenants(id),
  actor_type    VARCHAR(50),   -- api_key | system | admin
  actor_id      VARCHAR(255),
  action        VARCHAR(100) NOT NULL, -- request.created | key.created | policy.triggered | doc.indexed …
  resource_type VARCHAR(100),
  resource_id   VARCHAR(255),
  ip_address    INET,
  user_agent    TEXT,
  details       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pre-aggregated daily rollups for fast dashboard queries
CREATE TABLE metrics_daily (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  date                DATE NOT NULL,
  provider            VARCHAR(50) NOT NULL,
  model               VARCHAR(100) NOT NULL,

  total_requests      INTEGER NOT NULL DEFAULT 0,
  successful_requests INTEGER NOT NULL DEFAULT 0,
  failed_requests     INTEGER NOT NULL DEFAULT 0,
  filtered_requests   INTEGER NOT NULL DEFAULT 0,

  total_tokens        BIGINT NOT NULL DEFAULT 0,
  total_cost_usd      NUMERIC(12, 6) NOT NULL DEFAULT 0,

  avg_latency_ms      INTEGER,
  p95_latency_ms      INTEGER,
  p99_latency_ms      INTEGER,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, date, provider, model)
);

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────

-- Hot query paths on llm_requests
CREATE INDEX idx_llm_requests_tenant_created   ON llm_requests (tenant_id, created_at DESC);
CREATE INDEX idx_llm_requests_trace_id         ON llm_requests (trace_id);
CREATE INDEX idx_llm_requests_session_id       ON llm_requests (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_llm_requests_status           ON llm_requests (tenant_id, status, created_at DESC);

-- Trace spans lookups
CREATE INDEX idx_trace_spans_trace_id          ON trace_spans (trace_id);
CREATE INDEX idx_trace_spans_request_id        ON trace_spans (request_id);

-- Document retrieval
CREATE INDEX idx_document_chunks_document_id   ON document_chunks (document_id);
CREATE INDEX idx_document_chunks_tenant_id     ON document_chunks (tenant_id);
-- IVFFlat index for approximate nearest-neighbor vector search
CREATE INDEX idx_document_chunks_embedding     ON document_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- API key lookups
CREATE INDEX idx_api_keys_tenant_id            ON api_keys (tenant_id);

-- Audit log queries
CREATE INDEX idx_audit_logs_tenant_created     ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX idx_audit_logs_action             ON audit_logs (action, created_at DESC);

-- Metrics dashboard
CREATE INDEX idx_metrics_daily_tenant_date     ON metrics_daily (tenant_id, date DESC);

-- ─────────────────────────────────────────────
-- CONVERSATION SESSIONS (server-side memory)
-- ─────────────────────────────────────────────

CREATE TABLE conversation_sessions (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id   UUID NOT NULL,
  messages     JSONB NOT NULL DEFAULT '[]',  -- array of {role, content}
  summary      TEXT,                          -- compressed older turns
  token_count  INTEGER NOT NULL DEFAULT 0,
  turn_count   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, session_id)
);

CREATE INDEX idx_conversation_sessions_tenant ON conversation_sessions (tenant_id, updated_at DESC);

-- ─────────────────────────────────────────────
-- SEMANTIC CACHE
-- ─────────────────────────────────────────────

CREATE TABLE semantic_cache (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  query_embedding vector(1024) NOT NULL,
  query_text      TEXT NOT NULL,
  response_text   TEXT NOT NULL,
  model           VARCHAR(100) NOT NULL,
  provider        VARCHAR(50) NOT NULL,
  hit_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX idx_semantic_cache_tenant_expires ON semantic_cache (tenant_id, expires_at);
CREATE INDEX idx_semantic_cache_embedding ON semantic_cache USING ivfflat (query_embedding vector_cosine_ops) WITH (lists = 50);

-- ─────────────────────────────────────────────
-- TENANT BUDGETS
-- ─────────────────────────────────────────────

CREATE TABLE tenant_budgets (
  tenant_id           UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  monthly_budget_usd  NUMERIC(10, 4) NOT NULL,
  alert_threshold_pct INTEGER NOT NULL DEFAULT 80,
  alert_webhook_url   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- A/B EXPERIMENTS
-- ─────────────────────────────────────────────

CREATE TABLE ab_experiments (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              VARCHAR(100) NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  traffic_split     INTEGER NOT NULL DEFAULT 50,  -- % routed to variant (0-100)
  control_provider  VARCHAR(50) NOT NULL,
  control_model     VARCHAR(100) NOT NULL,
  variant_provider  VARCHAR(50) NOT NULL,
  variant_model     VARCHAR(100) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX idx_ab_experiments_tenant_active ON ab_experiments (tenant_id) WHERE is_active = TRUE;

-- Hybrid search: generated tsvector column on document chunks
ALTER TABLE document_chunks ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX idx_document_chunks_tsv ON document_chunks USING gin(content_tsv);

-- ─────────────────────────────────────────────
-- SEED: default tenant for local dev
-- ─────────────────────────────────────────────

INSERT INTO tenants (id, name, slug, plan)
VALUES ('00000000-0000-0000-0000-000000000001', 'Dev Tenant', 'dev', 'pro');

-- API key "sentinel-dev-key" → hash of literal string for local testing only
-- In production, raw keys are generated and only the SHA-256 hash is stored
INSERT INTO api_keys (tenant_id, key_hash, name, scopes, rate_limit_rpm)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  encode(sha256('sentinel-dev-key'::bytea), 'hex'),
  'Dev Key',
  ARRAY['chat', 'retrieve', 'agent', 'admin'],
  1000
);
