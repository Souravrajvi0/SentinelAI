import { randomUUID } from 'crypto';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireScope } from '../plugins/auth';
import { runAgent } from '../services/agentRuntime';
import { query, pool } from '../db/client';
import { writeAudit } from '../services/audit';
import { config } from '../config';

const bodySchema = z.object({
  goal: z.string().min(1).max(2000),
  max_steps: z.number().int().min(1).max(10).default(5),
  model: z.string().optional(),
  session_id: z.string().uuid().optional(),
  stream: z.boolean().optional().default(false),
});

const agentRoute: FastifyPluginAsync = async (_fastify) => {
  _fastify.post('/agent', async (request, reply) => {
    requireScope(request, 'agent');

    const body = bodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() });
    }

    const { goal, max_steps, model, session_id, stream } = body.data;
    const traceId = randomUUID();
    const requestId = randomUUID();
    const start = Date.now();

    // ── Streaming path ─────────────────────────────────────────────────────
    if (stream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Trace-Id': traceId,
      });

      const result = await runAgent({
        goal,
        model: model ?? config.DEFAULT_MODEL,
        maxSteps: max_steps,
        tenantId: request.tenantId,
        pool,
        onStep: (step) => {
          reply.raw.write(`data: ${JSON.stringify({ type: 'step', step })}\n\n`);
        },
      });

      reply.raw.write(`data: ${JSON.stringify({ type: 'done', answer: result.answer, usage: { total_tokens: result.total_tokens, cost_usd: result.total_cost_usd } })}\n\n`);
      reply.raw.end();

      const latencyMs = Date.now() - start;
      query(
        `INSERT INTO llm_requests
           (id, tenant_id, api_key_id, trace_id, session_id, mode, status,
            prompt_preview, response_preview, routed_provider, routed_model,
            total_tokens, latency_ms, http_status)
         VALUES ($1,$2,$3,$4,$5,'agent','success',$6,$7,$8,$9,$10,$11,200)`,
        [requestId, request.tenantId, request.apiKeyId, traceId, session_id ?? null,
         goal.slice(0, 500), result.answer.slice(0, 500),
         config.DEFAULT_PROVIDER, model ?? config.DEFAULT_MODEL,
         result.total_tokens, latencyMs]
      ).catch(() => {});

      writeAudit({ tenant_id: request.tenantId, actor_type: 'api_key', actor_id: request.apiKeyId, action: 'request.created', resource_id: requestId, details: { mode: 'agent', stream: true, steps: result.steps.length } });
      return;
    }

    // ── Non-streaming path ─────────────────────────────────────────────────
    const result = await runAgent({
      goal,
      model: model ?? config.DEFAULT_MODEL,
      maxSteps: max_steps,
      tenantId: request.tenantId,
      pool,
    });

    const latencyMs = Date.now() - start;

    await query(
      `INSERT INTO llm_requests
         (id, tenant_id, api_key_id, trace_id, session_id, mode, status,
          prompt_preview, response_preview, routed_provider, routed_model,
          total_tokens, latency_ms, http_status)
       VALUES ($1,$2,$3,$4,$5,'agent','success',$6,$7,$8,$9,$10,$11,200)`,
      [requestId, request.tenantId, request.apiKeyId, traceId, session_id ?? null,
       goal.slice(0, 500), result.answer.slice(0, 500),
       config.DEFAULT_PROVIDER, model ?? config.DEFAULT_MODEL,
       result.total_tokens, latencyMs]
    );

    writeAudit({ tenant_id: request.tenantId, actor_type: 'api_key', actor_id: request.apiKeyId, action: 'request.created', resource_id: requestId, details: { mode: 'agent', steps: result.steps.length } });

    return reply.send({
      id: requestId,
      trace_id: traceId,
      answer: result.answer,
      steps: result.steps,
      total_latency_ms: latencyMs,
      usage: {
        total_tokens: result.total_tokens,
        cost_usd: result.total_cost_usd,
      },
    });
  });
};

export default agentRoute;
