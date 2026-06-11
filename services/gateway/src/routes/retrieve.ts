import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import OpenAI from 'openai';
import { requireScope } from '../plugins/auth';
import { query } from '../db/client';
import { config } from '../config';

const bodySchema = z.object({
  query: z.string().min(1),
  top_k: z.number().int().min(1).max(20).default(5),
  score_threshold: z.number().min(0).max(1).default(0.7),
  hybrid: z.boolean().optional().default(true),
});

const retrieveRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post('/retrieve', async (request, reply) => {
    requireScope(request, 'retrieve');

    const body = bodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() });
    }

    const { query: queryText, top_k, score_threshold, hybrid } = body.data;
    const start = Date.now();

    if (!config.MISTRAL_API_KEY) {
      return reply.status(503).send({ error: 'MISTRAL_API_KEY not configured — embedding unavailable' });
    }

    const mistral = new OpenAI({ apiKey: config.MISTRAL_API_KEY, baseURL: 'https://api.mistral.ai/v1' });
    const embeddingRes = await mistral.embeddings.create({
      model: config.MISTRAL_EMBEDDING_MODEL,
      input: queryText,
    });
    const embedding = embeddingRes.data[0]?.embedding;
    if (!embedding) throw new Error('Failed to get embedding');

    const vecLimit = top_k * 2;

    if (!hybrid) {
      // Pure vector search
      const result = await query<{
        id: string; document_id: string; content: string;
        score: number; doc_title: string | null;
      }>(
        `SELECT c.id, c.document_id, c.content,
                1 - (c.embedding <=> $1::vector) AS score,
                d.title AS doc_title
         FROM document_chunks c
         JOIN documents d ON c.document_id = d.id
         WHERE c.tenant_id = $2
           AND 1 - (c.embedding <=> $1::vector) >= $3
         ORDER BY c.embedding <=> $1::vector
         LIMIT $4`,
        [`[${embedding.join(',')}]`, request.tenantId, score_threshold, top_k]
      );

      return reply.send({
        query: queryText,
        results: result.rows.map((r) => ({
          chunk_id: r.id,
          document_id: r.document_id,
          document_title: r.doc_title,
          content_preview: r.content.slice(0, 300),
          score: parseFloat(r.score as unknown as string),
          match_type: 'vector',
        })),
        latency_ms: Date.now() - start,
      });
    }

    // Hybrid: vector + keyword with Reciprocal Rank Fusion
    const [vecResult, kwResult] = await Promise.all([
      query<{ id: string; document_id: string; content: string; score: number; doc_title: string | null }>(
        `SELECT c.id, c.document_id, c.content,
                1 - (c.embedding <=> $1::vector) AS score,
                d.title AS doc_title
         FROM document_chunks c
         JOIN documents d ON c.document_id = d.id
         WHERE c.tenant_id = $2
         ORDER BY c.embedding <=> $1::vector
         LIMIT $3`,
        [`[${embedding.join(',')}]`, request.tenantId, vecLimit]
      ),
      query<{ id: string; document_id: string; content: string; kw_rank: number; doc_title: string | null }>(
        `SELECT c.id, c.document_id, c.content,
                ts_rank_cd(c.content_tsv, plainto_tsquery('english', $1)) AS kw_rank,
                d.title AS doc_title
         FROM document_chunks c
         JOIN documents d ON c.document_id = d.id
         WHERE c.tenant_id = $2
           AND c.content_tsv @@ plainto_tsquery('english', $1)
         ORDER BY kw_rank DESC
         LIMIT $3`,
        [queryText, request.tenantId, vecLimit]
      ),
    ]);

    // Reciprocal Rank Fusion (k=60)
    const RRF_K = 60;
    const scores = new Map<string, { score: number; row: typeof vecResult.rows[0] }>();

    vecResult.rows.forEach((row, i) => {
      const rrf = 1 / (RRF_K + i + 1);
      scores.set(row.id, { score: rrf, row });
    });

    kwResult.rows.forEach((row, i) => {
      const rrf = 1 / (RRF_K + i + 1);
      const existing = scores.get(row.id);
      if (existing) {
        existing.score += rrf;
      } else {
        scores.set(row.id, { score: rrf, row: { ...row, score: 0 } });
      }
    });

    const merged = Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, top_k);

    return reply.send({
      query: queryText,
      results: merged.map(({ score, row }) => ({
        chunk_id: row.id,
        document_id: row.document_id,
        document_title: row.doc_title,
        content_preview: row.content.slice(0, 300),
        score: parseFloat(score.toFixed(6)),
        match_type: 'hybrid',
      })),
      latency_ms: Date.now() - start,
    });
  });
};

export default retrieveRoute;
