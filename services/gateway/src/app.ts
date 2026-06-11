import Fastify, { FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Redis from 'ioredis';
import { config } from './config';
import authPlugin from './plugins/auth';
import healthRoute from './routes/health';
import chatRoute from './routes/chat';
import retrieveRoute from './routes/retrieve';
import documentsRoute from './routes/documents';
import agentRoute from './routes/agent';
import tracesRoute from './routes/traces';
import metricsRoute from './routes/metrics';
import promMetricsRoute from './routes/promMetrics';
import adminRoute from './routes/admin';
import sessionsRoute from './routes/sessions';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport: config.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
    },
  });

  const redis = new Redis(config.REDIS_URL);

  await app.register(fastifyRateLimit, {
    global: true,
    max: config.DEFAULT_RATE_LIMIT_RPM,
    timeWindow: '1 minute',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redis: redis as any,
    keyGenerator: (req) => {
      const r = req as typeof req & { tenantId?: string };
      return r.tenantId ?? req.ip;
    },
  });

  await app.register(fastifySwagger, {
    openapi: {
      info: { title: 'SentinelAI API', version: '1.0.0' },
      components: {
        securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } },
      },
      security: [{ ApiKey: [] }],
    },
  });

  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  await app.register(authPlugin);

  // Public routes (no auth)
  await app.register(healthRoute);
  await app.register(promMetricsRoute);

  // Authenticated routes under /v1
  await app.register(
    async (api) => {
      api.addHook('preHandler', app.verifyApiKey);
      await api.register(chatRoute);
      await api.register(retrieveRoute);
      await api.register(documentsRoute);
      await api.register(agentRoute);
      await api.register(tracesRoute);
      await api.register(metricsRoute);
      await api.register(adminRoute);
      await api.register(sessionsRoute);
    },
    { prefix: '/v1' }
  );

  return app;
}
