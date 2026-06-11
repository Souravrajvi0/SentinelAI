import { randomBytes, createHash } from 'crypto';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireScope } from '../plugins/auth';
import { query } from '../db/client';
import { getCacheStats } from '../services/semanticCache';
import { checkBudget } from '../services/budget';
import { writeAudit } from '../services/audit';

const adminRoute: FastifyPluginAsync = async (fastify) => {
  // ── API Key Management ─────────────────────────────────────────────────

  // POST /v1/admin/keys — create a new API key (raw key returned once)
  fastify.post('/admin/keys', async (request, reply) => {
    requireScope(request, 'admin');

    const schema = z.object({
      name: z.string().min(1).max(255),
      scopes: z.array(z.enum(['chat', 'retrieve', 'agent', 'admin'])).min(1),
      rate_limit_rpm: z.number().int().min(1).max(10000).default(60),
      expires_at: z.string().datetime().optional(),
    });

    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });

    const rawKey = randomBytes(32).toString('hex');
    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    const result = await query<{ id: string }>(
      `INSERT INTO api_keys (tenant_id, key_hash, name, scopes, rate_limit_rpm, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [request.tenantId, keyHash, body.data.name, body.data.scopes,
       body.data.rate_limit_rpm, body.data.expires_at ?? null]
    );

    writeAudit({ tenant_id: request.tenantId, actor_type: 'admin', actor_id: request.apiKeyId, action: 'key.created', resource_type: 'api_key', resource_id: result.rows[0]!.id, details: { name: body.data.name, scopes: body.data.scopes } });

    return reply.status(201).send({ id: result.rows[0]!.id, key: rawKey, name: body.data.name, scopes: body.data.scopes });
  });

  // GET /v1/admin/keys — list API keys
  fastify.get('/admin/keys', async (request, reply) => {
    requireScope(request, 'admin');

    const result = await query(
      `SELECT id, name, scopes, rate_limit_rpm, is_active, last_used_at, expires_at, created_at
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [request.tenantId]
    );

    return reply.send({ data: result.rows });
  });

  // DELETE /v1/admin/keys/:id — revoke API key
  fastify.delete<{ Params: { id: string } }>('/admin/keys/:id', async (request, reply) => {
    requireScope(request, 'admin');

    const result = await query(
      `UPDATE api_keys SET is_active = FALSE WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [request.params.id, request.tenantId]
    );

    if (result.rows.length === 0) return reply.status(404).send({ error: 'Key not found' });

    writeAudit({ tenant_id: request.tenantId, actor_type: 'admin', actor_id: request.apiKeyId, action: 'key.revoked', resource_type: 'api_key', resource_id: request.params.id });

    return reply.status(204).send();
  });

  // ── Budget Management ──────────────────────────────────────────────────

  // POST /v1/admin/budget — set or update monthly budget
  fastify.post('/admin/budget', async (request, reply) => {
    requireScope(request, 'admin');

    const schema = z.object({
      monthly_budget_usd: z.number().positive(),
      alert_threshold_pct: z.number().int().min(1).max(100).default(80),
      alert_webhook_url: z.string().url().optional().nullable(),
    });

    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });

    await query(
      `INSERT INTO tenant_budgets (tenant_id, monthly_budget_usd, alert_threshold_pct, alert_webhook_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO UPDATE
         SET monthly_budget_usd = EXCLUDED.monthly_budget_usd,
             alert_threshold_pct = EXCLUDED.alert_threshold_pct,
             alert_webhook_url = EXCLUDED.alert_webhook_url,
             updated_at = NOW()`,
      [request.tenantId, body.data.monthly_budget_usd, body.data.alert_threshold_pct, body.data.alert_webhook_url ?? null]
    );

    const status = await checkBudget(request.tenantId);
    return reply.status(200).send(status);
  });

  // GET /v1/admin/budget — get budget status
  fastify.get('/admin/budget', async (request, reply) => {
    requireScope(request, 'admin');
    const status = await checkBudget(request.tenantId);
    if (!status) return reply.status(404).send({ error: 'No budget configured' });
    return reply.send(status);
  });

  // ── A/B Experiments ────────────────────────────────────────────────────

  // POST /v1/admin/experiments — create experiment
  fastify.post('/admin/experiments', async (request, reply) => {
    requireScope(request, 'admin');

    const schema = z.object({
      name: z.string().min(1).max(100),
      traffic_split: z.number().int().min(1).max(99).default(50),
      control_provider: z.enum(['openai', 'anthropic', 'groq', 'mistral', 'cerebras']),
      control_model: z.string().min(1),
      variant_provider: z.enum(['openai', 'anthropic', 'groq', 'mistral', 'cerebras']),
      variant_model: z.string().min(1),
    });

    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });

    const result = await query<{ id: string }>(
      `INSERT INTO ab_experiments
         (tenant_id, name, traffic_split, control_provider, control_model, variant_provider, variant_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [request.tenantId, body.data.name, body.data.traffic_split,
       body.data.control_provider, body.data.control_model,
       body.data.variant_provider, body.data.variant_model]
    );

    writeAudit({ tenant_id: request.tenantId, actor_type: 'admin', actor_id: request.apiKeyId, action: 'experiment.created', resource_id: result.rows[0]!.id, details: body.data });

    return reply.status(201).send({ id: result.rows[0]!.id, ...body.data, is_active: true });
  });

  // GET /v1/admin/experiments — list experiments
  fastify.get('/admin/experiments', async (request, reply) => {
    requireScope(request, 'admin');

    const result = await query(
      `SELECT id, name, is_active, traffic_split,
              control_provider, control_model, variant_provider, variant_model, created_at
       FROM ab_experiments WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [request.tenantId]
    );

    return reply.send({ data: result.rows });
  });

  // PATCH /v1/admin/experiments/:id — stop or update experiment
  fastify.patch<{ Params: { id: string } }>('/admin/experiments/:id', async (request, reply) => {
    requireScope(request, 'admin');

    const schema = z.object({ is_active: z.boolean(), traffic_split: z.number().int().min(1).max(99).optional() });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });

    const result = await query(
      `UPDATE ab_experiments
       SET is_active = $3,
           traffic_split = COALESCE($4, traffic_split)
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, name, is_active, traffic_split`,
      [request.params.id, request.tenantId, body.data.is_active, body.data.traffic_split ?? null]
    );

    if (result.rows.length === 0) return reply.status(404).send({ error: 'Experiment not found' });

    if (!body.data.is_active) {
      writeAudit({ tenant_id: request.tenantId, actor_type: 'admin', actor_id: request.apiKeyId, action: 'experiment.stopped', resource_id: request.params.id });
    }

    return reply.send(result.rows[0]);
  });

  // ── Semantic Cache ─────────────────────────────────────────────────────

  // GET /v1/admin/cache/stats — cache statistics
  fastify.get('/admin/cache/stats', async (request, reply) => {
    requireScope(request, 'admin');
    const stats = await getCacheStats(request.tenantId);
    return reply.send(stats);
  });

  // DELETE /v1/admin/cache — clear all cached entries for this tenant
  fastify.delete('/admin/cache', async (request, reply) => {
    requireScope(request, 'admin');
    const result = await query(
      `DELETE FROM semantic_cache WHERE tenant_id = $1 RETURNING id`,
      [request.tenantId]
    );
    return reply.send({ deleted: result.rows.length });
  });
};

export default adminRoute;
