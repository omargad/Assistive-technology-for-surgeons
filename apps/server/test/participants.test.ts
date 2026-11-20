import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, bundleJson, createTestApp, enrol, simSession, upload } from './helpers';
import type { TestContext } from './helpers';

describe('admin participants and enrolments', () => {
  let t: TestContext;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const post = (url: string, payload: unknown) =>
    t.app.inject({ method: 'POST', url: `/api/v1/admin/${url}`, headers: ADMIN, payload: payload as object });

  it('creates (201) then updates (200) a participant', async () => {
    const created = await post('participants', { code: 'SP-010', profile: { trainingLevel: 'resident', birthYear: 1996 } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      code: 'SP-010',
      profile: { code: 'SP-010', trainingLevel: 'resident', birthYear: 1996 },
      createdAt: t.clock.now,
      withdrawn: false,
      withdrawnAt: null,
    });
    // The code in the body wins over any code inside the profile (codes are immutable).
    const updated = await post('participants', { code: 'SP-010', profile: { code: 'OTHER', trainingLevel: 'registrar' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().profile).toEqual({ code: 'SP-010', trainingLevel: 'registrar' });
    // Without a profile, an existing participant is left as is.
    const unchanged = await post('participants', { code: 'SP-010' });
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json().profile).toEqual({ code: 'SP-010', trainingLevel: 'registrar' });
  });

  it('rejects identifying or malformed participant codes and invalid profiles', async () => {
    for (const code of ['jane.doe@hospital.org', 'jane-at-hospital-org', 'x', '-leading-dash', 'has space', 'a'.repeat(33)]) {
      const res = await post('participants', { code });
      expect(res.statusCode, code).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid request', details: [expect.stringMatching(/^code: /)] });
    }
    const badProfile = await post('participants', { code: 'SP-011', profile: { birthYear: 1800 } });
    expect(badProfile.statusCode).toBe(400);
    expect(badProfile.json()).toMatchObject({ error: 'invalid profile', details: [expect.stringMatching(/^profile\.birthYear/)] });
    const noBody = await t.app.inject({ method: 'POST', url: '/api/v1/admin/participants', headers: ADMIN });
    expect(noBody.statusCode).toBe(400);
    const badEnrolment = await post('enrolments', { participantCode: 'someone@example.com' });
    expect(badEnrolment.statusCode).toBe(400);
  });

  it('lists participants with session counts, enrolment counts and the withdrawn flag', async () => {
    const { token } = await enrol(t.app, 'SP-020', 'phone');
    const second = await enrol(t.app, 'SP-020', 'tablet');
    await t.app.inject({ method: 'DELETE', url: `/api/v1/admin/enrolments/${second.id}`, headers: ADMIN });
    await post('participants', { code: 'SP-021' });
    t.clock.now += 1000;
    await upload(t.app, token, bundleJson([simSession('SP-020', 1), simSession('SP-020', 2)]));

    const res = await t.app.inject({ method: 'GET', url: '/api/v1/admin/participants', headers: ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      {
        code: 'SP-020',
        profile: { code: 'SP-020' },
        createdAt: t.clock.now - 1000,
        withdrawnAt: null,
        withdrawn: false,
        sessionCount: 2,
        enrolmentCount: 2,
        activeEnrolmentCount: 1,
        lastUploadAt: t.clock.now,
      },
      {
        code: 'SP-021',
        profile: { code: 'SP-021' },
        createdAt: t.clock.now - 1000,
        withdrawnAt: null,
        withdrawn: false,
        sessionCount: 0,
        enrolmentCount: 0,
        activeEnrolmentCount: 0,
        lastUploadAt: null,
      },
    ]);
  });

  it('returns the enrolment token once, with the participant created if missing', async () => {
    const res = await post('enrolments', { participantCode: 'SP-030', label: 'ward iPad' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String),
      token: expect.stringMatching(/^spk_[A-Za-z0-9_-]{43}$/),
      participantCode: 'SP-030',
      label: 'ward iPad',
      createdAt: t.clock.now,
    });
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/admin/participants', headers: ADMIN });
    expect(list.json().items.map((p: { code: string }) => p.code)).toEqual(['SP-030']);
  });

  it('rejects prototype-poisoning JSON bodies', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/participants',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      payload: '{"code":"SP-040","__proto__":{"admin":true}}',
    });
    expect(res.statusCode).toBe(400);
  });
});
