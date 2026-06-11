import { Pool } from 'pg';
import pino from 'pino';
import { startIngestWorker } from './workers/ingest';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  max: 5,
});

const worker = startIngestWorker({
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  pool,
  mistralApiKey: process.env.MISTRAL_API_KEY!,
  embeddingModel: process.env.MISTRAL_EMBEDDING_MODEL ?? 'mistral-embed',
  concurrency: parseInt(process.env.INGEST_QUEUE_CONCURRENCY ?? '3'),
});

log.info('Ingestion worker started');

process.on('SIGTERM', async () => {
  await worker.close();
  await pool.end();
  process.exit(0);
});
