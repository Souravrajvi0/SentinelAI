import { FastifyPluginAsync } from 'fastify';
import { requireScope } from '../plugins/auth';
import { query } from '../db/client';

const tracesRoute: FastifyPluginAsync = async (fastify) => {
  // GET /traces/:traceId — full trace with all spans
  fastify.get<{ Params: { traceId: string } }>(
    '/traces/:traceId',
    async (request, reply) => {
      requireScope(request, 'admin');

      const { traceId } = request.params;

      const [reqResult, spanResult] = await Promise.all([
        query(
          `SELECT * FROM llm_requests
           WHERE trace_id = $1 AND tenant_id = $2
           ORDER BY created_at ASC`,
          [traceId, request.tenantId]
        ),
        query(
          `SELECT * FROM trace_spans
           WHERE trace_id = $1 AND tenant_id = $2
           ORDER BY start_time ASC`,
          [traceId, request.tenantId]
        ),
      ]);

      if (reqResult.rows.length === 0) {
        return reply.status(404).send({ error: 'Trace not found' });
      }

      return reply.send({
        trace_id: traceId,
        requests: reqResult.rows,
        spans: spanResult.rows,
      });
    }
  );

  // GET /requests — paginated request history
  fastify.get<{
    Querystring: { limit?: string; offset?: string; status?: string };
  }>('/requests', async (request, reply) => {
    requireScope(request, 'admin');

    const limit = Math.min(parseInt(request.query.limit ?? '20'), 100);
    const offset = parseInt(request.query.offset ?? '0');
    const status = request.query.status;

    const VALID_STATUSES = new Set(['pending', 'success', 'error', 'filtered']);
    if (status && !VALID_STATUSES.has(status)) {
      return reply.status(400).send({ error: 'Invalid status value' });
    }

    const params: unknown[] = [request.tenantId, limit, offset];
    let statusClause = '';
    if (status) {
      params.push(status);
      statusClause = `AND status = $${params.length}`;
    }

    const result = await query(
      `SELECT id, trace_id, mode, status, routed_provider, routed_model,
              total_tokens, cost_usd, latency_ms, guardrail_triggered,
              created_at
       FROM llm_requests
       WHERE tenant_id = $1
         ${statusClause}
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      params
    );

    return reply.send({ data: result.rows, limit, offset });
  });

  // GET /audit-logs — paginated audit log
  fastify.get<{
    Querystring: { limit?: string; offset?: string; action?: string };
  }>('/audit-logs', async (request, reply) => {
    requireScope(request, 'admin');

    const limit = Math.min(parseInt(request.query.limit ?? '50'), 200);
    const offset = parseInt(request.query.offset ?? '0');
    const action = request.query.action;

    const params: unknown[] = [request.tenantId, limit, offset];
    let actionClause = '';
    if (action) {
      params.push(action);
      actionClause = `AND action = $${params.length}`;
    }

    const result = await query(
      `SELECT id, actor_type, actor_id, action, resource_type, resource_id,
              ip_address, details, created_at
       FROM audit_logs
       WHERE tenant_id = $1
         ${actionClause}
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      params
    );

    return reply.send({ data: result.rows, limit, offset });
  });
};

export default tracesRoute;
