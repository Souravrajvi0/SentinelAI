import { FastifyPluginAsync } from 'fastify';
import { registry } from '../services/metricsRegistry';

// Exposes /metrics in Prometheus text format — scrape with Prometheus
const promMetricsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/metrics', { logLevel: 'warn' }, async (_req, reply) => {
    reply.header('Content-Type', registry.contentType);
    return reply.send(await registry.metrics());
  });
};

export default promMetricsRoute;
