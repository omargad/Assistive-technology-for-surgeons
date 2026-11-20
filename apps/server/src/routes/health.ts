/**
 * `GET /health` — unauthenticated liveness check for load balancers and the
 * container HEALTHCHECK. Also checks that the database answers.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../context';
import { VERSION } from '../version';

export function healthRoutes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/health', async (request, reply) => {
      let ok = false;
      try {
        ok = ctx.repo.ping();
      } catch (err) {
        request.log.error({ err: { message: err instanceof Error ? err.message : String(err) } }, 'database ping failed');
      }
      if (!ok) return reply.code(503).send({ error: 'database unavailable' });
      return { status: 'ok', version: VERSION };
    });
  };
}
