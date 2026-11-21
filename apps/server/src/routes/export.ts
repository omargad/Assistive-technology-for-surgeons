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
 * Both are de-identified in the core sense (notes, free-text procedure names and
 * device ids removed) but keep real dates by default, because the research
 * team's own dashboard needs them. Add `shiftDates=true` for a file that will be
 * shared further: each participant's timestamps then move by a secret,
 * consistent whole-week shift (`dateShift.ts`), and the bundle's `exportedAt` is
 * the latest shifted session end (the real export time would bound the shifts).
 *
 * Each export is recorded in the audit log (bulk data leaving the server).
 */
import { createExportBundle, sessionEnd, summariesToCsv } from '@surgeonpulse/core';
import type { ExportBundle, ParticipantProfile, SurgicalSession } from '@surgeonpulse/core';
import type { FastifyPluginAsync } from 'fastify';
import { attachment, fileTimestamp } from '../context';
import type { AppContext } from '../context';
import { dateShifter, shiftSummary } from '../dateShift';
import { ExportOptionsSchema, ExportQuerySchema } from '../schemas';
import { actorOf } from '../services/participants';

/** One de-identified bundle in which each participant's sessions and consent record are shifted by `shiftOf(code)`. */
function shiftedBundle(
  sessions: readonly SurgicalSession[],
  profiles: readonly ParticipantProfile[],
  shiftOf: (code: string) => number,
  now: number,
): ExportBundle {
  const byCode = new Map<string, SurgicalSession[]>();
  for (const s of sessions) {
    const list = byCode.get(s.participantCode);
    if (list) list.push(s);
    else byCode.set(s.participantCode, [s]);
  }
  const profileOf = new Map(profiles.map((p) => [p.code, p]));
  const out: ExportBundle = { format: 'surgeonpulse-export', version: 1, exportedAt: now, deidentified: true, participants: [], sessions: [] };
  let latest = Number.NEGATIVE_INFINITY;
  for (const [code, list] of byCode) {
    const profile = profileOf.get(code);
    const part = createExportBundle({
      sessions: list,
      participants: profile ? [profile] : [],
      deidentify: { timeShiftMs: shiftOf(code) },
      now,
    });
    out.participants.push(...part.participants);
    for (const s of part.sessions) {
      out.sessions.push(s);
      latest = Math.max(latest, sessionEnd(s));
    }
  }
  if (Number.isFinite(latest)) out.exportedAt = latest;
  return out;
}

export function exportRoutes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.addHook('onRequest', ctx.auth.requireAdmin);

    app.get('/export', async (request, reply) => {
      const filter = ExportQuerySchema.parse(request.query);
      const { shiftDates } = ExportOptionsSchema.parse(request.query);
      const now = ctx.now();
      const sessions = ctx.repo.sessionBodies(filter).map((body) => JSON.parse(body) as SurgicalSession);
      const codes = [...new Set(sessions.map((s) => s.participantCode))];
      const profiles = ctx.repo.participantProfiles(codes);
      const bundle = shiftDates
        ? shiftedBundle(sessions, profiles, dateShifter(ctx.repo, now), now)
        : createExportBundle({ sessions, participants: profiles, deidentify: true, now });
      ctx.repo.audit(
        { actor: actorOf(request.auth), action: 'export.bundle', detail: { sessions: sessions.length, filter, shiftDates } },
        now,
      );
      return reply
        .type('application/json; charset=utf-8')
        .header('Content-Disposition', attachment(`surgeonpulse-export-${fileTimestamp(now)}.json`))
        .send(JSON.stringify(bundle));
    });

    app.get('/export/summaries.csv', async (request, reply) => {
      const filter = ExportQuerySchema.parse(request.query);
      const { shiftDates } = ExportOptionsSchema.parse(request.query);
      const now = ctx.now();
      let summaries = ctx.repo.listSessions(filter).map((item) => item.summary);
      if (shiftDates) {
        const shiftOf = dateShifter(ctx.repo, now);
        summaries = summaries.map((s) => shiftSummary(s, shiftOf(s.participantCode)));
      }
      const csv = summariesToCsv(summaries);
      ctx.repo.audit(
        { actor: actorOf(request.auth), action: 'export.csv', detail: { sessions: summaries.length, filter, shiftDates } },
        now,
      );
      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', attachment(`surgeonpulse-summaries-${fileTimestamp(now)}.csv`))
        .send(csv);
    });
  };
}
