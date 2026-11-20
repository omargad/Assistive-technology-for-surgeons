/**
 * Cross-cutting HTTP behaviour: uniform error bodies, the JSON 404, security
 * headers and a tolerant JSON body parser.
 *
 * Every error response has the shape `{ error: string, details?: string[] }`.
 * Error messages never include request bodies (which may hold health data);
 * unexpected errors are logged with their message and stack only.
 */
import { STATUS_CODES } from 'node:http';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

/** An error with an HTTP status, rendered as `{ error, details? }`. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly details: string[] | undefined;

  constructor(statusCode: number, message: string, details?: string[]) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface ErrorBody {
  error: string;
  details?: string[];
}

/** Human-readable `path: message` lines for a zod error. */
export function zodDetails(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
}

/** Headers added to every response (SPEC.md › Security headers). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  // Every response is either health data, credentials or cheap to recompute: never cache.
  'Cache-Control': 'no-store',
};

/** Map well-known Fastify errors (body parsing, limits) to uniform responses. */
function fromFastifyError(err: FastifyError): { status: number; body: ErrorBody } | null {
  switch (err.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return { status: 413, body: { error: 'payload too large' } };
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return { status: 415, body: { error: 'unsupported media type', details: ['send Content-Type: application/json'] } };
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return { status: 400, body: { error: 'empty body' } };
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return { status: 400, body: { error: 'invalid JSON' } };
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return { status: 400, body: { error: 'invalid content length' } };
    default:
      return null;
  }
}

function isFastifyError(err: unknown): err is FastifyError {
  return err instanceof Error && typeof (err as { code?: unknown }).code === 'string';
}

/** Install the uniform error handler and the JSON 404 handler. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof HttpError) {
      const body: ErrorBody = { error: err.message };
      if (err.details !== undefined && err.details.length > 0) body.details = err.details;
      return reply.code(err.statusCode).send(body);
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid request', details: zodDetails(err) });
    }
    if (isFastifyError(err)) {
      const mapped = fromFastifyError(err);
      if (mapped !== null) return reply.code(mapped.status).send(mapped.body);
    }
    if (err instanceof SyntaxError) {
      // A JSON parse error; its message may quote the body, so never echo or log it.
      return reply.code(400).send({ error: 'invalid JSON' });
    }
    const status = typeof (err as { statusCode?: unknown }).statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: (STATUS_CODES[status] ?? 'bad request').toLowerCase() });
    }
    const e = err instanceof Error ? err : new Error(String(err));
    request.log.error({ err: { type: e.name, message: e.message, stack: e.stack } }, 'unhandled error');
    return reply.code(500).send({ error: 'internal error' });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not found' }));
}

/** Add {@link SECURITY_HEADERS} to every response, including errors, 404s and CORS preflights. */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.headers(SECURITY_HEADERS);
    return payload;
  });
}

/**
 * Replace the default `application/json` parser with one that treats an
 * empty body as "no body" (so `POST` without a payload works from every HTTP
 * client) and otherwise uses Fastify's secure parser, which rejects
 * `__proto__`/`constructor` prototype-poisoning keys.
 */
export function registerJsonParser(app: FastifyInstance): void {
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (typeof body !== 'string' || body.trim() === '') {
      done(null, undefined);
      return;
    }
    parseJson(request, body, done);
  });
}
