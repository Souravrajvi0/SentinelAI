// ─── LLM Providers ───────────────────────────────────────────────────────────

export type Provider = 'openai' | 'anthropic' | 'groq' | 'mistral' | 'cerebras' | 'gemini';

export type RequestMode = 'chat' | 'rag' | 'agent';

export type RequestStatus = 'pending' | 'success' | 'error' | 'filtered';

export type GuardrailAction = 'blocked' | 'flagged' | 'redacted';

// ─── Chat ────────────────────────────────────────────────────────────────────

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: Message[];
  model?: string;
  provider?: Provider;
  stream?: boolean;
  session_id?: string;
  metadata?: Record<string, unknown>;
  // RAG options
  rag?: {
    enabled: boolean;
    top_k?: number;
    score_threshold?: number;
  };
}

export interface ChatResponse {
  id: string;
  trace_id: string;
  content: string;
  model: string;
  provider: Provider;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd: number;
  };
  latency_ms: number;
  citations?: Citation[];
}

// ─── Retrieval ───────────────────────────────────────────────────────────────

export interface RetrieveRequest {
  query: string;
  top_k?: number;
  score_threshold?: number;
  metadata_filter?: Record<string, unknown>;
}

export interface Citation {
  chunk_id: string;
  document_id: string;
  document_title?: string;
  content_preview: string;
  score: number;
}

export interface RetrieveResponse {
  query: string;
  results: Citation[];
  latency_ms: number;
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface AgentRequest {
  goal: string;
  tools?: Tool[];
  max_steps?: number;
  model?: string;
  session_id?: string;
}

export interface AgentStep {
  step: number;
  type: 'thought' | 'tool_call' | 'tool_result' | 'answer';
  content: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  latency_ms?: number;
}

export interface AgentResponse {
  id: string;
  trace_id: string;
  answer: string;
  steps: AgentStep[];
  total_latency_ms: number;
  usage: {
    total_tokens: number;
    cost_usd: number;
  };
}

// ─── Tracing ─────────────────────────────────────────────────────────────────

export interface SpanAttributes {
  [key: string]: string | number | boolean | null;
}

export interface TraceSpan {
  id: string;
  trace_id: string;
  parent_id?: string;
  name: string;
  kind: 'server' | 'client' | 'internal' | 'producer' | 'consumer';
  start_time: string;
  end_time?: string;
  duration_ms?: number;
  status: 'ok' | 'error' | 'unset';
  status_msg?: string;
  attributes: SpanAttributes;
}

// ─── Ingestion Queue Jobs ────────────────────────────────────────────────────

export interface IngestJobData {
  document_id: string;
  tenant_id: string;
  source_url?: string;
  raw_text?: string;
  mime_type: string;
}

// ─── Eval Queue Jobs ─────────────────────────────────────────────────────────

export interface EvalJobData {
  request_id: string;
  tenant_id: string;
  prompt: string;
  response: string;
  retrieved_chunks?: Citation[];
  mode: RequestMode;
}
