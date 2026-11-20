/**
 * Researcher exports (admin token required), with the same filters as
 * `GET /sessions` (`participant`, `from`, `to`, `specialty`, optional
 * `limit`/`offset`; no limit by default):
 *
 * - `GET /export` → de-identified `ExportBundle` JSON attachment, including
 *   the profiles of the participants whose sessions are exported. Read it
 *   with core's `parseImport` (the dashboard does).
 * - `GET /export/summaries.csv` → core `summariesToCsv` (one wide row per
 *   session) for R/SPSS/Stata/pandas.
 *
 * Each export is recorded in the audit log (bulk data leaving the server).
 */
import { createExportBundle, summariesToCsv } from '@surgeonpulse/core';
import type { SurgicalSession } from '@surgeonpulse/core';
import type { FastifyPluginAsync } from 'fastify';
import { attachment, fileTimestamp } from '../context';
import type { AppContext } from '../context';
import { ExportQuerySchema } from '../schemas';
import { actorOf } from '../services/participants';

export function exportRoutes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.addHook('onRequest', ctx.auth.requireAdmin);

    app.get('/export', async (request, reply) => {
      const filter = ExportQuerySchema.parse(request.query);
      const now = ctx.now();
      const sessions = ctx.repo.sessionBodies(filter).map((body) => JSON.parse(body) as SurgicalSession);
      const codes = [...new Set(sessions.map((s) => s.participantCode))];
      const bundle = createExportBundle({
        sessions,
        participants: ctx.repo.participantProfiles(codes),
        deidentify: true,
        now,
      });
      ctx.repo.audit(
        { actor: actorOf(request.auth), action: 'export.bundle', detail: { sessions: sessions.length, filter } },
        now,
      );
      return reply
        .type('application/json; charset=utf-8')
        .header('Content-Disposition', attachment(`surgeonpulse-export-${fileTimestamp(now)}.json`))
        .send(JSON.stringify(bundle));
    });

    app.get('/export/summaries.csv', async (request, reply) => {
      const filter = ExportQuerySchema.parse(request.query);
      const now = ctx.now();
      const summaries = ctx.repo.listSessions(filter).map((item) => item.summary);
      const csv = summariesToCsv(summaries);
      ctx.repo.audit(
        { actor: actorOf(request.auth), action: 'export.csv', detail: { sessions: summaries.length, filter } },
        now,
      );
      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', attachment(`surgeonpulse-summaries-${fileTimestamp(now)}.csv`))
        .send(csv);
    });
  };
}
