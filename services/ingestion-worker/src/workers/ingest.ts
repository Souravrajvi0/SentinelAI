import { Worker, Job } from 'bullmq';
import { Pool } from 'pg';
import pino from 'pino';
import { QUEUES, type IngestJobData } from '@sentinelai/shared';
import { chunkText } from '../services/chunker';
import { Embedder } from '../services/embedder';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const BATCH_SIZE = 100;

export function startIngestWorker(opts: {
  redisUrl: string;
  pool: Pool;
  mistralApiKey: string;
  embeddingModel: string;
  concurrency: number;
}) {
  const embedder = new Embedder({
    apiKey: opts.mistralApiKey,
    model: opts.embeddingModel,
  });

  const worker = new Worker<IngestJobData>(
    QUEUES.INGEST,
    async (job: Job<IngestJobData>) => {
      const { document_id, tenant_id, raw_text } = job.data;

      log.info({ document_id }, 'Starting ingestion');

      await opts.pool.query(
        `UPDATE documents SET status = 'processing' WHERE id = $1`,
        [document_id]
      );

      try {
        const text = raw_text ?? '';
        if (!text.trim()) throw new Error('Document has no extractable text');

        const chunks = chunkText(text, { maxTokens: 512, overlap: 64 });
        log.info({ document_id, chunk_count: chunks.length }, 'Text chunked');
        await job.updateProgress(20);

        const allEmbeddings: number[][] = [];
        for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
          const batch = chunks.slice(i, i + BATCH_SIZE);
          const embeddings = await embedder.embedBatch(batch.map((c) => c.content));
          allEmbeddings.push(...embeddings);
          await job.updateProgress(20 + Math.floor((i / chunks.length) * 60));
        }

        const client = await opts.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('DELETE FROM document_chunks WHERE document_id = $1', [document_id]);

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            const embedding = allEmbeddings[i]!;
            await client.query(
              `INSERT INTO document_chunks
                 (document_id, tenant_id, chunk_index, content, content_tokens, embedding)
               VALUES ($1, $2, $3, $4, $5, $6::vector)`,
              [
                document_id, tenant_id, chunk.chunk_index,
                chunk.content, chunk.token_estimate,
                `[${embedding.join(',')}]`,
              ]
            );
          }

          await client.query(
            `UPDATE documents SET status = 'indexed', chunk_count = $2, indexed_at = NOW() WHERE id = $1`,
            [document_id, chunks.length]
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }

        await job.updateProgress(100);
        log.info({ document_id, chunk_count: chunks.length }, 'Ingestion complete');
      } catch (err) {
        await opts.pool.query(
          `UPDATE documents SET status = 'failed', error_message = $2 WHERE id = $1`,
          [document_id, (err as Error).message]
        );
        throw err;
      }
    },
    { connection: { url: opts.redisUrl } as never, concurrency: opts.concurrency }
  );

  worker.on('failed', (job, err) => {
    log.error({ job: job?.id, err }, 'Ingest job failed');
  });

  return worker;
}
