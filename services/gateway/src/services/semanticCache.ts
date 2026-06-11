import OpenAI from 'openai';
import { pool } from '../db/client';
import { config } from '../config';

export interface CacheHit {
  response_text: string;
  model: string;
  provider: string;
  cache_id: string;
}

export async function checkSemanticCache(
  tenantId: string,
  queryText: string,
  threshold = 0.95
): Promise<CacheHit | null> {
  if (!config.MISTRAL_API_KEY) return null;
  try {
    const mistral = new OpenAI({ apiKey: config.MISTRAL_API_KEY, baseURL: 'https://api.mistral.ai/v1' });
    const embRes = await mistral.embeddings.create({ model: config.MISTRAL_EMBEDDING_MODEL, input: queryText });
    const embedding = embRes.data[0]?.embedding;
    if (!embedding) return null;

    const result = await pool.query<{ id: string; response_text: string; model: string; provider: string }>(
      `SELECT id, response_text, model, provider
       FROM semantic_cache
       WHERE tenant_id = $1
         AND expires_at > NOW()
         AND 1 - (query_embedding <=> $2::vector) >= $3
       ORDER BY query_embedding <=> $2::vector
       LIMIT 1`,
      [tenantId, `[${embedding.join(',')}]`, threshold]
    );

    if (result.rows.length === 0) return null;
    const hit = result.rows[0]!;
    pool.query('UPDATE semantic_cache SET hit_count = hit_count + 1 WHERE id = $1', [hit.id]).catch(() => {});
    return { response_text: hit.response_text, model: hit.model, provider: hit.provider, cache_id: hit.id };
  } catch {
    return null;
  }
}

export async function storeInSemanticCache(
  tenantId: string,
  queryText: string,
  responseText: string,
  model: string,
  provider: string,
  ttlHours = 24
): Promise<void> {
  if (!config.MISTRAL_API_KEY) return;
  try {
    const mistral = new OpenAI({ apiKey: config.MISTRAL_API_KEY, baseURL: 'https://api.mistral.ai/v1' });
    const embRes = await mistral.embeddings.create({ model: config.MISTRAL_EMBEDDING_MODEL, input: queryText });
    const embedding = embRes.data[0]?.embedding;
    if (!embedding) return;
    await pool.query(
      `INSERT INTO semantic_cache
         (tenant_id, query_embedding, query_text, response_text, model, provider, expires_at)
       VALUES ($1, $2::vector, $3, $4, $5, $6, NOW() + ($7 || ' hours')::interval)`,
      [tenantId, `[${embedding.join(',')}]`, queryText, responseText, model, provider, ttlHours]
    );
  } catch {
    // Cache write is non-fatal
  }
}

export async function getCacheStats(tenantId: string) {
  const result = await pool.query<{ total: string; hits: string; expired: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE expires_at > NOW()) AS total,
       COALESCE(SUM(hit_count) FILTER (WHERE expires_at > NOW()), 0) AS hits,
       COUNT(*) FILTER (WHERE expires_at <= NOW()) AS expired
     FROM semantic_cache
     WHERE tenant_id = $1`,
    [tenantId]
  );
  const row = result.rows[0]!;
  return { total: parseInt(row.total), hits: parseInt(row.hits), expired: parseInt(row.expired) };
}
