import { FastifyPluginAsync } from 'fastify';
import { requireScope } from '../plugins/auth';
import { getSession, listSessions, deleteSession } from '../services/conversationMemory';

const sessionsRoute: FastifyPluginAsync = async (fastify) => {
  // GET /v1/sessions — list sessions for this tenant
  fastify.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/sessions',
    async (request, reply) => {
      requireScope(request, 'chat');
      const limit = Math.min(parseInt(request.query.limit ?? '20'), 100);
      const offset = parseInt(request.query.offset ?? '0');
      const data = await listSessions(request.tenantId, limit, offset);
      return reply.send({ data, limit, offset });
    }
  );

  // GET /v1/sessions/:sessionId — get full message history + summary
  fastify.get<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId',
    async (request, reply) => {
      requireScope(request, 'chat');
      const session = await getSession(request.tenantId, request.params.sessionId);
      if (!session) return reply.status(404).send({ error: 'Session not found' });
      return reply.send(session);
    }
  );

  // DELETE /v1/sessions/:sessionId — clear session history
  fastify.delete<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId',
    async (request, reply) => {
      requireScope(request, 'chat');
      const deleted = await deleteSession(request.tenantId, request.params.sessionId);
      if (!deleted) return reply.status(404).send({ error: 'Session not found' });
      return reply.status(204).send();
    }
  );
};

export default sessionsRoute;
