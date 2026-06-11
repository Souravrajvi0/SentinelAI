import { createHash } from 'crypto';
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { query } from '../db/client';

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  scopes: string[];
  rate_limit_rpm: number;
  rate_limit_tpm: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    apiKeyId: string;
    scopes: string[];
    rateLimitRpm: number;
  }
  interface FastifyInstance {
    verifyApiKey: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate('verifyApiKey', async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers['x-api-key'] as string | undefined;
    if (!header) {
      reply.status(401).send({ error: 'Missing X-Api-Key header' });
      return;
    }

    const keyHash = createHash('sha256').update(header).digest('hex');

    const result = await query<ApiKeyRow>(
      `SELECT k.id, k.tenant_id, k.scopes, k.rate_limit_rpm, k.rate_limit_tpm
       FROM api_keys k
       WHERE k.key_hash = $1
         AND k.is_active = TRUE
         AND (k.expires_at IS NULL OR k.expires_at > NOW())`,
      [keyHash]
    );

    if (result.rows.length === 0) {
      reply.status(401).send({ error: 'Invalid or expired API key' });
      return;
    }

    const key = result.rows[0]!;
    request.tenantId = key.tenant_id;
    request.apiKeyId = key.id;
    request.scopes = key.scopes;
    request.rateLimitRpm = key.rate_limit_rpm;

    query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [key.id]).catch(() => {});
  });
};

export default fp(authPlugin, { name: 'auth' });

export function requireScope(request: FastifyRequest, scope: string): void {
  if (!request.scopes.includes(scope) && !request.scopes.includes('admin')) {
    const err = new Error(`Scope '${scope}' required`) as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
}
