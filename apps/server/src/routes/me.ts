/**
 * Participant self-service (enrolment token required):
 * `GET /me` confirms enrolment; `POST /me/withdraw` withdraws from the study.
 */
import type { FastifyPluginAsync } from 'fastify';
import { participantOf } from '../auth';
import type { AppContext } from '../context';
import { HttpError } from '../http';
import { actorOf, withdrawParticipant } from '../services/participants';

export function meRoutes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.addHook('onRequest', ctx.auth.requireEnrolment);

    app.get('/me', async (request) => {
      const participantCode = participantOf(request);
      const stats = ctx.repo.participantStats(participantCode);
      return { participantCode, sessionCount: stats.sessionCount, lastUploadAt: stats.lastUploadAt };
    });

    /**
     * Deletes all of the participant's sessions, marks them withdrawn and
     * revokes every enrolment token (including the one used for this call).
     */
    app.post('/me/withdraw', async (request) => {
      const participantCode = participantOf(request);
      const result = withdrawParticipant(ctx.repo, participantCode, actorOf(request.auth), ctx.now());
      if (result === null) throw new HttpError(404, 'participant not found');
      return { deletedSessions: result.deletedSessions };
    });
  };
}
