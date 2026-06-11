import { randomUUID } from 'crypto';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Queue } from 'bullmq';
import { requireScope } from '../plugins/auth';
import { query } from '../db/client';
import { QUEUES, type IngestJobData } from '@sentinelai/shared';
import { config } from '../config';

const createBodySchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  source_url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const documentsRoute: FastifyPluginAsync = async (_fastify) => {
  const ingestQueue = new Queue(QUEUES.INGEST, {
    connection: { url: config.REDIS_URL },
  });

  // POST /v1/documents — ingest a document
  _fastify.post('/documents', async (request, reply) => {
    requireScope(request, 'retrieve');

    const body = createBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() });
    }

    const { title, content, source_url, metadata } = body.data;
    const documentId = randomUUID();

    await query(
      `INSERT INTO documents (id, tenant_id, title, source_url, source_type, status, metadata)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
      [
        documentId,
        request.tenantId,
        title,
        source_url ?? null,
        source_url ? 'url' : 'upload',
        JSON.stringify(metadata ?? {}),
      ]
    );

    const job: IngestJobData = {
      document_id: documentId,
      tenant_id: request.tenantId,
      raw_text: content,
      mime_type: 'text/plain',
    };

    await ingestQueue.add('ingest', job, { removeOnComplete: 100, removeOnFail: 50 });

    return reply.status(202).send({
      id: documentId,
      status: 'pending',
      message: 'Document queued for ingestion',
    });
  });

  // GET /v1/documents — list documents
  _fastify.get<{ Querystring: { limit?: string; offset?: string; status?: string } }>(
    '/documents',
    async (request, reply) => {
      requireScope(request, 'retrieve');

      const limit = Math.min(parseInt(request.query.limit ?? '20'), 100);
      const offset = parseInt(request.query.offset ?? '0');
      const status = request.query.status;

      const VALID_STATUSES = new Set(['pending', 'processing', 'indexed', 'failed']);
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
        `SELECT id, title, source_type, status, chunk_count, error_message, created_at, indexed_at
         FROM documents
         WHERE tenant_id = $1
           ${statusClause}
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        params
      );

      return reply.send({ data: result.rows, limit, offset });
    }
  );

  // GET /v1/documents/:id — get single document status
  _fastify.get<{ Params: { id: string } }>(
    '/documents/:id',
    async (request, reply) => {
      requireScope(request, 'retrieve');

      const result = await query(
        `SELECT id, title, source_type, status, chunk_count, error_message, created_at, indexed_at
         FROM documents WHERE id = $1 AND tenant_id = $2`,
        [request.params.id, request.tenantId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Document not found' });
      }

      return reply.send(result.rows[0]);
    }
  );

  // DELETE /v1/documents/:id
  _fastify.delete<{ Params: { id: string } }>(
    '/documents/:id',
    async (request, reply) => {
      requireScope(request, 'retrieve');

      const result = await query(
        `DELETE FROM documents WHERE id = $1 AND tenant_id = $2 RETURNING id`,
        [request.params.id, request.tenantId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Document not found' });
      }

      return reply.status(204).send();
    }
  );
};

export default documentsRoute;
