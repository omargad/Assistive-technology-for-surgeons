/**
 * Researcher access to stored sessions (admin token required):
 * `GET /sessions` (filtered, paginated list with summaries),
 * `GET /sessions/:id` (full de-identified session JSON), `DELETE /sessions/:id`.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../context';
import { HttpError } from '../http';
import { IdParamsSchema, LIST_DEFAULT_LIMIT, ListSessionsQuerySchema } from '../schemas';
import { actorOf } from '../services/participants';

export function sessionRoutes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.addHook('onRequest', ctx.auth.requireAdmin);

    app.get('/sessions', async (request) => {
      const query = ListSessionsQuerySchema.parse(request.query);
      const { limit = LIST_DEFAULT_LIMIT, offset = 0, ...filter } = query;
      return {
        items: ctx.repo.listSessions({ ...filter, limit, offset }),
        total: ctx.repo.countSessions(filter),
      };
    });

    app.get('/sessions/:id', async (request, reply) => {
      const { id } = IdParamsSchema.parse(request.params);
      const body = ctx.repo.getSessionBody(id);
      if (body === undefined) throw new HttpError(404, 'session not found');
      return reply.type('application/json; charset=utf-8').send(body);
    });

    app.delete('/sessions/:id', async (request, reply) => {
      const { id } = IdParamsSchema.parse(request.params);
      const now = ctx.now();
      const deleted = ctx.repo.transaction(() => {
        const meta = ctx.repo.getSessionMeta(id);
        if (meta === undefined || !ctx.repo.deleteSession(id)) return false;
        ctx.repo.audit(
          { actor: actorOf(request.auth), action: 'session.delete', target: id, detail: { participantCode: meta.participantCode } },
          now,
        );
        return true;
      });
      if (!deleted) throw new HttpError(404, 'session not found');
      return reply.code(204).send();
    });
  };
}
