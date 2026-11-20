import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAdminTokenVerifier,
  generateEnrolmentToken,
  hashToken,
  isEnrolmentTokenFormat,
  parseBearer,
} from '../src/auth';
import { databasePath } from '../src/db';
import { ADMIN, ADMIN_TOKEN, bearer, createTestApp, enrol } from './helpers';
import type { TestContext } from './helpers';

// Wrap the real timingSafeEqual in a spy so the tests can see the constant-time path is used.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const UNAUTHORIZED = { error: 'unauthorized' };

describe('token helpers', () => {
  it('generates spk_ + base64url(32 bytes) tokens', () => {
    const a = generateEnrolmentToken();
    const b = generateEnrolmentToken();
    expect(a).toMatch(/^spk_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a.slice(4), 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(isEnrolmentTokenFormat(a)).toBe(true);
    expect(isEnrolmentTokenFormat(`${a}x`)).toBe(false);
    expect(isEnrolmentTokenFormat(ADMIN_TOKEN)).toBe(false);
  });

  it('hashes tokens to SHA-256 hex', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('parses bearer headers strictly', () => {
    expect(parseBearer('Bearer abc')).toBe('abc');
    expect(parseBearer('bearer   abc  ')).toBe('abc');
    expect(parseBearer('Basic abc')).toBeNull();
    expect(parseBearer('Bearer')).toBeNull();
    expect(parseBearer('Bearer a b')).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer(['Bearer abc'])).toBeNull();
  });

  it('compares admin tokens in constant time over equal-length SHA-256 digests', () => {
    const verify = createAdminTokenVerifier(ADMIN_TOKEN);
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    expect(verify(ADMIN_TOKEN)).toBe(true);
    expect(verify('short')).toBe(false); // different length: no throw, no early exit
    expect(verify(`${ADMIN_TOKEN}-longer`)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(3);
    for (const [a, b] of spy.mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });
});

describe('authentication', () => {
  let t: TestContext;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const adminGet = (headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url: '/api/v1/admin/participants', headers });
  const meGet = (headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url: '/api/v1/me', headers });

  it('accepts the admin token on admin routes via the timing-safe path', async () => {
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    expect((await adminGet(ADMIN)).statusCode).toBe(200);
    expect((await adminGet(bearer('wrong'))).statusCode).toBe(401);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('returns the same 401 for missing, malformed and invalid credentials', async () => {
    const responses = await Promise.all([
      adminGet(),
      adminGet({ authorization: `Basic ${ADMIN_TOKEN}` }),
      adminGet({ authorization: `Bearer ${ADMIN_TOKEN}x` }),
      meGet(),
      meGet(bearer('spk_not-a-real-token')),
      meGet(bearer(generateEnrolmentToken())), // well-formed but unknown
    ]);
    for (const res of responses) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED);
      expect(res.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it('keeps admin and enrolment tokens separate', async () => {
    const { token } = await enrol(t.app, 'SP-001');
    expect((await meGet(bearer(token))).statusCode).toBe(200);
    expect((await meGet(ADMIN)).statusCode).toBe(401);
    expect((await adminGet(bearer(token))).statusCode).toBe(401);
    const exportRes = await t.app.inject({ method: 'GET', url: '/api/v1/export', headers: bearer(token) });
    expect(exportRes.statusCode).toBe(401);
    const listRes = await t.app.inject({ method: 'GET', url: '/api/v1/sessions', headers: bearer(token) });
    expect(listRes.statusCode).toBe(401);
    const uploadRes = await t.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      payload: '[]',
    });
    expect(uploadRes.statusCode).toBe(401);
  });

  it('rejects revoked tokens with the uniform 401', async () => {
    const { id, token } = await enrol(t.app, 'SP-002');
    const other = await enrol(t.app, 'SP-002', 'second device');
    const revoke = await t.app.inject({ method: 'DELETE', url: `/api/v1/admin/enrolments/${id}`, headers: ADMIN });
    expect(revoke.statusCode).toBe(204);
    const res = await meGet(bearer(token));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(UNAUTHORIZED);
    // Other enrolments of the same participant keep working.
    expect((await meGet(bearer(other.token))).statusCode).toBe(200);
    // Revoking twice is fine; unknown ids are 404.
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/admin/enrolments/${id}`, headers: ADMIN })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/v1/admin/enrolments/nope', headers: ADMIN })).statusCode).toBe(404);
  });

  it('stores only the SHA-256 of enrolment tokens and never returns them again', async () => {
    const { id, token } = await enrol(t.app, 'SP-003', 'study iPad');
    expect(token).toMatch(/^spk_[A-Za-z0-9_-]{43}$/);

    const list = await t.app.inject({ method: 'GET', url: '/api/v1/admin/enrolments', headers: ADMIN });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain(hashToken(token));
    const [item] = list.json().items;
    expect(item).toEqual({
      id,
      participantCode: 'SP-003',
      label: 'study iPad',
      createdAt: t.clock.now,
      lastUsedAt: null,
      revokedAt: null,
      active: true,
    });

    const db = new DatabaseSync(databasePath(t.dataDir));
    try {
      expect(db.prepare('SELECT token_hash FROM enrolments WHERE id = ?').get(id)).toEqual({ token_hash: hashToken(token) });
    } finally {
      db.close();
    }
    const files = [databasePath(t.dataDir), `${databasePath(t.dataDir)}-wal`];
    for (const file of files) {
      let bytes = '';
      try {
        bytes = readFileSync(file, 'latin1');
      } catch {
        continue; // the WAL may have been checkpointed away
      }
      expect(bytes).not.toContain(token.slice(4));
    }
  });

  it('records when an enrolment was last used', async () => {
    const { token } = await enrol(t.app, 'SP-004');
    t.clock.now += 60_000;
    await meGet(bearer(token));
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/admin/enrolments', headers: ADMIN });
    expect(list.json().items[0].lastUsedAt).toBe(t.clock.now);
  });
});
