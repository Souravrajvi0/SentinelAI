import { FastifyPluginAsync } from 'fastify';
import { requireScope } from '../plugins/auth';
import { query } from '../db/client';

const metricsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { days?: string } }>(
    '/metrics',
    async (request, reply) => {
      requireScope(request, 'admin');

      const days = Math.min(parseInt(request.query.days ?? '7'), 90);

      const [dailyStats, topModels, guardrailStats] = await Promise.all([
        // Daily request/cost/token breakdown
        query(
          `SELECT
             date_trunc('day', created_at) AS day,
             COUNT(*) AS total_requests,
             COUNT(*) FILTER (WHERE status = 'success') AS successful,
             COUNT(*) FILTER (WHERE status = 'error') AS errors,
             COUNT(*) FILTER (WHERE status = 'filtered') AS filtered,
             SUM(total_tokens) AS total_tokens,
             SUM(cost_usd) AS total_cost_usd,
             AVG(latency_ms)::int AS avg_latency_ms
           FROM llm_requests
           WHERE tenant_id = $1
             AND created_at >= NOW() - INTERVAL '1 day' * $2
           GROUP BY 1
           ORDER BY 1 DESC`,
          [request.tenantId, days]
        ),

        // Top models by usage
        query(
          `SELECT routed_model, routed_provider,
                  COUNT(*) AS requests, SUM(cost_usd) AS cost_usd
           FROM llm_requests
           WHERE tenant_id = $1
             AND created_at >= NOW() - INTERVAL '1 day' * $2
             AND status = 'success'
           GROUP BY 1, 2
           ORDER BY requests DESC
           LIMIT 10`,
          [request.tenantId, days]
        ),

        // Guardrail summary
        query(
          `SELECT guardrail_action, guardrail_reasons, COUNT(*) AS count
           FROM llm_requests
           WHERE tenant_id = $1
             AND guardrail_triggered = TRUE
             AND created_at >= NOW() - INTERVAL '1 day' * $2
           GROUP BY 1, 2
           ORDER BY count DESC`,
          [request.tenantId, days]
        ),
      ]);

      return reply.send({
        period_days: days,
        daily: dailyStats.rows,
        top_models: topModels.rows,
        guardrails: guardrailStats.rows,
      });
    }
  );
};

export default metricsRoute;
