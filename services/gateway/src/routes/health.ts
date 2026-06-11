import { FastifyPluginAsync } from 'fastify';
import { pool } from '../db/client';

const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', { logLevel: 'warn' }, async (_req, reply) => {
    let dbOk = false;
    try {
      await pool.query('SELECT 1');
      dbOk = true;
    } catch {}

    const status = dbOk ? 'ok' : 'degraded';
    reply.status(dbOk ? 200 : 503).send({
      status,
      timestamp: new Date().toISOString(),
      checks: { database: dbOk ? 'ok' : 'error' },
    });
  });
};

export default healthRoute;
