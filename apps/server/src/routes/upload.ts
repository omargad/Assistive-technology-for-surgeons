/**
 * `POST /api/v1/sessions` — participants' phones upload sessions here
 * (enrolment token required; 30 uploads/min per IP).
 *
 * This plugin has its own encapsulated JSON parser that hands the raw text
 * to core's `parseImport` (which accepts a bundle, a session or an array and
 * reports per-session problems) instead of parsing the body twice. The
 * server-wide `bodyLimit` still applies, giving 413 for oversize bodies.
 * Rate limiting and authentication run in `onRequest`, before the body is
 * read.
 */
import type { FastifyPluginAsync } from 'fastify';
import { participantOf } from '../auth';
import type { AppContext } from '../context';
import { rateLimitHook } from '../rateLimit';
import { ingestUpload } from '../services/ingest';

export function uploadRoutes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });

    app.post(
      '/sessions',
      { onRequest: [rateLimitHook(ctx.limiter, 'upload'), ctx.auth.requireEnrolment] },
      async (request) => {
        const participantCode = participantOf(request);
        const { result } = ingestUpload({
          text: typeof request.body === 'string' ? request.body : undefined,
          participantCode,
          repo: ctx.repo,
          now: ctx.now(),
          onProcessingError: (index, err) => {
            // Index and error type only: never session content.
            request.log.warn({ index, error: err instanceof Error ? err.name : typeof err }, 'session could not be processed');
          },
        });
        return result;
      },
    );
  };
}
