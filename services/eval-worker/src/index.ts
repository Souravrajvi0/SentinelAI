import { Pool } from 'pg';
import pino from 'pino';
import { startEvalWorker } from './workers/eval';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 5 });

const worker = startEvalWorker({
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  pool,
  groqApiKey: process.env.GROQ_API_KEY!,
  evalModel: process.env.EVAL_MODEL ?? 'llama-3.3-70b-versatile',
  concurrency: parseInt(process.env.EVAL_QUEUE_CONCURRENCY ?? '5'),
});

log.info('Eval worker started');

process.on('SIGTERM', async () => {
  await worker.close();
  await pool.end();
  process.exit(0);
});
