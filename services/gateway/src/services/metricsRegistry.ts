import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: 'sentinelai_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

export const llmRequestsTotal = new Counter({
  name: 'sentinelai_llm_requests_total',
  help: 'Total LLM requests',
  labelNames: ['provider', 'model', 'status'],
  registers: [registry],
});

export const llmLatencySeconds = new Histogram({
  name: 'sentinelai_llm_latency_seconds',
  help: 'LLM request latency in seconds',
  labelNames: ['provider', 'model'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const llmTokensTotal = new Counter({
  name: 'sentinelai_llm_tokens_total',
  help: 'Total LLM tokens used',
  labelNames: ['provider', 'model', 'type'],
  registers: [registry],
});

export const llmCostUsdTotal = new Counter({
  name: 'sentinelai_llm_cost_usd_total',
  help: 'Total LLM cost in USD',
  labelNames: ['provider', 'model'],
  registers: [registry],
});

export const guardrailsTriggeredTotal = new Counter({
  name: 'sentinelai_guardrails_triggered_total',
  help: 'Total guardrail triggers',
  labelNames: ['action', 'reason'],
  registers: [registry],
});
