import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TokenBucketLimiter } from '../src/rateLimit';
import { ADMIN, bearer, createTestApp, enrol, upload } from './helpers';
import type { TestContext } from './helpers';

describe('TokenBucketLimiter', () => {
  it('allows a burst up to the limit, then refills continuously', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(
      { upload: { limit: 3, windowMs: 3000 }, auth: { limit: 1, windowMs: 1000 } },
      () => now,
    );
    expect([1, 2, 3].map(() => limiter.take('upload', 'ip').allowed)).toEqual([true, true, true]);
    expect(limiter.take('upload', 'ip')).toEqual({ allowed: false, retryAfterSec: 1 });
    now += 999;
    expect(limiter.take('upload', 'ip').allowed).toBe(false);
    now += 1;
    expect(limiter.take('upload', 'ip').allowed).toBe(true);
    // Separate keys and groups have separate buckets.
    expect(limiter.take('upload', 'other-ip').allowed).toBe(true);
    expect(limiter.take('auth', 'ip').allowed).toBe(true);
  });

  it('peek reports without consuming', () => {
    const limiter = new TokenBucketLimiter(
      { upload: { limit: 1, windowMs: 60_000 }, auth: { limit: 1, windowMs: 60_000 } },
      () => 0,
    );
    expect(limiter.peek('auth', 'ip').allowed).toBe(true);
    expect(limiter.peek('auth', 'ip').allowed).toBe(true);
    expect(limiter.take('auth', 'ip').allowed).toBe(true);
    expect(limiter.peek('auth', 'ip')).toEqual({ allowed: false, retryAfterSec: 60 });
  });

  it('bounds memory by evicting the least recently used keys', () => {
    const limiter = new TokenBucketLimiter(
      { upload: { limit: 1, windowMs: 60_000 }, auth: { limit: 1, windowMs: 60_000 } },
      () => 0,
      2,
    );
    limiter.take('upload', 'a');
    limiter.take('upload', 'b');
    limiter.take('upload', 'c'); // evicts "a"
    expect(limiter.take('upload', 'a').allowed).toBe(true);
    expect(limiter.take('upload', 'c').allowed).toBe(false);
  });
});

describe('rate limiting over HTTP', () => {
  let t: TestContext;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it('allows 30 uploads per minute per IP, then answers 429 with Retry-After', async () => {
    const { token } = await enrol(t.app, 'SP-001');
    for (let i = 0; i < 30; i++) {
      // Cheap requests: an empty array is rejected with 400 but still counts.
      expect((await upload(t.app, token, '[]')).statusCode).toBe(400);
    }
    const limited = await upload(t.app, token, '[]');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('2'); // 60 s / 30 tokens
    expect(limited.json()).toEqual({ error: 'too many requests' });

    t.clock.now += 2000;
    expect((await upload(t.app, token, '[]')).statusCode).toBe(400);
    expect((await upload(t.app, token, '[]')).statusCode).toBe(429);
  });

  it('counts unauthenticated uploads too, before reading the body', async () => {
    for (let i = 0; i < 30; i++) await upload(t.app, 'spk_bogus', '[]');
    expect((await upload(t.app, 'spk_bogus', '[]')).statusCode).toBe(429);
  });

  it('allows 10 authentication failures per minute per IP, then locks out with 429', async () => {
    const attempt = (headers: Record<string, string>) =>
      t.app.inject({ method: 'GET', url: '/api/v1/admin/participants', headers });
    for (let i = 0; i < 10; i++) expect((await attempt(bearer(`guess-${i}`))).statusCode).toBe(401);

    const locked = await attempt(ADMIN); // even the right token waits until the bucket refills
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBe('6'); // 60 s / 10 tokens
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer('spk_x') })).statusCode).toBe(429);

    t.clock.now += 6000;
    expect((await attempt(ADMIN)).statusCode).toBe(200);
    // Successful requests do not consume the failure allowance.
    for (let i = 0; i < 5; i++) expect((await attempt(ADMIN)).statusCode).toBe(200);
  });

  it('does not rate limit successful admin requests', async () => {
    for (let i = 0; i < 50; i++) {
      expect((await t.app.inject({ method: 'GET', url: '/api/v1/admin/participants', headers: ADMIN })).statusCode).toBe(200);
    }
  });
});
