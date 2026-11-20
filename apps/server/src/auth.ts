/**
 * Authentication (SPEC.md › auth.ts).
 *
 * - Researchers use the admin bearer token from `ADMIN_TOKEN`. It is compared
 *   with `crypto.timingSafeEqual` over SHA-256 digests, so the comparison
 *   takes the same time whatever the candidate's length or content.
 * - Participants' phones use enrolment tokens: `spk_` + base64url(32 random
 *   bytes). Only the SHA-256 hex of a token is stored; a request is checked by
 *   looking that hash up. Revoked tokens and tokens of withdrawn participants
 *   are rejected.
 * - Every failure is the same `401 { error: 'unauthorized' }` and does not
 *   reveal which check failed. Failures are rate limited per IP (10/min);
 *   once exhausted, further attempts get 429 until the bucket refills.
 *
 * The hooks are attached as `onRequest` hooks so an unauthenticated upload is
 * rejected before its body is read or parsed.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Repo } from './repo';
import { sendTooManyRequests } from './rateLimit';
import type { TokenBucketLimiter } from './rateLimit';

export const ENROLMENT_TOKEN_PREFIX = 'spk_';
/** `spk_` + 43 base64url characters (32 bytes, unpadded). */
const ENROLMENT_TOKEN_RE = /^spk_[A-Za-z0-9_-]{43}$/;

export type AuthContext =
  | { kind: 'admin' }
  | { kind: 'participant'; participantCode: string; enrolmentId: string };

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAdmin` / `requireEnrolment`; null on unauthenticated routes. */
    auth: AuthContext | null;
  }
}

/** Generate a new enrolment token (shown to the researcher once, never stored). */
export function generateEnrolmentToken(): string {
  return ENROLMENT_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** SHA-256 hex digest of a token, as stored in `enrolments.token_hash`. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isEnrolmentTokenFormat(token: string): boolean {
  return ENROLMENT_TOKEN_RE.test(token);
}

/** Extract the token from `Authorization: Bearer <token>` (scheme is case-insensitive). */
export function parseBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * Build a constant-time checker for the admin token. Both sides are hashed to
 * 32-byte SHA-256 digests first, so `timingSafeEqual` always compares equal
 * lengths and the token's length is not leaked.
 */
export function createAdminTokenVerifier(adminToken: string): (candidate: string) => boolean {
  const expected = createHash('sha256').update(adminToken, 'utf8').digest();
  return (candidate) => {
    const actual = createHash('sha256').update(candidate, 'utf8').digest();
    return timingSafeEqual(actual, expected);
  };
}

/** The participant code of an enrolment-authenticated request. */
export function participantOf(request: FastifyRequest): string {
  const auth = request.auth;
  if (auth?.kind !== 'participant') throw new Error('route requires enrolment authentication');
  return auth.participantCode;
}

export interface AuthDeps {
  adminToken: string;
  repo: Repo;
  limiter: TokenBucketLimiter;
  now: () => number;
}

export interface AuthHooks {
  requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined>;
  requireEnrolment(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined>;
}

/** Create the `requireAdmin` and `requireEnrolment` hooks. */
export function createAuth(deps: AuthDeps): AuthHooks {
  const isAdminToken = createAdminTokenVerifier(deps.adminToken);

  /** 429 while this IP has used up its authentication-failure allowance. */
  function lockedOut(request: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
    const state = deps.limiter.peek('auth', request.ip);
    return state.allowed ? undefined : sendTooManyRequests(reply, state.retryAfterSec);
  }

  function unauthorized(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    deps.limiter.take('auth', request.ip);
    return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
  }

  return {
    async requireAdmin(request, reply) {
      const blocked = lockedOut(request, reply);
      if (blocked) return blocked;
      const token = parseBearer(request.headers.authorization);
      if (token === null || !isAdminToken(token)) return unauthorized(request, reply);
      request.auth = { kind: 'admin' };
      return undefined;
    },

    async requireEnrolment(request, reply) {
      const blocked = lockedOut(request, reply);
      if (blocked) return blocked;
      const token = parseBearer(request.headers.authorization);
      if (token === null || !isEnrolmentTokenFormat(token)) return unauthorized(request, reply);
      const enrolment = deps.repo.findEnrolmentByTokenHash(hashToken(token));
      if (enrolment === undefined || enrolment.revokedAt !== null || enrolment.participantWithdrawnAt !== null) {
        return unauthorized(request, reply);
      }
      deps.repo.touchEnrolment(enrolment.id, deps.now());
      request.auth = { kind: 'participant', participantCode: enrolment.participantCode, enrolmentId: enrolment.id };
      return undefined;
    },
  };
}
