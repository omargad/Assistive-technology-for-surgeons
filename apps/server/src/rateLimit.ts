/**
 * In-memory token-bucket rate limiting per (client IP, route group).
 *
 * Each bucket holds up to `limit` tokens and refills continuously at
 * `limit / windowMs`. A request that finds the bucket empty gets
 * `429 Too Many Requests` with a `Retry-After` header (whole seconds until a
 * token is available). State is per process, which suits the single-instance
 * deployment this server is designed for.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export type RateLimitGroup = 'upload' | 'auth';

export interface RateLimitRule {
  /** Bucket capacity (requests allowed in a burst). */
  limit: number;
  /** Time to refill the whole bucket, in ms. */
  windowMs: number;
}

export type RateLimitRules = Record<RateLimitGroup, RateLimitRule>;

/** SPEC: uploads 30/min, authentication failures 10/min. */
export const DEFAULT_RATE_LIMITS: RateLimitRules = {
  upload: { limit: 30, windowMs: 60_000 },
  auth: { limit: 10, windowMs: 60_000 },
};

export type RateLimitResult = { allowed: true; remaining: number } | { allowed: false; retryAfterSec: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Token buckets keyed by group and client key (normally the IP address). */
export class TokenBucketLimiter {
  private readonly rules: RateLimitRules;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(rules: RateLimitRules = DEFAULT_RATE_LIMITS, now: () => number = Date.now, maxKeys = 50_000) {
    this.rules = rules;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  /** Consume one token if available. */
  take(group: RateLimitGroup, key: string): RateLimitResult {
    return this.check(group, key, true);
  }

  /** Report whether a token is available without consuming it. */
  peek(group: RateLimitGroup, key: string): RateLimitResult {
    return this.check(group, key, false);
  }

  private check(group: RateLimitGroup, key: string, consume: boolean): RateLimitResult {
    const rule = this.rules[group];
    const ratePerMs = rule.limit / rule.windowMs;
    const id = `${group}\u0000${key}`;
    const now = this.now();
    const bucket = this.refill(this.buckets.get(id), rule, ratePerMs, now);
    if (bucket.tokens < 1) {
      this.store(id, bucket);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / ratePerMs / 1000)) };
    }
    if (consume) bucket.tokens -= 1;
    this.store(id, bucket);
    return { allowed: true, remaining: Math.floor(bucket.tokens) };
  }

  private refill(existing: Bucket | undefined, rule: RateLimitRule, ratePerMs: number, now: number): Bucket {
    if (existing === undefined) return { tokens: rule.limit, updatedAt: now };
    const elapsed = Math.max(0, now - existing.updatedAt);
    return { tokens: Math.min(rule.limit, existing.tokens + elapsed * ratePerMs), updatedAt: now };
  }

  private store(id: string, bucket: Bucket): void {
    // Re-insert so Map order approximates least-recently-used.
    this.buckets.delete(id);
    this.buckets.set(id, bucket);
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (oldest.done !== true) this.buckets.delete(oldest.value);
    }
  }
}

/** Send the uniform 429 response. */
export function sendTooManyRequests(reply: FastifyReply, retryAfterSec: number): FastifyReply {
  return reply.code(429).header('Retry-After', String(retryAfterSec)).send({ error: 'too many requests' });
}

/**
 * `onRequest` hook that consumes one token from `group` for the client IP.
 * (Fastify async hooks end the request early by sending and returning `reply`.)
 */
export function rateLimitHook(limiter: TokenBucketLimiter, group: RateLimitGroup) {
  return async function rateLimit(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    const result = limiter.take(group, request.ip);
    return result.allowed ? undefined : sendTooManyRequests(reply, result.retryAfterSec);
  };
}
