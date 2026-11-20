/**
 * Researcher administration under `/api/v1/admin` (admin token required):
 * participants, enrolment tokens, researcher-actioned withdrawal, audit log.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../context';
import { HttpError } from '../http';
import type { ParticipantRecord } from '../repo';
import { CodeParamsSchema, CreateEnrolmentBodySchema, CreateParticipantBodySchema, IdParamsSchema } from '../schemas';
import {
  actorOf,
  createEnrolment,
  revokeEnrolment,
  upsertParticipant,
  withdrawParticipant,
} from '../services/participants';

/** SPEC: the audit endpoint returns the latest 500 rows. */
export const AUDIT_PAGE_SIZE = 500;

function participantView(p: ParticipantRecord) {
  return { code: p.code, profile: p.profile, createdAt: p.createdAt, withdrawn: p.withdrawnAt !== null, withdrawnAt: p.withdrawnAt };
}

export function adminRoutes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.addHook('onRequest', ctx.auth.requireAdmin);

    // -- participants ---------------------------------------------------------

    app.post('/participants', async (request, reply) => {
      const body = CreateParticipantBodySchema.parse(request.body);
      const { created, participant } = upsertParticipant(ctx.repo, body, actorOf(request.auth), ctx.now());
      return reply.code(created ? 201 : 200).send(participantView(participant));
    });

    app.get('/participants', async () => ({ items: ctx.repo.listParticipants() }));

    /** Researcher-actioned withdrawal: same effect as `POST /me/withdraw`. */
    app.delete('/participants/:code', async (request, reply) => {
      const { code } = CodeParamsSchema.parse(request.params);
      const result = withdrawParticipant(ctx.repo, code, actorOf(request.auth), ctx.now());
      if (result === null) throw new HttpError(404, 'participant not found');
      return reply.code(204).send();
    });

    // -- enrolments -----------------------------------------------------------

    app.post('/enrolments', async (request, reply) => {
      const body = CreateEnrolmentBodySchema.parse(request.body);
      const enrolment = createEnrolment(ctx.repo, body, actorOf(request.auth), ctx.now());
      // The token is in this response only; it cannot be retrieved again.
      return reply.code(201).send(enrolment);
    });

    app.get('/enrolments', async () => ({
      items: ctx.repo.listEnrolments().map((e) => ({ ...e, active: e.revokedAt === null })),
    }));

    app.delete('/enrolments/:id', async (request, reply) => {
      const { id } = IdParamsSchema.parse(request.params);
      if (!revokeEnrolment(ctx.repo, id, actorOf(request.auth), ctx.now())) {
        throw new HttpError(404, 'enrolment not found');
      }
      return reply.code(204).send();
    });

    // -- audit ----------------------------------------------------------------

    app.get('/audit', async () => ({ items: ctx.repo.listAudit(AUDIT_PAGE_SIZE) }));
  };
}
